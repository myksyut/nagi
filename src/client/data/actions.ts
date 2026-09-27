import {
  type Bucket,
  type ChecklistItem,
  isScheduleConsistent,
  isStartConsistent,
  type Project,
  type Task,
} from "@shared/model";
import type { Mutation } from "@shared/mutations";
import { arrivalRanks, rankBetween, ranksBetween } from "@shared/rank";
import type { LogicalDay } from "./logical-day";
import { applyTaskMutation, isTaskMutation, targetOf } from "./overlay";
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
  /**
   * 元に戻す操作が、ほかの画面の変更とぶつかった（戻すと「進行中なら今日」などが崩れる）。
   * 戻さずに、その操作を元に戻すの対象から外し、ぶつかりを知らせて同期し直す
   */
  | "conflict"
  /** 元に戻す操作がない */
  | "nothing-to-undo";

export type OperationResult =
  /** ids は操作の対象になった行（作った行を含む）の id。操作した順 */
  | { ok: true; operationId: string; ids: readonly string[] }
  | { ok: false; reason: OperationFailure };

export type PerformOptions = {
  /** 元に戻すの対象にするか（既定は true） */
  undoable?: boolean;
  /**
   * 入力の自動保存か（タイトル・メモ・チェックリストの項目の名前）。オフラインで止めたときの知らせにそのまま載せる
   * （画面は、自動保存を止めたときは上部の帯を強調しない）
   */
  autosave?: boolean;
};

export type Perform = (
  kind: OperationKind,
  mutations: Mutation[],
  options?: PerformOptions,
) => OperationResult;

export type TaskChanges = Extract<Mutation, { type: "task.update" }>["changes"];
export type ProjectChanges = Extract<Mutation, { type: "project.update" }>["changes"];

/**
 * 追加の中身と行き先。予定へは日付と一緒に指定する（カレンダーの日のマスの「＋」。13）
 */
export type AddTaskInput = {
  title: string;
  memo?: string;
  projectId?: string | null;
} & ({ bucket: Exclude<Bucket, "scheduled"> } | { bucket: "scheduled"; on: string });

/** 置き場の移動先。予定は日付と一緒に指定する */
export type Destination =
  | { bucket: Exclude<Bucket, "scheduled"> }
  | { bucket: "scheduled"; on: string };

/**
 * 並べ替えの1か所ぶん：ids（上から入れる順）を、after の行の後ろ・before の行の前へ入れる。
 * after と before は、画面で見えている動かさない行（端なら null。両方 null は受け付けない）
 */
export type Placement = {
  ids: readonly string[];
  after: string | null;
  before: string | null;
};

type ActionsOptions = {
  replica: Replica;
  day: LogicalDay;
  undoStack: UndoStack;
  now: () => Date;
  newId: () => string;
  perform: Perform;
  /** 元に戻す操作がぶつかって、戻さなかったとき（ストアが知らせを出し、同期し直す） */
  onUndoConflict?: () => void;
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
 * 変える項目だけを残し、bucket と scheduledOn の対応、進行中と今日の対応を満たすようにそろえる。
 * - scheduled にするときは scheduledOn も、scheduled から外すときは scheduledOn: null も、同じ changes に入れる
 * - 進行中（startedAt あり）のタスクを今日から出すときは、同じ changes で startedAt: null にする（未着手に戻る）。
 *   今日の外で startedAt を入れようとしたら（今と同じ値でも）受け付けない
 * 受け付けられない内容なら null
 */
export function normalizeTaskChanges(current: Task, changes: TaskChanges): TaskChanges | null {
  // 明示した startedAt と変えたあとの bucket の組み合わせを、同じ値を取り除く前に確かめる
  // （今と同じ startedAt を明示して今日から出すと、取り除いたあとでは「未着手への移動」に見えてしまうため。
  // 進行中を保つつもりの操作を、黙って別の操作にしない）
  const startedAtGiven = changes.startedAt !== undefined && changes.startedAt !== null;
  if (startedAtGiven && (changes.bucket ?? current.bucket) !== "today") return null;
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
  if (current.startedAt !== null && changes.startedAt === undefined && bucket !== "today") {
    next.startedAt = null;
  }
  return next as TaskChanges;
}

/**
 * 操作を今の表示に順に重ねると、タスクの決まり（「進行中なら今日」「予定なら日付あり」）が崩れるか。
 * 元に戻す操作は、戻すまでのあいだにほかの画面が同じタスクを動かしていると崩れることがある
 * （サーバーも断る）。そのときは直して送らず、戻せなかったことにする
 */
function breaksTaskRules(
  mutations: readonly Mutation[],
  read: (id: string) => Task | undefined,
): boolean {
  const tasks = new Map<string, Task | undefined>();
  for (const mutation of mutations) {
    if (!isTaskMutation(mutation)) continue;
    const { id } = targetOf(mutation);
    const next = applyTaskMutation(tasks.has(id) ? tasks.get(id) : read(id), mutation, "");
    tasks.set(id, next);
    if (next && !(isScheduleConsistent(next) && isStartConsistent(next))) return true;
  }
  return false;
}

export class TaskActions {
  readonly #replica: Replica;
  readonly #day: LogicalDay;
  readonly #undoStack: UndoStack;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #perform: Perform;
  readonly #onUndoConflict: () => void;

  constructor({
    replica,
    day,
    undoStack,
    now,
    newId,
    perform,
    onUndoConflict = () => {},
  }: ActionsOptions) {
    this.#replica = replica;
    this.#day = day;
    this.#undoStack = undoStack;
    this.#now = now;
    this.#newId = newId;
    this.#perform = perform;
    this.#onUndoConflict = onUndoConflict;
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

  /**
   * 追加。置き場の一番下に入る。ids[0] が作ったタスクの id。
   * 予定へ追加するときに、日付が今日か過去なら今日の一番下に入れる（moveTasks と同じ決まり）
   */
  addTask(input: AddTaskInput): OperationResult {
    const { title, memo = "", projectId = null } = input;
    if (!isNonBlank(title)) return { ok: false, reason: "invalid" };
    const scheduledOn =
      input.bucket === "scheduled" && input.on > this.#day.today ? input.on : null;
    const bucket: Bucket =
      input.bucket !== "scheduled" ? input.bucket : scheduledOn === null ? "today" : "scheduled";
    const [rank] = this.bottomRanks(bucket);
    if (rank === undefined) return { ok: false, reason: "invalid" };
    const task = { id: this.#newId(), title, memo, bucket, projectId, rank };
    return this.#perform("task.add", [
      {
        type: "task.create",
        task: scheduledOn === null ? task : { ...task, scheduledOn },
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

  /**
   * あとから完了を外す（「完了 N件」や完了ログから）。今日の一番下に、未着手で戻る
   * （進行中のまま完了していても startedAt を消す）。
   * start を付けると、同じ操作で進行中にする（今日の一番下に、進行中で戻る。ボードで完了のカードを進行中の列へ
   * 落としたとき。完了を外すのと進行中にするのが1つの操作なので、⌘Z 1回で完了に戻る）。
   * 完了の直後の取り消しは、この操作ではなく元に戻す（completedAt を消すだけなので、進行中に戻る）
   */
  uncompleteTasks(
    ids: readonly string[],
    { start = false }: { start?: boolean } = {},
  ): OperationResult {
    const targets = this.#rows(ids).filter(
      (task) => task.completedAt !== null && task.deletedAt === null,
    );
    const ranks = this.bottomRanks("today", targets.length);
    const startedAt = start ? this.#now().toISOString() : null;
    const updates = targets.map((task, i) => ({
      id: task.id,
      changes: { completedAt: null, startedAt, bucket: "today" as const, rank: ranks[i] },
    }));
    return this.#updateMany("task.uncomplete", updates);
  }

  /**
   * 進行中にする（未完了で、まだ進行中でないタスクだけ）。今日以外にあるタスクは、同じ操作で今日の一番上へ移す
   * （移すタスクどうしは渡した順で上から並ぶ）。すでに今日にあるタスクは位置を変えない
   */
  startTasks(ids: readonly string[]): OperationResult {
    const startedAt = this.#now().toISOString();
    const targets = this.#rows(ids).filter(
      (task) => task.completedAt === null && task.deletedAt === null && task.startedAt === null,
    );
    const ranks = this.topRanks("today", targets.filter((task) => task.bucket !== "today").length);
    let next = 0;
    const updates = targets.map((task) =>
      task.bucket === "today"
        ? { id: task.id, changes: { startedAt } }
        : { id: task.id, changes: { startedAt, bucket: "today" as const, rank: ranks[next++] } },
    );
    return this.#updateMany("task.start", updates);
  }

  /** 未着手に戻す（進行中のタスクだけ）。startedAt を消すだけで、位置は変えない */
  stopTasks(ids: readonly string[]): OperationResult {
    const updates = this.#rows(ids)
      .filter(
        (task) => task.startedAt !== null && task.completedAt === null && task.deletedAt === null,
      )
      .map((task) => ({ id: task.id, changes: { startedAt: null } }));
    return this.#updateMany("task.stop", updates);
  }

  /**
   * 置き場を移す（未完了のタスクだけ）。移した先の一番下に、渡した順で並ぶ。
   * 予定へ移すときに、日付が今日か過去なら今日に入れる。
   * 進行中のタスクを今日から出すと、同じ操作で未着手に戻る（startedAt を消す。normalizeTaskChanges）
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
   * 並べ替え（⌥↑↓・ドラッグ）。書き換えるのは動かした行の rank だけで、置き場は変えない。
   * 動かす行は、同じ置き場の未完了のタスク。1回の操作で何か所に入れてもよい（まとめて戻る）。
   * 新しい rank は、隣の行とのあいだで、その置き場のほかの行（完了済み・削除済みや、画面に出ていない
   * ほかのプロジェクトの行も含む）の rank と重ならないところに作る（元に戻したときに並びが崩れないように）
   */
  reorderTasks(placements: readonly Placement[]): OperationResult {
    const moving = new Set(placements.flatMap((placement) => placement.ids));
    const rows = this.#rows([...moving]);
    const bucket = rows[0]?.bucket;
    if (
      bucket === undefined ||
      rows.length !== moving.size ||
      rows.some(
        (task) => task.bucket !== bucket || task.completedAt !== null || task.deletedAt !== null,
      )
    ) {
      return { ok: false, reason: "invalid" };
    }
    const rankOf = (id: string | null) =>
      id === null ? null : (this.#replica.task(id)?.peek().rank ?? undefined);
    // 動かさない行の rank（小さい順）
    const fixed = this.#ranksIn(bucket, moving).sort();
    const updates: { id: string; changes: TaskChanges }[] = [];
    for (const { ids, after, before } of placements) {
      if (ids.length === 0) continue;
      const afterRank = rankOf(after);
      const beforeRank = rankOf(before);
      if (afterRank === undefined || beforeRank === undefined)
        return { ok: false, reason: "invalid" };
      if (afterRank === null && beforeRank === null) return { ok: false, reason: "invalid" };
      // after の直後（次の rank の手前）か、after が端なら before の直前（前の rank の後ろ）に入れる
      const [lower, upper] =
        afterRank !== null
          ? [afterRank, fixed.find((rank) => rank > afterRank) ?? null]
          : [fixed.findLast((rank) => rank < (beforeRank ?? "")) ?? null, beforeRank];
      const ranks = ranksBetween(lower, upper, ids.length);
      ids.forEach((id, i) => {
        updates.push({ id, changes: { rank: ranks[i] } });
      });
    }
    return this.#updateMany("task.reorder", updates);
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

  /**
   * プロジェクトを作る。ids[0] が作ったプロジェクトの id。
   * assignTo を渡すと、同じ操作でそのタスクに付ける（p の「「◯◯」を作成」。作成と付けるのを1回で戻せる）
   */
  createProject(name: string, assignTo: readonly string[] = []): OperationResult {
    if (!isNonBlank(name)) return { ok: false, reason: "invalid" };
    const id = this.#newId();
    // 色は入れない（空のまま作り、表示は作成順の色に任せる。lists.projectColor）。作るときに手元の件数で
    // 決めると、同期の前・ほかのタブの作成・同じ時刻の作成で、作成順とずれた色が保存されて直らないため。
    // color を入れるのは、利用者が色を選んだとき（updateProject）だけ
    const mutations: Mutation[] = [{ type: "project.create", project: { id, name: name.trim() } }];
    for (const task of this.#rows(assignTo)) {
      if (task.deletedAt === null) {
        mutations.push({ type: "task.update", id: task.id, changes: { projectId: id } });
      }
    }
    return this.#perform("project.create", mutations);
  }

  /** タスクにプロジェクトを付ける・外す（null）。アーカイブ済み・削除済みのプロジェクトは付けられない */
  setProject(ids: readonly string[], projectId: string | null): OperationResult {
    if (projectId !== null) {
      const project = this.#replica.project(projectId)?.peek();
      if (!project || project.archivedAt !== null || project.deletedAt !== null) {
        return { ok: false, reason: "invalid" };
      }
    }
    const updates = this.#rows(ids)
      .filter((task) => task.deletedAt === null)
      .map((task) => ({ id: task.id, changes: { projectId } }));
    return this.#updateMany("task.update", updates);
  }

  /**
   * 名前の変更・色の変更・アーカイブ。未完了のタスクが残っているとアーカイブできない。
   * 色はパレットの名前だけ（ほかは invalid）。null にすると作成順の色に戻る
   */
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
    const trimmed =
      changes.name === undefined ? changes : { ...changes, name: changes.name.trim() };
    for (const [key, value] of Object.entries(trimmed)) {
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

  /**
   * 一番新しい操作を、逆向きの操作のまとまり1つで戻す。
   * 戻すまでのあいだにほかの画面が同じタスクを動かしていて、戻すとタスクの決まりが崩れるときは、
   * 直して送ることはせずに戻さない（conflict）。その操作は戻せないので元に戻すの対象から外し、
   * ぶつかりを知らせて同期し直す（onUndoConflict）
   */
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
    if (breaksTaskRules(mutations, (id) => this.#replica.task(id)?.peek())) {
      this.#onUndoConflict();
      return { ok: false, reason: "conflict" };
    }
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

  /** 置き場にある行（完了済み・削除済みも含む）の rank。except の行は除く */
  #ranksIn(bucket: Bucket, except?: ReadonlySet<string>): string[] {
    const ranks: string[] = [];
    for (const row of this.#replica.taskIndex.rows(bucket)) {
      if (!except?.has(row.id)) ranks.push(row.peek().rank);
    }
    for (const partition of ["completed", "deleted"] as const) {
      for (const row of this.#replica.taskIndex.rows(partition)) {
        const task = row.peek();
        if (task.bucket === bucket && !except?.has(task.id)) ranks.push(task.rank);
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
      mutations.push(
        normalized.checklist === undefined
          ? { type: "task.update", id, changes: normalized }
          : // チェックリストは配列をまるごと置き換えるので、変える前の配列（確定データに、それより前の
            // 送信中の操作を重ねたもの）を添える。ほかの画面が先に変えていたら、サーバーが断る
            { type: "task.update", id, changes: normalized, baseChecklist: current.checklist },
      );
    }
    return this.#perform(kind, mutations, options);
  }
}
