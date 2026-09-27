import { MAX_MUTATIONS_PER_BATCH } from "@shared/mutations";
import { runInAction } from "mobx";
import type { OperationFailure, OperationResult, TaskRow } from "@/data";
import { playCompletionRings } from "./completion-ring";
import type { ListUi } from "./list-ui";
import { planDrop, planStep } from "./reorder";

/**
 * タスクへの操作（キーとクリックの両方から呼ぶ）。データを変えるのはストアの操作で、
 * ここでは選択の移動、開いているタスクを閉じること、「元に戻す」のトーストを受け持つ。
 * 5・6 で操作を足すときも runTaskOperation を通すと、選択とトーストが同じ決まりで動く。
 * 複数選んでいるときも、1回の操作は1つのまとまりとして送る（⌘Z 1回でまとめて戻る）
 */

/** 一度に扱える件数（データ層の1回の操作の上限と同じ）。超えたら分けずに断る */
export const MAX_BULK = MAX_MUTATIONS_PER_BATCH;
export const TOO_MANY_MESSAGE = `一度に扱えるのは ${MAX_BULK} 件まで`;

/** 件数が上限以内か。超えていたら「一度に扱えるのは 500 件まで」と知らせて false（データ層に送る前に止める） */
export function withinBulkLimit(ui: ListUi, count: number): boolean {
  if (count <= MAX_BULK) return true;
  ui.toaster.error(TOO_MANY_MESSAGE);
  return false;
}

/**
 * キーの操作の対象：選んでいる行（上から見えている順）。何も選んでいなければ空。
 * 選択が上限を超えていたら、実行せずに知らせて undefined
 */
export function selectionForOperation(ui: ListUi): readonly TaskRow[] | undefined {
  const rows = ui.selectedRows;
  if (rows.length === 0) return [];
  return withinBulkLimit(ui, rows.length) ? rows : undefined;
}

/** 未完了の行だけ（t・l・d・⇧D の対象） */
export function openRowsOf(rows: readonly TaskRow[]): TaskRow[] {
  return rows.filter((row) => row.completedAt === null);
}

export type TaskOperation = {
  /** 操作の対象 */
  ids: readonly string[];
  /** ストアの操作を呼ぶ */
  perform: () => OperationResult;
  /**
   * 選んでいた行が対象なら、一覧に残っていても次の行へ選択を移す（完了。行は「完了 N件」に残ることがある）。
   * false なら、一覧から抜けたときだけ移す
   */
  advance?: boolean;
  /**
   * 「元に戻す」付きのトーストの文言。left は一覧から抜けた行の id（操作の前は一覧にあって、あとにはない行。
   * 小さな詳細など、一覧の外のタスクへの操作では入らない）、changed は実際に変えたタスクの id
   * （変えるものがなかった行や、同じ操作で作ったプロジェクトは入らない）。返さなければ出さない
   */
  toast?: (left: readonly string[], changed: readonly string[]) => string | undefined;
};

/**
 * 受け付けられなかった操作を知らせる。黙って何も起きないように見えないようにするため。
 * 変えるものがなかった（noop）ときは知らせない。オフライン・ログインが切れた・版が古いは、それぞれの知らせ
 * （上部の帯、ログイン画面、新しいバージョン）が受け持つ
 */
function notifyFailure(ui: ListUi, reason: OperationFailure): void {
  switch (reason) {
    case "too-many":
      // プロジェクトの作成と付けるのを合わせると上限を超える、など
      ui.toaster.error(TOO_MANY_MESSAGE);
      return;
    case "invalid":
      // 並び順キーが長くなりすぎた（同じ隙間へ入れ続けた）など
      ui.toaster.error("保存できませんでした");
      return;
    case "noop":
    case "offline":
    case "stopped":
    case "has-open-tasks":
    case "nothing-to-undo":
      return;
  }
}

export function runTaskOperation(ui: ListUi, operation: TaskOperation): OperationResult {
  const { ids, perform, advance = false, toast } = operation;
  if (!withinBulkLimit(ui, ids.length)) return { ok: false, reason: "too-many" };
  const selectedBefore = ui.selectedId;
  const next = ui.neighborAfter(ids);
  const visibleBefore = new Set(ui.rows.map((row) => row.id));
  const result = perform();
  if (!result.ok) {
    notifyFailure(ui, result.reason);
    return result;
  }
  const visible = new Set(ui.rows.map((row) => row.id));
  // 一覧から抜けた行：前は一覧にあって、今はない行（小さな詳細など、一覧の外のタスクへの操作は数えない）
  const left = ids.filter((id) => visibleBefore.has(id) && !visible.has(id));
  const targets = new Set(ids);
  const changed = result.ids.filter((id) => targets.has(id));
  runInAction(() => {
    const moves = (id: string | null) =>
      id !== null && ids.includes(id) && (advance || !visible.has(id));
    if (moves(ui.openId)) ui.close();
    if (moves(selectedBefore)) ui.select(next);
  });
  const message = toast?.(left, changed);
  if (message) ui.toaster.undoable(message, result.operationId, () => undo(ui));
  return result;
}

function rowsOf(ui: ListUi, ids: readonly string[]): TaskRow[] {
  return ids.flatMap((id) => {
    const row = ui.store.task(id);
    return row && row.deletedAt === null ? [row] : [];
  });
}

/**
 * トーストの対象の書き方。2件以上をまとめて変えたら、一覧に残っていても件数（「3件」）。
 * 1件なら、一覧から抜けたときだけタイトル（「「請求書の確認」」）。残っているときは出さない（undefined）
 */
export function toastSubject(
  ui: ListUi,
  left: readonly string[],
  changed: readonly string[],
): string | undefined {
  if (changed.length >= 2) return `${changed.length}件`;
  const id = left[0];
  if (id === undefined) return undefined;
  return left.length === 1 ? `「${ui.store.task(id)?.title ?? ""}」` : `${left.length}件`;
}

/** 完了。今日以外のリストで完了したら「完了しました・元に戻す」。2件以上なら今日でも「3件を完了しました」 */
export function completeTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  const result = runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.completeTasks(ids),
    advance: true,
    toast: (_, changed) =>
      changed.length >= 2
        ? `${changed.length}件を完了しました`
        : ui.view?.kind === "today"
          ? undefined
          : "完了しました",
  });
  // 丸から光の輪が広がる（受け付けられたときだけ。prefers-reduced-motion では出さない）。
  // 受け付けた直後は React がまだ描き直していないので、丸は元の位置にある
  if (result.ok) playCompletionRings(ids);
  return result;
}

/** あとから完了を外す（「完了 N件」や完了ログの行で）。今日の一番下に戻る */
export function uncompleteTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.uncompleteTasks(ids),
    toast: (left, changed) => {
      const subject = toastSubject(ui, left, changed);
      return subject === undefined ? undefined : `${subject}を今日に戻しました`;
    },
  });
}

/** x と丸：未完了のものがあれば完了、すべて完了済みなら完了を外す */
export function toggleComplete(ui: ListUi, ids: readonly string[]): OperationResult {
  const rows = rowsOf(ui, ids);
  const open = rows.filter((row) => row.completedAt === null).map((row) => row.id);
  if (open.length > 0) return completeTasks(ui, open);
  return uncompleteTasks(
    ui,
    rows.map((row) => row.id),
  );
}

const BUCKET_NAMES = { inbox: "受信箱", today: "今日", later: "あとで" } as const;

/** 振り分け（t：今日の一番下へ、l：あとでへ）。一覧から抜けたら（2件以上なら残っていても）「今日へ・元に戻す」 */
export function moveTasks(
  ui: ListUi,
  ids: readonly string[],
  bucket: "inbox" | "today" | "later",
): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.moveTasks(ids, { bucket }),
    toast: (left, changed) => {
      const subject = toastSubject(ui, left, changed);
      return subject === undefined ? undefined : `${subject}を${BUCKET_NAMES[bucket]}へ`;
    },
  });
}

/**
 * ⌥↑（delta = -1）・⌥↓（delta = 1）：選んでいる行を、まとめて1つ上・下へ。
 * 選んでいる行がすべて同じ並べ替えられるまとまりにあるときだけ動かす。トーストは出さない（⌘Z で戻る）
 */
export function moveSelectedRows(ui: ListUi, delta: -1 | 1): OperationResult | undefined {
  const rows = selectionForOperation(ui);
  if (!rows || rows.length === 0) return undefined;
  const ids = rows.map((row) => row.id);
  const section = ui.reorderableSectionOf(ids);
  if (!section) return undefined;
  const placements = planStep(
    section.rows.map((row) => row.id),
    new Set(ids),
    delta,
  );
  if (!placements) return undefined;
  return runTaskOperation(ui, { ids, perform: () => ui.store.actions.reorderTasks(placements) });
}

/** ドラッグで落とした：ids の行を、同じまとまりの target の行の前か後ろへまとめて入れる */
export function dropRows(
  ui: ListUi,
  ids: readonly string[],
  target: string,
  edge: "before" | "after",
): OperationResult | undefined {
  const section = ui.reorderableSectionOf([...ids, target]);
  if (!section) return undefined;
  const placements = planDrop(
    section.rows.map((row) => row.id),
    ids,
    target,
    edge,
  );
  if (!placements) return undefined;
  return runTaskOperation(ui, { ids, perform: () => ui.store.actions.reorderTasks(placements) });
}

/** 削除（確認は出さない）。「削除しました・元に戻す」 */
export function deleteTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.deleteTasks(ids),
    toast: (_, changed) =>
      changed.length >= 2 ? `${changed.length}件を削除しました` : "削除しました",
  });
}

/** 元に戻す（⌘Z とトーストの「元に戻す」）。戻ったタスクが今の一覧にあれば選ぶ */
export function undo(ui: ListUi): OperationResult {
  const result = ui.store.actions.undo();
  if (!result.ok) return result;
  ui.toaster.dismissUndo();
  const restored = result.ids.find((id) => ui.rows.some((row) => row.id === id));
  if (restored !== undefined) ui.select(restored);
  return result;
}
