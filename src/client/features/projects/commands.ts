import type { OperationResult, ProjectRow } from "@/data";
import { runTaskOperation, undo } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";

/**
 * プロジェクトの操作（p の候補・開いたタスクのボタン・プロジェクトの画面の見出しから呼ぶ）。
 * タスクに付ける操作は runTaskOperation を通すので、プロジェクトの画面から行が抜けたときは
 * 選択が次の行へ移り、「元に戻す」のトーストが出る
 */

/** 名前の比べ方：全角と半角、大文字と小文字を区別しない */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}

function subject(ui: ListUi, ids: readonly string[]): string {
  if (ids.length === 1) return `「${ui.store.task(ids[0] ?? "")?.title ?? ""}」`;
  return `${ids.length}件`;
}

/** タスクにプロジェクトを付ける・外す（null） */
export function setTaskProject(
  ui: ListUi,
  ids: readonly string[],
  projectId: string | null,
): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.setProject(ids, projectId),
    toast: (left) => {
      if (left.length === 0) return undefined;
      const name = projectId === null ? undefined : ui.store.project(projectId)?.name;
      return name === undefined
        ? `${subject(ui, left)}のプロジェクトを外しました`
        : `${subject(ui, left)}を「${name}」へ`;
    },
  });
}

/** 新しいプロジェクトを作って、同じ操作でタスクに付ける（p の「「◯◯」を作成」） */
export function createProjectFor(
  ui: ListUi,
  ids: readonly string[],
  name: string,
): OperationResult {
  return runTaskOperation(ui, {
    ids,
    perform: () => ui.store.actions.createProject(name, ids),
    toast: (left) => (left.length > 0 ? `${subject(ui, left)}を「${name.trim()}」へ` : undefined),
  });
}

/** 名前を変える。空の名前は受け付けない（元の名前のまま） */
export function renameProject(ui: ListUi, project: ProjectRow, name: string): OperationResult {
  return ui.store.actions.updateProject(project.id, { name });
}

/**
 * アーカイブする（サイドバーから隠す）。未完了のタスクが残っていたら、アーカイブせずに件数を知らせる。
 * アーカイブしたら「元に戻す」付きのトーストを出す
 */
export function archiveProject(ui: ListUi, project: ProjectRow): OperationResult {
  const { store } = ui;
  const result = store.actions.updateProject(project.id, {
    archivedAt: new Date().toISOString(),
  });
  if (!result.ok) {
    if (result.reason === "has-open-tasks") {
      ui.toaster.error(
        "アーカイブできません",
        `未完了のタスクが ${store.lists.openTaskCountOfProject(project.id)} 件残っています`,
      );
    }
    return result;
  }
  ui.toaster.undoable(`「${project.name}」をアーカイブしました`, result.operationId, () =>
    undo(ui),
  );
  return result;
}

/** アーカイブを外す（アーカイブ済みのプロジェクトの画面から。サイドバーに戻る） */
export function unarchiveProject(ui: ListUi, project: ProjectRow): OperationResult {
  return ui.store.actions.updateProject(project.id, { archivedAt: null });
}
