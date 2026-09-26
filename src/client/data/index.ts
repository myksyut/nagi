/**
 * 画面側のデータ層の入口。画面はここから読む
 * - ストア：AppStore（createAppStore で作り、start() で動かす）。部品へは StoreProvider / useStore で渡す
 * - 読む：store.lists（各リスト）、store.task(id) / store.project(id)、store.today、store.isOnline など
 * - 操作：store.actions（追加・更新・完了・完了を外す・移動・削除・元に戻す・並び順キー）
 * - 知らせ：store.subscribe(listener)
 */
export type {
  AddTaskInput,
  Destination,
  OperationFailure,
  OperationResult,
  PerformOptions,
  ProjectChanges,
  TaskChanges,
} from "./actions";
export type { LogbookDay, ProjectTaskGroups } from "./lists";
export type { DiscardedOperation, FailedCreate, Notice, NoticeListener } from "./notices";
export { StoreProvider, useStore } from "./react";
export type { OperationKind } from "./replica";
export type { ProjectRow, TaskRow } from "./rows";
export { AppStore, type AppStoreOptions, createAppStore, type StopReason } from "./store";
