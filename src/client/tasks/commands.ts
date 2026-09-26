import { runInAction } from "mobx";
import type { OperationResult, TaskRow } from "@/data";
import type { ListUi } from "./list-ui";

/**
 * タスクへの操作（キーとクリックの両方から呼ぶ）。データを変えるのはストアの操作で、
 * ここでは選択の移動、開いているタスクを閉じること、「元に戻す」のトーストを受け持つ。
 * 5・6 で操作を足すときも runTaskOperation を通すと、選択とトーストが同じ決まりで動く
 */

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
  /** 「元に戻す」付きのトーストの文言。left は一覧から抜けた行の id。返さなければ出さない */
  toast?: (left: readonly string[]) => string | undefined;
};

export function runTaskOperation(ui: ListUi, operation: TaskOperation): OperationResult {
  const { ids, perform, advance = false, toast } = operation;
  const selectedBefore = ui.selectedId;
  const next = ui.neighborAfter(ids);
  const result = perform();
  if (!result.ok) return result;
  const visible = new Set(ui.rows.map((row) => row.id));
  const left = ids.filter((id) => !visible.has(id));
  runInAction(() => {
    const moves = (id: string | null) =>
      id !== null && ids.includes(id) && (advance || !visible.has(id));
    if (moves(ui.openId)) ui.close();
    if (moves(selectedBefore)) ui.select(next);
  });
  const message = toast?.(left);
  if (message) ui.toaster.undoable(message, result.operationId, () => undo(ui));
  return result;
}

function rowsOf(ui: ListUi, ids: readonly string[]): TaskRow[] {
  return ids.flatMap((id) => {
    const row = ui.store.task(id);
    return row && row.deletedAt === null ? [row] : [];
  });
}

/** トーストの対象の書き方：1件ならタイトル、複数なら件数 */
function subject(ui: ListUi, ids: readonly string[]): string {
  if (ids.length === 1) return `「${ui.store.task(ids[0] ?? "")?.title ?? ""}」`;
  return `${ids.length}件`;
}

/** 完了。今日以外のリストで完了したら「完了しました・元に戻す」 */
export function completeTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.completeTasks(ids),
    advance: true,
    toast: () =>
      ui.view?.kind === "today"
        ? undefined
        : ids.length === 1
          ? "完了しました"
          : `${ids.length}件を完了しました`,
  });
}

/** あとから完了を外す（「完了 N件」や完了ログの行で）。今日の一番下に戻る */
export function uncompleteTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.uncompleteTasks(ids),
    toast: (left) => (left.length > 0 ? `${subject(ui, left)}を今日に戻しました` : undefined),
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

/** 振り分け（t：今日の一番下へ、l：あとでへ）。一覧から抜けたら「今日へ・元に戻す」 */
export function moveTasks(
  ui: ListUi,
  ids: readonly string[],
  bucket: "inbox" | "today" | "later",
): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.moveTasks(ids, { bucket }),
    toast: (left) =>
      left.length > 0 ? `${subject(ui, left)}を${BUCKET_NAMES[bucket]}へ` : undefined,
  });
}

/** 削除（確認は出さない）。「削除しました・元に戻す」 */
export function deleteTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.deleteTasks(ids),
    toast: () => (ids.length === 1 ? "削除しました" : `${ids.length}件を削除しました`),
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
