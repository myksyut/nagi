import { observable, runInAction } from "mobx";
import type { AppStore } from "@/data";

/**
 * 保存できなかったプロジェクトの名前（Core Flows の「文字の編集は、入力内容を消さずに残す」）。
 * 送ったあとに捨てられた名前の変更を、プロジェクトの ID ごとに残し、次に名前を変えるときに欄へ入れる。
 * ストアごとに1つ（projectNameDraftsOf）。名前を変える欄を初めて開いたときから知らせを受ける
 */
export class ProjectNameDrafts {
  readonly #names = observable.map<string, string>();

  constructor(store: AppStore) {
    store.subscribe((notice) => {
      if (notice.type !== "save-failed") return;
      runInAction(() => {
        for (const operation of notice.discarded) {
          for (const mutation of operation.mutations) {
            if (mutation.type === "project.update" && mutation.changes.name !== undefined) {
              this.#names.set(mutation.id, mutation.changes.name);
            }
          }
        }
      });
    });
  }

  get(projectId: string): string | undefined {
    return this.#names.get(projectId);
  }

  keep(projectId: string, name: string): void {
    runInAction(() => this.#names.set(projectId, name));
  }

  clear(projectId: string): void {
    runInAction(() => this.#names.delete(projectId));
  }
}

const draftsByStore = new WeakMap<AppStore, ProjectNameDrafts>();

export function projectNameDraftsOf(store: AppStore): ProjectNameDrafts {
  let drafts = draftsByStore.get(store);
  if (!drafts) {
    drafts = new ProjectNameDrafts(store);
    draftsByStore.set(store, drafts);
  }
  return drafts;
}
