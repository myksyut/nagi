import type { OperationResult } from "@/data";
import { runTaskOperation } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";

/**
 * タイムラインの棒の真ん中のドラッグ：やる日と締切を、同じ日数だけずらす（1つの操作。⌘Z 1回で戻る）。
 * 決まり（今日以前のやる日は今日へ、今日以前の締切で今日へ移すか）はデータ層の shiftTaskDates にある。
 * 左端と右端は、日付の操作（features/dates/commands.ts の scheduleTasks・setDeadline）をそのまま呼ぶ。
 * どれも棒が動くだけで一覧から抜ける行はないので、トーストは出さない（⌘Z で戻る）
 */
export function shiftTaskDates(ui: ListUi, ids: readonly string[], days: number): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.shiftTaskDates(ids, days),
  });
}
