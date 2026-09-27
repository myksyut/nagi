import type { InvalidRequestReason } from "@shared/api";
import type { SyncRow } from "@shared/model";
import { MAX_MUTATIONS_PER_BATCH, type Mutation, mutationSchema } from "@shared/mutations";
import { makeObservable, observable, runInAction } from "mobx";
import { type OperationResult, type PerformOptions, TaskActions } from "./actions";
import { ApiClient, type ApiFailure, isRetryable } from "./api-client";
import { TaskLists } from "./lists";
import { createMemoryLocalDb, type LocalDb, openLocalDb } from "./local-db";
import { LogicalDay } from "./logical-day";
import { describeDiscarded, type NoticeListener, Notices } from "./notices";
import { targetOf } from "./overlay";
import { type OperationKind, type PendingBatch, Replica } from "./replica";
import type { ProjectRow, TaskRow } from "./rows";
import { SendQueue } from "./send-queue";
import { SyncClient } from "./sync-client";
import { buildInverse, UndoStack } from "./undo";
import { uuidv7 } from "./uuid";

/**
 * 画面側のデータ層のまとめ役。画面はこのストアのメモリ上のデータだけを読み書きする。
 * - 起動：手元の控え（IndexedDB）を読んで描ける状態にしてから、差分を取る
 * - 差分を取るきっかけ：起動、タブが前に出たとき、フォーカスが戻ったとき、オンラインに戻ったとき、午前4時
 * - 操作：actions の関数から。すぐ表示に重ね、送信の列で順に送る
 * - 知らせ：subscribe() で受け取る（保存の失敗、オフラインで止めた、401、409）
 */

/** 削除（論理削除）からこの日数たった行は、手元からも捨てる（サーバーはその時点で物理削除する） */
export const DELETED_ROW_TTL_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 送信と同期を止めた理由。ログインが切れた（401）か、画面の版が古い（409） */
export type StopReason = "unauthorized" | "version-mismatch";

export type AppStoreOptions = {
  /** API の呼び出しに使う fetch（テストで偽のサーバーに差し替える） */
  fetch?: typeof fetch;
  /** 現在時刻（テストで差し替える）。論理日付・完了や削除の時刻・ID の採番に使う */
  now?: () => Date;
  timeZone?: string;
  /** 手元の控えを開く（テストで名前や版を変えたり、保存しない代わりを渡したりする） */
  openLocalDb?: () => Promise<LocalDb>;
  /** きっかけのイベントを受ける window と document（既定はグローバル） */
  window?: Window;
  document?: Document;
};

export class AppStore {
  /** 手元の控えを読み終え、描ける状態になった */
  loaded = false;
  /** 起動してから、差分の取得を1回終えた */
  synced = false;
  /** オンラインか（navigator.onLine と online / offline のイベントから） */
  isOnline: boolean;
  /** 送信と同期を止めた理由（止まっていなければ null） */
  stoppedBy: StopReason | null = null;

  readonly replica = new Replica();
  readonly day: LogicalDay;
  readonly lists: TaskLists;
  readonly actions: TaskActions;
  readonly undoStack = new UndoStack();

  readonly #notices = new Notices();
  readonly #api: ApiClient;
  readonly #queue: SendQueue;
  readonly #sync: SyncClient;
  readonly #now: () => Date;
  readonly #openLocalDb: () => Promise<LocalDb>;
  readonly #window: Window | undefined;
  readonly #document: Document | undefined;
  #localDb: LocalDb = createMemoryLocalDb();
  #started: Promise<void> | null = null;
  #disposed = false;
  readonly #cleanups: (() => void)[] = [];

  constructor(options: AppStoreOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#api = new ApiClient({ fetch: options.fetch });
    this.#openLocalDb = options.openLocalDb ?? (() => openLocalDb());
    this.#window = options.window ?? globalThis.window;
    this.#document = options.document ?? globalThis.document;
    this.isOnline = this.#window?.navigator.onLine ?? true;

    this.day = new LogicalDay({
      now: this.#now,
      timeZone: options.timeZone,
      onChange: () => {
        this.#purgeExpired();
        void this.sync();
      },
    });
    this.lists = new TaskLists(this.replica, this.day);
    this.actions = new TaskActions({
      replica: this.replica,
      day: this.day,
      undoStack: this.undoStack,
      now: this.#now,
      newId: () => uuidv7(this.#now().getTime()),
      perform: (kind, mutations, performOptions) => this.#perform(kind, mutations, performOptions),
    });
    this.#queue = new SendQueue({
      replica: this.replica,
      api: this.#api,
      persist: (rows) => {
        this.#persist(rows);
        this.#sync.noteConfirmed(rows);
      },
      onConfirmed: (batch) => this.undoStack.confirmed(batch),
      onFailed: (error, discarded) => this.#onSendFailed(error, discarded),
    });
    this.#sync = new SyncClient({
      replica: this.replica,
      api: this.#api,
      localDb: () => this.#localDb,
      canSync: () => this.#isActive() && this.loaded && this.isOnline,
      isActive: () => this.#isActive(),
      onSynced: () => {
        // 起動して最初の同期のあとにも、30 日たった削除済みの行を捨てる（初回の全件取得で届いた分）
        if (!this.synced) this.#purgeExpired();
        runInAction(() => {
          this.synced = true;
        });
      },
      onFailed: (error) => this.#onSyncFailed(error),
    });

    makeObservable(this, {
      loaded: observable,
      synced: observable,
      isOnline: observable,
      stoppedBy: observable,
    });
  }

  // --- 読む -------------------------------------------------------------------------------

  /** 今日の論理日付（YYYY-MM-DD）。午前4時に変わる */
  get today(): string {
    return this.day.today;
  }

  /** 画面に出すタスク（削除済みも含む）。なければ undefined */
  task(id: string): TaskRow | undefined {
    return this.replica.task(id);
  }

  project(id: string): ProjectRow | undefined {
    return this.replica.project(id);
  }

  /** 元に戻せる操作があるか */
  get canUndo(): boolean {
    return this.undoStack.canUndo;
  }

  /** 送信中のまとまりの数（保存が済んでいないものがあるか） */
  get pendingCount(): number {
    return this.replica.pending.length;
  }

  /** 知らせを受け取る。戻り値を呼ぶとやめる */
  subscribe(listener: NoticeListener): () => void {
    return this.#notices.subscribe(listener);
  }

  // --- 動かす -----------------------------------------------------------------------------

  /** 手元の控えを読み、きっかけのイベントとタイマーをつなぎ、最初の差分を取る。何度呼んでも1回だけ */
  start(): Promise<void> {
    this.#started ??= this.#start();
    return this.#started;
  }

  /** 差分を取る（取得中なら、終わったあとにもう1回） */
  sync(): Promise<void> {
    return this.#sync.sync();
  }

  /** 送信の列が空になるまで待つ（テスト用） */
  idle(): Promise<void> {
    return this.#queue.idle();
  }

  dispose(): void {
    this.#disposed = true;
    for (const cleanup of this.#cleanups.splice(0)) cleanup();
    this.day.dispose();
    this.#queue.dispose();
    this.#localDb.close();
  }

  async #start(): Promise<void> {
    const localDb = await this.#openLocalDb();
    if (this.#disposed) {
      localDb.close();
      return;
    }
    this.#localDb = localDb;
    try {
      const snapshot = await localDb.load();
      const cutoff = this.#purgeCutoff();
      const alive = (row: { deletedAt: string | null }) =>
        row.deletedAt === null || row.deletedAt >= cutoff;
      const rows: SyncRow[] = [
        ...snapshot.tasks.filter(alive).map((row) => ({ kind: "task" as const, row })),
        ...snapshot.projects.filter(alive).map((row) => ({ kind: "project" as const, row })),
      ];
      this.replica.replaceConfirmed(rows);
      this.#sync.cursor = snapshot.cursor;
      void localDb.purgeDeleted(cutoff).catch((error) => console.error(error));
    } catch (error) {
      // 読めなければ、手元が空のときと同じくカーソル 0 から取る
      console.error("手元の控えを読めませんでした", error);
    }
    if (this.#disposed) return;
    runInAction(() => {
      this.loaded = true;
    });
    this.#listen();
    this.day.start();
    await this.sync();
  }

  #listen(): void {
    const win = this.#window;
    const doc = this.#document;
    // 読み込みのあいだに online / offline が変わっていたら、ここで追いつく
    runInAction(() => {
      this.isOnline = win?.navigator.onLine ?? this.isOnline;
    });
    const on = (target: EventTarget | undefined, type: string, handler: () => void) => {
      if (!target) return;
      target.addEventListener(type, handler);
      this.#cleanups.push(() => target.removeEventListener(type, handler));
    };
    const trigger = () => {
      // 眠っていたあいだに午前4時を過ぎていたら、ここで気づく（そのときは onChange が差分を取る）
      if (!this.day.refresh()) void this.sync();
    };
    on(doc, "visibilitychange", () => {
      if (doc?.visibilityState === "visible") trigger();
    });
    on(win, "focus", trigger);
    on(win, "online", () => {
      runInAction(() => {
        this.isOnline = true;
      });
      trigger();
    });
    on(win, "offline", () => {
      runInAction(() => {
        this.isOnline = false;
      });
    });
  }

  #isActive(): boolean {
    return !this.#disposed && this.stoppedBy === null;
  }

  // --- 操作 -------------------------------------------------------------------------------

  /**
   * 操作のまとまりを受け付ける。オフラインなら止めて知らせる。
   * 1回のユーザー操作は1つのまとまり（1リクエスト）で、サーバーは全部成功か全部失敗にする。
   * そのため、500（サーバーの上限）を超える操作は分けずに断る（画面側の上限は 7 で付ける）。
   * 受け付けたら、元に戻すための逆向きの操作を今の表示から作り、表示に重ねて、送信の列に積む
   */
  #perform(
    kind: OperationKind,
    mutations: Mutation[],
    options: PerformOptions = {},
  ): OperationResult {
    if (!this.#isActive()) return { ok: false, reason: "stopped" };
    if (!this.isOnline) {
      this.#notices.emit({
        type: "offline-blocked",
        operation: kind,
        autosave: options.autosave === true,
      });
      return { ok: false, reason: "offline" };
    }
    if (mutations.length === 0) return { ok: false, reason: "noop" };
    if (mutations.length > MAX_MUTATIONS_PER_BATCH) return { ok: false, reason: "too-many" };
    for (const mutation of mutations) {
      const parsed = mutationSchema.safeParse(mutation);
      if (!parsed.success) {
        console.error("操作の形が正しくありません", mutation, parsed.error.issues);
        return { ok: false, reason: "invalid" };
      }
    }

    const id = uuidv7(this.#now().getTime());
    const inverse =
      options.undoable === false
        ? null
        : buildInverse(mutations, {
            task: (taskId) => this.replica.task(taskId)?.peek(),
            project: (projectId) => this.replica.project(projectId)?.peek(),
          });
    const batch: PendingBatch = {
      id,
      mutations,
      at: this.#now().toISOString(),
      operationId: id,
      kind,
    };
    this.replica.addPending([batch]);
    if (inverse) this.undoStack.push({ operationId: id, kind, inverse });
    this.#queue.kick();
    const ids = [...new Set(mutations.map((mutation) => targetOf(mutation).id))];
    return { ok: true, operationId: id, ids };
  }

  #persist(rows: readonly SyncRow[]): void {
    this.#localDb.putRows(rows).catch((error) => {
      console.error("手元の控えに保存できませんでした", error);
    });
  }

  #onSendFailed(error: ApiFailure, discarded: readonly PendingBatch[]): void {
    this.undoStack.discarded(discarded, { restoreUndone: isRetryable(error) });
    const detail = describeDiscarded(discarded);
    switch (error.kind) {
      case "unauthorized":
      case "version-mismatch":
        this.#stop(error.kind);
        this.#notices.emit({ type: error.kind, ...detail });
        return;
      case "rejected":
        if (isConflict(error)) {
          // ほかの画面が先に変えていた。最新を取りに行く（自動で合わせることはしない）
          this.#notices.emit({ type: "save-failed", reason: "conflict", ...detail });
          void this.sync();
          return;
        }
        // 検証エラーはほぼ不具合なので、記録を残す
        console.error("保存を受け付けられませんでした", error, detail.discarded);
        this.#notices.emit({ type: "save-failed", reason: "rejected", ...detail });
        return;
      case "network":
      case "server":
        this.#notices.emit({ type: "save-failed", reason: "network", ...detail });
        return;
    }
  }

  #onSyncFailed(error: ApiFailure): void {
    switch (error.kind) {
      case "unauthorized":
      case "version-mismatch": {
        const detail = describeDiscarded(this.replica.discardPending(() => true));
        this.undoStack.clear();
        this.#stop(error.kind);
        this.#notices.emit({ type: error.kind, ...detail });
        return;
      }
      case "rejected":
        console.error("差分を取得できませんでした", error);
        return;
      case "network":
      case "server":
        // 次のきっかけで取り直す
        return;
    }
  }

  #stop(reason: StopReason): void {
    runInAction(() => {
      this.stoppedBy ??= reason;
    });
  }

  // --- 削除済みの行の後始末 ---------------------------------------------------------------

  #purgeCutoff(): string {
    return new Date(this.#now().getTime() - DELETED_ROW_TTL_DAYS * DAY_MS).toISOString();
  }

  /** 削除から 30 日たった行を、メモリと手元の控えから捨てる */
  #purgeExpired(): void {
    const cutoff = this.#purgeCutoff();
    const { taskIds, projectIds } = this.replica.expiredDeleted(cutoff);
    if (taskIds.length > 0 || projectIds.length > 0) {
      this.replica.dropConfirmed(taskIds, projectIds);
    }
    this.#localDb.purgeDeleted(cutoff).catch((error) => console.error(error));
  }
}

/**
 * ほかの画面が先に変えていたので断られた理由（不具合ではない）。
 * チェックリストの配列が変わっていた・アーカイブしようとしたプロジェクトにタスクが付いた・
 * 付けようとしたプロジェクトがアーカイブされた
 */
const CONFLICT_REASONS: ReadonlySet<InvalidRequestReason> = new Set([
  "checklist_conflict",
  "project_has_open_tasks",
  "project_archived",
]);

function isConflict(error: ApiFailure): boolean {
  return (
    error.kind === "rejected" &&
    error.body?.error === "invalid_request" &&
    CONFLICT_REASONS.has(error.body.reason)
  );
}

export function createAppStore(options?: AppStoreOptions): AppStore {
  return new AppStore(options);
}
