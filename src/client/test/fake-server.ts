import {
  API_VERSION,
  API_VERSION_HEADER,
  type ApiErrorResponse,
  type InvalidRequestReason,
  type MutateResponse,
  type SyncResponse,
  syncRequestSchema,
} from "@shared/api";
import {
  isScheduleConsistent,
  isStartConsistent,
  type Project,
  type SyncRow,
  sameChecklist,
  type Task,
} from "@shared/model";
import { mutationBatchSchema, type ParsedMutationBatch } from "@shared/mutations";

/**
 * 画面側のテスト用の偽のサーバー。src/shared の約束（と src/worker の実装）どおりに、
 * /api/sync と /api/mutate を fetch の形で受ける。D1 の代わりにメモリに持つ。
 * - 行を書き換えるたびに seq を振る。差分は seq の順に pageSize 行ずつ返す
 * - 同じ ID のまとまりの再送は、書き込まずに対象の行の今の内容を返す
 * - reset は baseCursor で決める（物理削除より古い・サーバーより新しい）。cursor がサーバーより新しいときも
 * - X-Api-Version が違えば 409、authorized が false なら 401
 * 失敗を起こすには fail()、応答を止めるには hold() を使う
 */

type Path = "/api/sync" | "/api/mutate";

/** 次の呼び出しで起こす失敗 */
export type InjectedFailure =
  /** 届かない（fetch が TypeError で失敗する）。サーバーは何もしない */
  | "network"
  /** サーバーは処理するが、応答が届かない（結果が分からないまま再送する場面） */
  | "drop-response"
  /** そのステータスで応答する（本文はそれらしいもの） */
  | number;

export type RecordedRequest = { path: Path; body: unknown; headers: Headers };

type Snapshot = {
  seq: number;
  purgedThroughSeq: number;
  tasks: Map<string, Task>;
  projects: Map<string, Project>;
  applied: Map<string, ParsedMutationBatch>;
};

class Rejection extends Error {
  constructor(readonly reason: InvalidRequestReason) {
    super(reason);
  }
}

function abortion(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export class FakeServer {
  seq = 0;
  purgedThroughSeq = 0;
  readonly tasks = new Map<string, Task>();
  readonly projects = new Map<string, Project>();
  readonly applied = new Map<string, ParsedMutationBatch>();
  /** 受けた要求（届かなかったものも含む）。送った順 */
  readonly requests: RecordedRequest[] = [];
  /** 差分の1ページの行数 */
  pageSize = 500;
  /** false にすると、どの要求も 401 */
  authorized = true;
  /** サーバーの版（画面の X-Api-Version と違えば 409） */
  apiVersion = API_VERSION;
  /** 現在時刻（createdAt・updatedAt に入れる） */
  now: () => Date = () => new Date();

  readonly #failures: { path: Path; failure: InjectedFailure }[] = [];
  readonly #holds = new Map<Path, { promise: Promise<void>; release: () => void }>();

  /** 画面のストアに渡す fetch */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, "http://localhost").pathname as Path;
    const headers = new Headers(init?.headers);
    let body: unknown;
    try {
      body = JSON.parse(String(init?.body ?? ""));
    } catch {
      body = undefined;
    }
    this.requests.push({ path, body, headers });

    // 止めているあいだに打ち切られたら（タイムアウト）、本物の fetch と同じく AbortError で失敗する
    const hold = this.#holds.get(path);
    if (hold) await Promise.race([hold.promise, abortion(init?.signal)]);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");

    const index = this.#failures.findIndex((entry) => entry.path === path);
    const failure = index >= 0 ? this.#failures.splice(index, 1)[0]?.failure : undefined;
    if (failure === "network") throw new TypeError("Failed to fetch");
    if (typeof failure === "number") return json(this.#errorBody(failure), failure);

    const response = this.#handle(path, headers, body);
    if (failure === "drop-response") throw new TypeError("Failed to fetch");
    return response;
  };

  /** path への次の呼び出しで、failure を起こす（積んだ順に1回ずつ） */
  fail(path: Path, ...failures: InjectedFailure[]): void {
    for (const failure of failures) this.#failures.push({ path, failure });
  }

  /** path への呼び出しを、戻り値の release() を呼ぶまで止める（要求は記録される） */
  hold(path: Path): () => void {
    let release = () => {};
    const promise = new Promise<void>((resolve) => {
      release = () => {
        this.#holds.delete(path);
        resolve();
      };
    });
    this.#holds.set(path, { promise, release });
    return release;
  }

  requestsTo(path: Path): RecordedRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  // --- サーバー側での書き込み（ほかのタブ・日付の切り替えの代わり） -------------------------

  /** タスクを書く（作るか、項目を変える）。新しい seq を振る */
  putTask(task: Partial<Task> & { id: string }): Task {
    const timestamp = this.now().toISOString();
    const current = this.tasks.get(task.id);
    const row: Task = {
      title: "タスク",
      memo: "",
      bucket: "inbox",
      scheduledOn: null,
      deadlineOn: null,
      projectId: null,
      rank: "a0",
      arrivedOn: null,
      checklist: [],
      completedAt: null,
      startedAt: null,
      createdAt: timestamp,
      deletedAt: null,
      ...current,
      ...task,
      updatedAt: timestamp,
      seq: ++this.seq,
    };
    this.tasks.set(row.id, row);
    return row;
  }

  putProject(project: Partial<Project> & { id: string }): Project {
    const timestamp = this.now().toISOString();
    const current = this.projects.get(project.id);
    const row: Project = {
      name: "プロジェクト",
      color: null,
      archivedAt: null,
      createdAt: timestamp,
      deletedAt: null,
      ...current,
      ...project,
      updatedAt: timestamp,
      seq: ++this.seq,
    };
    this.projects.set(row.id, row);
    return row;
  }

  /** deletedBefore より前に削除された行を物理削除する（画面には知らせない） */
  purgeDeleted(deletedBefore: string): void {
    for (const table of [this.tasks, this.projects] as Map<string, Task | Project>[]) {
      for (const [id, row] of table) {
        if (row.deletedAt !== null && row.deletedAt < deletedBefore) {
          this.purgedThroughSeq = Math.max(this.purgedThroughSeq, row.seq);
          table.delete(id);
        }
      }
    }
  }

  /** 今の状態を覚える（Time Travel で巻き戻すときに使う） */
  snapshot(): Snapshot {
    return {
      seq: this.seq,
      purgedThroughSeq: this.purgedThroughSeq,
      tasks: new Map(this.tasks),
      projects: new Map(this.projects),
      applied: new Map(this.applied),
    };
  }

  /** 覚えた状態に巻き戻す（Time Travel） */
  restore(snapshot: Snapshot): void {
    this.seq = snapshot.seq;
    this.purgedThroughSeq = snapshot.purgedThroughSeq;
    for (const [target, source] of [
      [this.tasks, snapshot.tasks],
      [this.projects, snapshot.projects],
      [this.applied, snapshot.applied],
    ] as [Map<string, unknown>, Map<string, unknown>][]) {
      target.clear();
      for (const [key, value] of source) target.set(key, value);
    }
  }

  // --- 内部 -------------------------------------------------------------------------------

  #errorBody(status: number): ApiErrorResponse {
    if (status === 401) return { error: "unauthorized" };
    if (status === 409) return { error: "api_version_mismatch", apiVersion: this.apiVersion };
    if (status === 400) return { error: "invalid_request", reason: "schema" };
    return { error: "internal_error" };
  }

  #handle(path: Path, headers: Headers, body: unknown): Response {
    if (!this.authorized) return json({ error: "unauthorized" }, 401);
    if (!/^application\/json\s*(;|$)/i.test(headers.get("Content-Type") ?? "")) {
      return json({ error: "unsupported_media_type" }, 415);
    }
    if (headers.get(API_VERSION_HEADER) !== String(this.apiVersion)) {
      return json({ error: "api_version_mismatch", apiVersion: this.apiVersion }, 409);
    }
    return path === "/api/sync" ? this.#sync(body) : this.#mutate(body);
  }

  #sync(body: unknown): Response {
    const parsed = syncRequestSchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_request", reason: "schema" }, 400);
    const { cursor, baseCursor } = parsed.data;
    const baseTooOld = baseCursor > 0 && baseCursor < this.purgedThroughSeq;
    if (baseTooOld || baseCursor > this.seq || cursor > this.seq) {
      return json({ reset: true } satisfies SyncResponse);
    }
    const all = this.#rows().filter((entry) => entry.row.seq > cursor && entry.row.seq <= this.seq);
    const hasMore = all.length > this.pageSize;
    const rows = all.slice(0, this.pageSize);
    const nextCursor = hasMore ? (rows.at(-1)?.row.seq ?? cursor) : this.seq;
    return json({ reset: false, rows, nextCursor, hasMore } satisfies SyncResponse);
  }

  #mutate(body: unknown): Response {
    const parsed = mutationBatchSchema.safeParse(body);
    if (!parsed.success) return json({ error: "invalid_request", reason: "schema" }, 400);
    const batch = parsed.data;
    if (this.applied.has(batch.id)) {
      return json({ rows: this.#targetRows(batch) } satisfies MutateResponse);
    }
    // 検証してから書く（全部成功か全部失敗）
    const before = this.snapshot();
    try {
      const written = new Map<string, SyncRow>();
      for (const mutation of batch.mutations) {
        const entry = this.#apply(mutation);
        written.set(`${entry.kind}:${entry.row.id}`, entry);
      }
      this.applied.set(batch.id, batch);
      const rows = Array.from(written.values(), (entry) =>
        entry.kind === "task"
          ? { kind: "task" as const, row: this.tasks.get(entry.row.id) as Task }
          : { kind: "project" as const, row: this.projects.get(entry.row.id) as Project },
      ).sort((a, b) => a.row.seq - b.row.seq);
      return json({ rows } satisfies MutateResponse);
    } catch (error) {
      this.restore(before);
      if (error instanceof Rejection) {
        return json({ error: "invalid_request", reason: error.reason }, 400);
      }
      throw error;
    }
  }

  #apply(mutation: ParsedMutationBatch["mutations"][number]): SyncRow {
    switch (mutation.type) {
      case "task.create": {
        if (this.tasks.has(mutation.task.id)) throw new Rejection("task_exists");
        if (!isScheduleConsistent(mutation.task)) throw new Rejection("schedule_mismatch");
        this.#assertAttachable(mutation.task.projectId);
        return { kind: "task", row: this.putTask({ ...mutation.task }) };
      }
      case "task.update": {
        const current = this.tasks.get(mutation.id);
        if (!current) throw new Rejection("task_not_found");
        if (mutation.baseChecklist && !sameChecklist(current.checklist, mutation.baseChecklist)) {
          throw new Rejection("checklist_conflict");
        }
        const next = { ...current, ...mutation.changes };
        if (!isScheduleConsistent(next)) throw new Rejection("schedule_mismatch");
        if (!isStartConsistent(next)) throw new Rejection("started_outside_today");
        if (next.projectId !== current.projectId) this.#assertAttachable(next.projectId);
        return { kind: "task", row: this.putTask({ ...mutation.changes, id: mutation.id }) };
      }
      case "project.create": {
        if (this.projects.has(mutation.project.id)) throw new Rejection("project_exists");
        return { kind: "project", row: this.putProject({ ...mutation.project }) };
      }
      case "project.update": {
        if (!this.projects.has(mutation.id)) throw new Rejection("project_not_found");
        if (mutation.changes.archivedAt) {
          for (const task of this.tasks.values()) {
            if (
              task.projectId === mutation.id &&
              task.completedAt === null &&
              task.deletedAt === null
            ) {
              throw new Rejection("project_has_open_tasks");
            }
          }
        }
        return { kind: "project", row: this.putProject({ ...mutation.changes, id: mutation.id }) };
      }
    }
  }

  #assertAttachable(projectId: string | null): void {
    if (projectId === null) return;
    const project = this.projects.get(projectId);
    if (!project) throw new Rejection("project_not_found");
    if (project.deletedAt !== null) throw new Rejection("project_deleted");
    if (project.archivedAt !== null) throw new Rejection("project_archived");
  }

  #rows(): SyncRow[] {
    return [
      ...Array.from(this.tasks.values(), (row) => ({ kind: "task" as const, row })),
      ...Array.from(this.projects.values(), (row) => ({ kind: "project" as const, row })),
    ].sort((a, b) => a.row.seq - b.row.seq);
  }

  /** 再送のときに返す、まとまりの対象の行の今の内容 */
  #targetRows(batch: ParsedMutationBatch): SyncRow[] {
    const rows: SyncRow[] = [];
    for (const mutation of batch.mutations) {
      if (mutation.type === "task.create" || mutation.type === "task.update") {
        const id = mutation.type === "task.create" ? mutation.task.id : mutation.id;
        const row = this.tasks.get(id);
        if (row && !rows.some((entry) => entry.row.id === id)) rows.push({ kind: "task", row });
      } else {
        const id = mutation.type === "project.create" ? mutation.project.id : mutation.id;
        const row = this.projects.get(id);
        if (row && !rows.some((entry) => entry.row.id === id)) rows.push({ kind: "project", row });
      }
    }
    return rows.sort((a, b) => a.row.seq - b.row.seq);
  }
}
