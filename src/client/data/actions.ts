import type { Bucket, ChecklistItem, Project, Task } from "@shared/model";
import type { Mutation } from "@shared/mutations";
import { arrivalRanks, rankBetween, ranksBetween } from "@shared/rank";
import type { LogicalDay } from "./logical-day";
import { targetOf } from "./overlay";
import type { OperationKind, Replica } from "./replica";
import type { TaskRow } from "./rows";
import type { UndoStack } from "./undo";

/**
 * 画面から呼ぶ操作の入口。どれも、画面の今の表示（確定データ＋送信中の操作）をもとに操作のまとまりを作り、
 * すぐ表示に重ねて、送信の列に積む。業務のルール（どの置き場に入れるか、並び順キーの付け方）はここで決める。
 * オフラインのときは受け付けずに止め、「offline-blocked」を知らせる
 */

export type OperationFailure =
  /** オフラインなので止めた */
  | "offline"
  /** ログインが切れた・版が古いので、もう送れない */
  | "stopped"
  /** 変えるものがなかった（すでに完了している、同じ置き場にある、など） */
  | "noop"
  /** 空のタイトルなど、受け付けられない内容 */
  | "invalid"
  /** 未完了のタスクが残っているプロジェクトはアーカイブできない */
  | "has-open-tasks"
  /** 1回の操作の対象が 500（サーバーの上限）を超えた。分けずに断る */
  | "too-many"
  /** 元に戻す操作がない */
  | "nothing-to-undo";

export type OperationResult =
  /** ids は操作の対象になった行（作った行を含む）の id。操作した順 */
  | { ok: true; operationId: string; ids: readonly string[] }
  | { ok: false; reason: OperationFailure };

export type PerformOptions = {
  /** 元に戻すの対象にするか（既定は true） */
  undoable?: boolean;
};

export type Perform = (
  kind: OperationKind,
  mutations: Mutation[],
  options?: PerformOptions,
) => OperationResult;

export type TaskChanges = Extract<Mutation, { type: "task.update" }>["changes"];
export type ProjectChanges = Extract<Mutation, { type: "project.update" }>["changes"];

/** 追加の行き先（予定への追加は Core Flows にない） */
export type AddTaskInput = {
  title: string;
  memo?: string;
  bucket: Exclude<Bucket, "scheduled">;
  projectId?: string | null;
};

/** 置き場の移動先。予定は日付と一緒に指定する */
export type Destination =
  | { bucket: Exclude<Bucket, "scheduled"> }
  | { bucket: "scheduled"; on: string };

type ActionsOptions = {
  replica: Replica;
  day: LogicalDay;
  undoStack: UndoStack;
  now: () => Date;
  newId: () => string;
  perform: Perform;
};

const OPEN_PARTITIONS = ["inbox", "today", "scheduled", "later"] as const;

function isNonBlank(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function sameChecklist(a: readonly ChecklistItem[], b: readonly ChecklistItem[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameValue(key: string, a: unknown, b: unknown): boolean {
  if (key === "checklist") {
    return sameChecklist(a as ChecklistItem[], b as ChecklistItem[]);
  }
  return a === b;
}

/**
 * 変える項目だけを残し、bucket と scheduledOn の対応を満たすようにそろえる。
 * scheduled にするときは scheduledOn も、scheduled から外すときは scheduledOn: null も、同じ changes に入れる。
 * 受け付けられない内容なら null
 */
export function normalizeTaskChanges(current: Task, changes: TaskChanges): TaskChanges | null {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) continue;
    if (key === "title" && !isNonBlank(value)) return null;
    if (!sameValue(key, current[key as keyof Task], value)) next[key] = value;
  }
  const bucket = (next.bucket as Bucket | undefined) ?? current.bucket;
  const scheduledOn =
    "scheduledOn" in next ? (next.scheduledOn as string | null) : current.scheduledOn;
  if (bucket === "scheduled") {
    if (scheduledOn === null) return null;
    if ("bucket" in next) next.scheduledOn = scheduledOn;
  } else if (scheduledOn !== null) {
    if ("scheduledOn" in next) return null;
    next.scheduledOn = null;
  }
  return next as TaskChanges;
}

export class TaskActions {
  readonly #replica: Replica;
  readonly #day: LogicalDay;
  readonly #undoStack: UndoStack;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #perform: Perform;

  constructor({ replica, day, undoStack, now, newId, perform }: ActionsOptions) {
    this.#replica = replica;
    this.#day = day;
    this.#undoStack = undoStack;
    this.#now = now;
    this.#newId = newId;
    this.#perform = perform;
  }

  // --- 並び順キー -------------------------------------------------------------------------

  /**
   * 置き場の一番下に入れる n 個のキー（上から順）。
   * その置き場にある完了済み・削除済みの行よりも後ろにする（元に戻したときに、元の位置に戻るように）
   */
  bottomRanks(bucket: Bucket, n = 1): string[] {
    const ranks = this.#ranksIn(bucket);
    const last = ranks.reduce<string | null>(
      (max, rank) => (max === null || rank > max ? rank : max),
      null,
    );
    return ranksBetween(last, null, n);
  }

  /** 置き場の一番上に入れる n 個のキー（上から順） */
  topRanks(bucket: Bucket, n = 1): string[] {
    const ranks = this.#ranksIn(bucket);
    const first = ranks.reduce<string | null>(
      (min, rank) => (min === null || rank < min ? rank : min),
      null,
    );
    return ranksBetween(null, first, n);
  }

  /** 2つの行のあいだに入れるキー（並べ替え用。null は端） */
  rankBetween(above: TaskRow | null, below: TaskRow | null): string {
    return rankBetween(above?.peek().rank ?? null, below?.peek().rank ?? null);
  }

  /**
   * 日付の到来や締切で今日に入れる n 個のキー。位置は「今日来たタスクの後ろ、それ以外の今日のタスクの前」
   * （サーバーの日付の切り替えと同じ決まり）
   */
  arrivalRanks(n = 1): string[] {
    const todayTasks = Array.from(this.#replica.taskIndex.rows("today"), (row) => row.peek());
    return arrivalRanks(todayTasks, this.#day.today, n);
  }

  // --- タスク -----------------------------------------------------------------------------

  /** 追加。置き場の一番下に入る。ids[0] が作ったタスクの id */
  addTask({ title, memo = "", bucket, projectId = null }: AddTaskInput): OperationResult {
    if (!isNonBlank(title)) return { ok: false, reason: "invalid" };
    const [rank] = this.bottomRanks(bucket);
    if (rank === undefined) return { ok: false, reason: "invalid" };
    return this.#perform("task.add", [
      {
        type: "task.create",
        task: { id: this.#newId(), title, memo, bucket, projectId, rank },
      },
    ]);
  }

  /** 1つのタスクの項目を変える（タイトル、メモ、締切、プロジェクト、チェックリストなど） */
  updateTask(id: string, changes: TaskChanges, options?: PerformOptions): OperationResult {
    return this.updateTasks([{ id, changes }], options);
  }

  /** 複数のタスクの項目を、1つの操作として変える（まとめて戻る） */
  updateTasks(
    updates: readonly { id: string; changes: TaskChanges }[],
    options?: PerformOptions,
  ): OperationResult {
    return this.#updateMany("task.update", updates, options);
  }

  /** 完了。bucket と rank は変えない（直後に元に戻すと、元の場所・元の位置に戻る） */
  completeTasks(ids: readonly string[]): OperationResult {
    const completedAt = this.#now().toISOString();
    const updates = this.#rows(ids)
      .filter((task) => task.completedAt === null && task.deletedAt === null)
      .map((task) => ({ id: task.id, changes: { completedAt } }));
    return this.#updateMany("task.complete", updates);
  }

  /** あとから完了を外す（「完了 N件」や完了ログから）。今日の一番下に戻る */
  uncompleteTasks(ids: readonly string[]): OperationResult {
    const targets = this.#rows(ids).filter(
      (task) => task.completedAt !== null && task.deletedAt === null,
    );
    const ranks = this.bottomRanks("today", targets.length);
    const updates = targets.map((task, i) => ({
      id: task.id,
      changes: { completedAt: null, bucket: "today" as const, rank: ranks[i] },
    }));
    return this.#updateMany("task.uncomplete", updates);
  }

  /**
   * 置き場を移す（未完了のタスクだけ）。移した先の一番下に、渡した順で並ぶ。
   * 予定へ移すときに、日付が今日か過去なら今日に入れる
   */
  moveTasks(ids: readonly string[], destination: Destination): OperationResult {
    const to: Destination =
      destination.bucket === "scheduled" && destination.on <= this.#day.today
        ? { bucket: "today" }
        : destination;
    const scheduledOn = to.bucket === "scheduled" ? to.on : null;
    const targets = this.#rows(ids).filter(
      (task) =>
        task.completedAt === null &&
        task.deletedAt === null &&
        (task.bucket !== to.bucket || task.scheduledOn !== scheduledOn),
    );
    const ranks = this.bottomRanks(to.bucket, targets.length);
    const updates = targets.map((task, i) => ({
      id: task.id,
      changes: { bucket: to.bucket, scheduledOn, rank: ranks[i] },
    }));
    return this.#updateMany("task.move", updates);
  }

  /**
   * 締切を付ける・外す（null）。未完了の予定・あとでのタスクに今日以前の締切を付けたら、同じ操作で
   * 今日の到着の位置（今日来たタスクの後ろ、それ以外の今日のタスクの前）へ移し、到着の印（arrivedOn）を付ける。
   * 受信箱（振り分けの途中）と、すでに今日にあるタスクは動かさない。
   * 締切のあるタスクを moveTasks で予定・あとでへ移したときは、今日へ引き戻さない（あえて送った場合があるため）
   */
  setDeadline(ids: readonly string[], deadlineOn: string | null): OperationResult {
    const today = this.#day.today;
    const arrives = (task: Task) =>
      deadlineOn !== null &&
      deadlineOn <= today &&
      task.completedAt === null &&
      (task.bucket === "scheduled" || task.bucket === "later");
    const targets = this.#rows(ids).filter(
      (task) => task.deletedAt === null && task.deadlineOn !== deadlineOn,
    );
    const ranks = this.arrivalRanks(targets.filter(arrives).length);
    let next = 0;
    const updates = targets.map((task) => {
      if (!arrives(task)) return { id: task.id, changes: { deadlineOn } };
      const rank = ranks[next++];
      return {
        id: task.id,
        changes: {
          deadlineOn,
          bucket: "today" as const,
          scheduledOn: null,
          rank,
          arrivedOn: today,
        },
      };
    });
    return this.#updateMany("task.deadline", updates);
  }

  /** 削除（論理削除）。確認は画面が出さない。元に戻すで戻る */
  deleteTasks(ids: readonly string[]): OperationResult {
    const deletedAt = this.#now().toISOString();
    const updates = this.#rows(ids)
      .filter((task) => task.deletedAt === null)
      .map((task) => ({ id: task.id, changes: { deletedAt } }));
    return this.#updateMany("task.delete", updates);
  }

  // --- プロジェクト -----------------------------------------------------------------------

  /** プロジェクトを作る。ids[0] が作ったプロジェクトの id */
  createProject(name: string): OperationResult {
    if (!isNonBlank(name)) return { ok: false, reason: "invalid" };
    return this.#perform("project.create", [
      { type: "project.create", project: { id: this.#newId(), name } },
    ]);
  }

  /** 名前の変更・アーカイブ。未完了のタスクが残っているとアーカイブできない */
  updateProject(id: string, changes: ProjectChanges): OperationResult {
    const current = this.#replica.project(id)?.peek();
    if (!current || current.deletedAt !== null) return { ok: false, reason: "invalid" };
    if (changes.name !== undefined && !isNonBlank(changes.name)) {
      return { ok: false, reason: "invalid" };
    }
    if (changes.archivedAt && this.openTaskCountOfProject(id) > 0) {
      return { ok: false, reason: "has-open-tasks" };
    }
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value !== undefined && current[key as keyof Project] !== value) next[key] = value;
    }
    if (Object.keys(next).length === 0) return { ok: false, reason: "noop" };
    return this.#perform("project.update", [{ type: "project.update", id, changes: next }]);
  }

  /** そのプロジェクトの未完了のタスクの数（表示中の内容で数える） */
  openTaskCountOfProject(projectId: string): number {
    let count = 0;
    for (const partition of OPEN_PARTITIONS) {
      for (const row of this.#replica.taskIndex.rows(partition)) {
        if (row.peek().projectId === projectId) count++;
      }
    }
    return count;
  }

  // --- 元に戻す ---------------------------------------------------------------------------

  /** 一番新しい操作を、逆向きの操作のまとまり1つで戻す */
  undo(): OperationResult {
    const entry = this.#undoStack.pop();
    if (!entry) return { ok: false, reason: "nothing-to-undo" };
    // 戻す先の行がもうない（削除から 30 日たって捨てた）操作は送らない
    const mutations = entry.inverse(this.#now().toISOString()).filter((mutation) => {
      const target = targetOf(mutation);
      return target.kind === "task"
        ? this.#replica.task(target.id) !== undefined
        : this.#replica.project(target.id) !== undefined;
    });
    const result = this.#perform("undo", mutations, { undoable: false });
    if (result.ok) {
      this.#undoStack.undoing(result.operationId, entry);
    } else if (result.reason !== "noop") {
      // オフラインなどで止めたときは、戻す対象のまま残す
      this.#undoStack.push(entry);
    }
    return result;
  }

  // --- 内部 -------------------------------------------------------------------------------

  #rows(ids: readonly string[]): Task[] {
    const rows: Task[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = this.#replica.task(id);
      if (row) rows.push(row.peek());
    }
    return rows;
  }

  #ranksIn(bucket: Bucket): string[] {
    const ranks: string[] = [];
    for (const row of this.#replica.taskIndex.rows(bucket)) ranks.push(row.peek().rank);
    for (const partition of ["completed", "deleted"] as const) {
      for (const row of this.#replica.taskIndex.rows(partition)) {
        const task = row.peek();
        if (task.bucket === bucket) ranks.push(task.rank);
      }
    }
    return ranks;
  }

  #updateMany(
    kind: OperationKind,
    updates: readonly { id: string; changes: TaskChanges }[],
    options?: PerformOptions,
  ): OperationResult {
    const mutations: Mutation[] = [];
    for (const { id, changes } of updates) {
      const current = this.#replica.task(id)?.peek();
      if (!current) continue;
      const normalized = normalizeTaskChanges(current, changes);
      if (normalized === null) return { ok: false, reason: "invalid" };
      if (Object.keys(normalized).length === 0) continue;
      mutations.push({ type: "task.update", id, changes: normalized });
    }
    return this.#perform(kind, mutations, options);
  }
}
