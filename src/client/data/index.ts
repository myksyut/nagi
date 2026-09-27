/**
 * 画面側のデータ層の入口。画面はここから読む
 * - ストア：AppStore（createAppStore で作り、start() で動かす）。部品へは StoreProvider / useStore で渡す
 * - 読む：store.lists（各リスト・ボードの列・プロジェクトの色）、store.task(id) / store.project(id)、
 *   store.today、store.isOnline など
 * - 操作：store.actions（追加・更新・完了・完了を外す（進行中で戻すことも）・進行中にする・未着手に戻す・移動・
 *   並べ替え・削除・元に戻す・並び順キー）
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
  type LogbookDay,
  PROJECT_BOARD_COMPLETED_DAYS,
  type ProjectBoard,
  type ProjectTaskGroups,
  type TodayBoard,
} from "./lists";
export type { DiscardedOperation, FailedCreate, Notice, NoticeListener } from "./notices";
export { StoreProvider, useStore } from "./react";
export type { OperationKind } from "./replica";
export type { ProjectRow, TaskRow } from "./rows";
export { AppStore, type AppStoreOptions, createAppStore, type StopReason } from "./store";
