/**
 * 画面側のデータ層の入口。画面はここから読む
 * - ストア：AppStore（createAppStore で作り、start() で動かす）。部品へは StoreProvider / useStore で渡す
 * - 読む：store.lists（各リスト・ボードの列・プロジェクトの色・工数の合計）、store.task(id) / store.project(id)、
 *   store.today、store.isOnline など
 * - 操作：store.actions（追加・更新・完了・完了を外す（進行中で戻すことも）・進行中にする・未着手に戻す・移動・
 *   並べ替え・優先度・工数・削除・元に戻す・並び順キー）
 * - 並び方（手動・優先度・工数）：sortTasks（表示だけの並べ替え。rank は書き換えない）。
 *   優先度と工数の値の一覧と表示名は @shared/priority-points
 * - 知らせ：store.subscribe(listener)
 */
export type {
  AddTaskInput,
  Destination,
  OperationFailure,
  OperationResult,
  PerformOptions,
  Placement,
  ProjectChanges,
  TaskChanges,
} from "./actions";
export {
  type BoardPoints,
  type LogbookDay,
  PROJECT_BOARD_COMPLETED_DAYS,
  type ProjectBoard,
  type ProjectTaskGroups,
  sumPoints,
  type TodayBoard,
} from "./lists";
export type { DiscardedOperation, FailedCreate, Notice, NoticeListener } from "./notices";
export { StoreProvider, useStore } from "./react";
export type { OperationKind } from "./replica";
export type { ProjectRow, TaskRow } from "./rows";
export {
  isTaskSort,
  type SortableTask,
  sortTasks,
  TASK_SORT_LABELS,
  TASK_SORTS,
  type TaskSort,
} from "./sort";
export { AppStore, type AppStoreOptions, createAppStore, type StopReason } from "./store";
