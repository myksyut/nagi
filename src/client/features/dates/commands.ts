import type { OperationResult } from "@/data";
import { runTaskOperation } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import { formatLongDate } from "./labels";

/**
 * 日付と締切の操作（d・⇧D・開いたタスクの小さなボタンから）。
 * データの決まり（今日以前の日付は今日へ、締切で今日へ移すかどうか）はストアの操作にあり、
 * ここでは選択の移動と「元に戻す」のトーストを、ほかの操作と同じ決まり（runTaskOperation）で動かす
 */

/** トーストの対象の書き方：1件ならタイトル、複数なら件数 */
function subject(ui: ListUi, ids: readonly string[]): string {
  if (ids.length === 1) return `「${ui.store.task(ids[0] ?? "")?.title ?? ""}」`;
  return `${ids.length}件`;
}

/** d：日付を決めて予定へ。今日か過去の日付なら今日の一番下へ入る。一覧から抜けたら「◯◯へ・元に戻す」 */
export function scheduleTasks(ui: ListUi, ids: readonly string[], on: string): OperationResult {
  const today = ui.store.today;
  const destination = on <= today ? "今日" : formatLongDate(on, today);
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.moveTasks(ids, { bucket: "scheduled", on }),
    toast: (left) => (left.length > 0 ? `${subject(ui, left)}を${destination}へ` : undefined),
  });
}

/**
 * ⇧D：締切を付ける・外す（null）。予定・あとでのタスクに今日以前の締切を付けると今日の一番上へ移る
 * （受信箱では動かない）。一覧から抜けたら「今日へ・元に戻す」
 */
export function setDeadline(
  ui: ListUi,
  ids: readonly string[],
  deadlineOn: string | null,
): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.setDeadline(ids, deadlineOn),
    toast: (left) => (left.length > 0 ? `${subject(ui, left)}を今日へ` : undefined),
  });
}
