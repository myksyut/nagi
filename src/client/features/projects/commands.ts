import { reaction } from "mobx";
import type { AppStore, Notice, OperationResult, ProjectRow } from "@/data";
import { runTaskOperation, toastSubject, undo } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import { projectNameDraftsOf } from "./name-drafts";

/**
 * プロジェクトの操作（p の候補・開いたタスクのボタン・プロジェクトの画面の見出しから呼ぶ）。
 * タスクに付ける操作は runTaskOperation を通すので、プロジェクトの画面から行が抜けたときは
 * 選択が次の行へ移り、「元に戻す」のトーストが出る
 */

/** 名前の比べ方：全角と半角、大文字と小文字を区別しない */
export function normalizeName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
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
    toast: (left, changed) => {
      const subject = toastSubject(ui, left, changed);
      if (subject === undefined) return undefined;
      const name = projectId === null ? undefined : ui.store.project(projectId)?.name;
      return name === undefined
        ? `${subject}のプロジェクトを外しました`
        : `${subject}を「${name}」へ`;
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
    toast: (left, changed) => {
      const subject = toastSubject(ui, left, changed);
      return subject === undefined ? undefined : `${subject}を「${name.trim()}」へ`;
    },
  });
}

/**
 * 名前を変える。空の名前は受け付けない（元の名前のまま）。
 * 送ったあとに保存できなかったときは、打った名前をプロジェクトごとの下書きに残す（projectNameDraftsOf）
 */
export function renameProject(ui: ListUi, project: ProjectRow, name: string): OperationResult {
  const drafts = projectNameDraftsOf(ui.store);
  const result = ui.store.actions.updateProject(project.id, { name });
  if (result.ok || result.reason === "noop") drafts.clear(project.id);
  return result;
}

/**
 * その操作が保存できなかったとき（送ったあとに捨てられたとき）に、知らせの理由を渡して呼ぶ。
 * 保存できたら何もしない（送信の列から外れたら、見張るのをやめる）
 */
function whenDiscarded(
  store: AppStore,
  operationId: string,
  callback: (reason: Extract<Notice, { type: "save-failed" }>["reason"]) => void,
): void {
  const off = store.subscribe((notice) => {
    if (notice.type !== "save-failed") return;
    if (!notice.discarded.some((operation) => operation.operationId === operationId)) return;
    stop();
    callback(notice.reason);
  });
  const stop = () => {
    off();
    stopWatching();
  };
  const stopWatching = reaction(
    () => store.replica.pending.some((batch) => batch.operationId === operationId),
    (pending) => {
      // 捨てられたときの知らせは、送信の列から外れた直後に届くので、それを待ってからやめる
      if (!pending) queueMicrotask(stop);
    },
  );
}

/**
 * アーカイブする（サイドバーから隠す）。未完了のタスクが残っていたら、アーカイブせずに件数を知らせる。
 * アーカイブしたら「元に戻す」付きのトーストを出す。画面はすぐ今日へ移る（呼ぶ側）。
 * ほかの画面が直前にタスクを付けていてサーバーが断ったときは、最新を取り直してから、
 * アーカイブできなかったことと残りの件数を知らせる（プロジェクトはサイドバーに戻る）
 */
export function archiveProject(ui: ListUi, project: ProjectRow): OperationResult {
  const { store } = ui;
  const { id, name } = project;
  const result = store.actions.updateProject(id, { archivedAt: new Date().toISOString() });
  if (!result.ok) {
    if (result.reason === "has-open-tasks") {
      ui.toaster.error(
        "アーカイブできません",
        `未完了のタスクが ${store.lists.openTaskCountOfProject(id)} 件残っています`,
      );
    }
    return result;
  }
  ui.toaster.undoable(`「${name}」をアーカイブしました`, result.operationId, () => undo(ui));
  whenDiscarded(store, result.operationId, (reason) => {
    if (reason !== "conflict") return;
    void store.sync().then(() => {
      ui.toaster.error(
        `「${name}」をアーカイブできませんでした`,
        `未完了のタスクが ${store.lists.openTaskCountOfProject(id)} 件残っています`,
      );
    });
  });
  return result;
}

/** アーカイブを外す（アーカイブ済みのプロジェクトの画面から。サイドバーに戻る） */
export function unarchiveProject(ui: ListUi, project: ProjectRow): OperationResult {
  return ui.store.actions.updateProject(project.id, { archivedAt: null });
}
