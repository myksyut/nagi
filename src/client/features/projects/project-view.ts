import type { AppStore, ProjectRow } from "@/data";
import type { AddTarget } from "@/tasks/list-ui";

/**
 * プロジェクトの画面のリストとボードで共通の決まり（一覧の名前・追加の行き先）。
 * 後から読み込むボード（features/board/board.tsx）からも使うので、画面の部品とは分けて持つ
 * （画面の部品を import すると、起動の JS の分け方が変わって大きくなるため）
 */

/** プロジェクトの画面の名前（一覧の名前と、リスト｜ボードの切り替えを覚える名前） */
export function projectScreenKey(id: string): string {
  return `project:${id}`;
}

/** 削除されていないプロジェクト */
export function liveProject(store: AppStore, id: string): ProjectRow | undefined {
  const project = store.project(id);
  return project && project.deletedAt === null ? project : undefined;
}

export function isArchivedProject(store: AppStore, id: string): boolean {
  return liveProject(store, id)?.archivedAt != null;
}

/**
 * n で追加する行き先：そのプロジェクトの「あとで」。
 * アーカイブ済みのプロジェクトには付けられないので、そのときは受信箱（プロジェクトなし）に入れる
 */
export function projectAddTo(store: AppStore, id: string): AddTarget {
  return isArchivedProject(store, id)
    ? { bucket: "inbox", label: "受信箱に追加" }
    : { bucket: "later", projectId: id, label: "あとでに追加" };
}
