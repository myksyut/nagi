import type { ChecklistItem } from "@shared/model";
import { makeObservable, observable, runInAction } from "mobx";
import type { AppStore, Notice } from "@/data";

/**
 * チェックリストの計算（純粋な関数）と、保存できなかった文字の置き場。
 * チェックリストはタスクの1つの項目（配列）なので、どの操作も「今の配列から次の配列を作って、まるごと送る」
 */

/** 進み具合（行の右側の 2/4） */
export function checklistProgress(items: readonly ChecklistItem[]): {
  done: number;
  total: number;
} {
  return { done: items.filter((item) => item.done).length, total: items.length };
}

export function toggleItem(items: readonly ChecklistItem[], id: string): ChecklistItem[] {
  return items.map((item) => (item.id === id ? { ...item, done: !item.done } : item));
}

export function renameItem(
  items: readonly ChecklistItem[],
  id: string,
  title: string,
): ChecklistItem[] {
  return items.map((item) => (item.id === id ? { ...item, title } : item));
}

export function removeItem(items: readonly ChecklistItem[], id: string): ChecklistItem[] {
  return items.filter((item) => item.id !== id);
}

/** 1つ上（delta = -1）か下（+1）へ動かす。端なら動かさない（同じ並びを返す） */
export function moveItem(
  items: readonly ChecklistItem[],
  id: string,
  delta: -1 | 1,
): ChecklistItem[] {
  const index = items.findIndex((item) => item.id === id);
  const to = index + delta;
  const moving = items[index];
  if (index < 0 || to < 0 || to >= items.length || !moving) return [...items];
  const next = items.filter((item) => item.id !== id);
  next.splice(to, 0, moving);
  return next;
}

/** ids の順に並べる（ids にない項目は、今の順のまま後ろに付ける。ドラッグのあいだに足された項目など） */
export function orderItems(
  items: readonly ChecklistItem[],
  ids: readonly string[],
): ChecklistItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered = ids.flatMap((id) => {
    const item = byId.get(id);
    return item ? [item] : [];
  });
  const placed = new Set(ids);
  return [...ordered, ...items.filter((item) => !placed.has(item.id))];
}

export function sameOrder(a: readonly ChecklistItem[], b: readonly ChecklistItem[]): boolean {
  return a.length === b.length && a.every((item, i) => item.id === b[i]?.id);
}

function titleKey(taskId: string, itemId: string): string {
  return `${taskId}:${itemId}`;
}

/**
 * 保存できなかったチェックリストの文字（Core Flows の「追加や文字の編集は、入力内容を消さずに残す」）。
 * - 直した項目の名前：次にその項目を描いたとき（開いているならすぐ）欄に戻し、次の保存で送り直す
 * - 足した項目：そのタスクの「項目を追加」の欄の下書きに戻す（空なら1つ目を入れ、残りは足すたびに順に）
 * 追加の欄の下書きは、タスクを閉じても残す。ストアごとに1つ（checklistDraftsOf）
 */
export class ChecklistDrafts {
  readonly #titles = observable.map<string, string>();
  readonly #addDrafts = observable.map<string, string>();
  readonly #addQueues = new Map<string, string[]>();

  constructor(store: AppStore) {
    makeObservable<ChecklistDrafts, "restore">(this, { restore: true });
    store.subscribe((notice) => this.#onNotice(store, notice));
  }

  unsavedTitle(taskId: string, itemId: string): string | undefined {
    return this.#titles.get(titleKey(taskId, itemId));
  }

  keepUnsavedTitle(taskId: string, itemId: string, title: string): void {
    runInAction(() => this.#titles.set(titleKey(taskId, itemId), title));
  }

  clearUnsavedTitle(taskId: string, itemId: string): void {
    runInAction(() => this.#titles.delete(titleKey(taskId, itemId)));
  }

  addDraft(taskId: string): string {
    return this.#addDrafts.get(taskId) ?? "";
  }

  setAddDraft(taskId: string, text: string): void {
    runInAction(() => {
      if (text === "") this.#addDrafts.delete(taskId);
      else this.#addDrafts.set(taskId, text);
    });
  }

  /** 足せた。下書きを空にし、戻ってきた文字の残りがあれば次を入れる */
  noteAdded(taskId: string): void {
    this.setAddDraft(taskId, this.#addQueues.get(taskId)?.shift() ?? "");
  }

  protected restore(taskId: string, lost: readonly ChecklistItem[], now: readonly ChecklistItem[]) {
    const current = new Map(now.map((item) => [item.id, item]));
    for (const item of lost) {
      const kept = current.get(item.id);
      if (kept === undefined) {
        if (item.title.trim() === "") continue;
        const queue = this.#addQueues.get(taskId) ?? [];
        queue.push(item.title);
        this.#addQueues.set(taskId, queue);
      } else if (kept.title !== item.title) {
        this.#titles.set(titleKey(taskId, item.id), item.title);
      }
    }
    if (this.addDraft(taskId).trim() === "") {
      const next = this.#addQueues.get(taskId)?.shift();
      if (next !== undefined) this.#addDrafts.set(taskId, next);
    }
  }

  /** 捨てられた操作の、タスクごとの最後のチェックリストを、今の表示と比べて取り戻す */
  #onNotice(store: AppStore, notice: Notice): void {
    if (notice.type !== "save-failed") return;
    const lost = new Map<string, readonly ChecklistItem[]>();
    for (const operation of notice.discarded) {
      for (const mutation of operation.mutations) {
        if (mutation.type === "task.update" && mutation.changes.checklist) {
          lost.set(mutation.id, mutation.changes.checklist);
        }
      }
    }
    for (const [taskId, items] of lost) {
      this.restore(taskId, items, store.task(taskId)?.peek().checklist ?? []);
    }
  }
}

const draftsByStore = new WeakMap<AppStore, ChecklistDrafts>();

export function checklistDraftsOf(store: AppStore): ChecklistDrafts {
  let drafts = draftsByStore.get(store);
  if (!drafts) {
    drafts = new ChecklistDrafts(store);
    draftsByStore.set(store, drafts);
  }
  return drafts;
}
