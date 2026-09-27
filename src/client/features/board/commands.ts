import type { DragEvent } from "react";
import type { OperationResult, TaskRow } from "@/data";
import { startTasks, stopTasks } from "@/features/status/commands";
import {
  completeTasks,
  runTaskOperation,
  toastSubject,
  uncompleteTasks,
  withinBulkLimit,
} from "@/tasks/commands";
import { setCountImage, taskDragOf } from "@/tasks/drag";
import type { ListUi } from "@/tasks/list-ui";

/**
 * ボードの操作。データを変えるのはリストと同じストアの操作（s・x・完了を外す）で、ボードに独自の書き込みはない。
 * 完了のカードを進行中の列へ落としたときだけ、「完了を外して進行中にする」を1つの操作で行う（⌘Z 1回で戻る）
 */

/** ボードの列（左から） */
export type ColumnKey = "notStarted" | "inProgress" | "completed";

/**
 * 完了を外して進行中にする（完了のカードを進行中の列へ落としたとき）。今日の一番下に、進行中で戻る。
 * 2件以上なら「3件を進行中にしました」
 */
export function restartTasks(ui: ListUi, ids: readonly string[]): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.uncompleteTasks(ids, { start: true }),
    toast: (left, changed) => {
      if (changed.length >= 2) return `${changed.length}件を進行中にしました`;
      const subject = toastSubject(ui, left, changed);
      return subject === undefined ? undefined : `${subject}を今日に戻しました`;
    },
  });
}

/**
 * カードを別の列へ落としたとき：列の変わり方に合わせて状態を変える。
 * - 未着手 → 進行中：s と同じ（今日以外にあれば今日の一番上へ移る）
 * - → 完了：x と同じ
 * - 進行中 → 未着手：s でやめるのと同じ（位置は変えない）
 * - 完了 → 未着手：完了を外す（今日の一番下に戻る）
 * - 完了 → 進行中：完了を外して進行中にする（今日の一番下。1つの操作）
 * 同じ列なら何もしない（undefined）
 */
export function moveToColumn(
  ui: ListUi,
  ids: readonly string[],
  from: ColumnKey,
  to: ColumnKey,
): OperationResult | undefined {
  if (from === to || ids.length === 0) return undefined;
  switch (to) {
    case "completed":
      return completeTasks(ui, ids);
    case "inProgress":
      return from === "completed" ? restartTasks(ui, ids) : startTasks(ui, ids);
    case "notStarted":
      return from === "completed" ? uncompleteTasks(ui, ids) : stopTasks(ui, ids);
  }
}

/**
 * カードをつかんだとき。複数選んでいるカードをつかむと、選んでいるカードのうち、つかんだカードと同じ列のもの
 * （完了のカードも運べる）をまとめて運ぶ（1回の落とし方で1つの操作にするため）。選んでいないカードをつかむと、
 * そのカードだけを選んで運ぶ
 */
export function startCardDrag(ui: ListUi, task: TaskRow, event: DragEvent): void {
  let rows: readonly TaskRow[];
  if (ui.isSelected(task.id) && ui.selectedIds.length > 1) {
    if (!withinBulkLimit(ui, ui.selectedRows.length)) {
      event.preventDefault();
      return;
    }
    const column = ui.columnOf(task.id);
    rows = ui.selectedRows.filter((row) => ui.columnOf(row.id) === column);
  } else {
    ui.select(task.id);
    rows = [task];
  }
  taskDragOf(ui).start(rows.map((row) => row.id));
  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.effectAllowed = "move";
    transfer.setData("text/plain", rows.map((row) => row.title).join("\n"));
  }
  setCountImage(event, rows.length);
}
