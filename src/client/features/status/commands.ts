import type { OperationResult, TaskRow } from "@/data";
import { runTaskOperation, toastSubject } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";

/**
 * 進行中の操作（s・開いたタスクの状態のボタンから）。データの決まり（今日以外のタスクは今日の一番上へ移す、
 * 位置を変えずに未着手に戻す）はストアの startTasks・stopTasks にあり、ここでは選択の移動と「元に戻す」のトーストを、
 * ほかの操作と同じ決まり（runTaskOperation）で動かす
 */

/** 未完了で削除されていない行（完了済みの行には s は効かない） */
function openRows(ui: ListUi, ids: readonly string[]): TaskRow[] {
  return ids.flatMap((id) => {
    const row = ui.store.task(id);
    return row && row.deletedAt === null && row.completedAt === null ? [row] : [];
  });
}

/**
 * 進行中にする。今日以外の行は今日の一番上へ移る。一覧から抜けたら「「A」を今日へ・元に戻す」
 * （ほかの振り分けと同じ）。2件以上をまとめて進行中にしたら、残っていても「3件を進行中にしました」
 */
export function startTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.startTasks(ids),
    toast: (left, changed) => {
      if (changed.length >= 2) return `${changed.length}件を進行中にしました`;
      const subject = toastSubject(ui, left, changed);
      return subject === undefined ? undefined : `${subject}を今日へ`;
    },
  });
}

/** 未着手に戻す（位置は変わらない）。2件以上をまとめて戻したら「3件を未着手に戻しました」 */
export function stopTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.stopTasks(ids),
    toast: (_, changed) =>
      changed.length >= 2 ? `${changed.length}件を未着手に戻しました` : undefined,
  });
}

/**
 * s：選んだ中に未着手が1つでもあれば、未着手のものを進行中にする。全部が進行中のときだけ未着手に戻す。
 * 完了済みの行には効かない（未完了の行がなければ何もしない）
 */
export function toggleStarted(ui: ListUi, ids: readonly string[]): OperationResult | undefined {
  const rows = openRows(ui, ids);
  if (rows.length === 0) return undefined;
  const notStarted = rows.filter((row) => row.startedAt === null).map((row) => row.id);
  if (notStarted.length > 0) return startTasks(ui, notStarted);
  return stopTasks(
    ui,
    rows.map((row) => row.id),
  );
}
