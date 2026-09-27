/**
 * 入力の下書きを localStorage に残す（再読み込み・ログインのし直し・新しいバージョンへの切り替えでも消えないように）。
 * - 追加欄の下書き（オフラインで追加できなかった文字も、閉じても残る）
 * - 保存できずに戻ってきた追加の文字の残り（「ほかに下書き N件」）
 * - 保存できなかったタイトルとメモの文字（次にそのタスクを開くと欄に戻る）
 * タイトルとメモは項目ごとに別のキーにする（タブが2つあっても、互いの分を上書きしない）。
 * localStorage が使えないとき（プライベートブラウズの容量切れなど）は、メモリの中だけで持つ
 */

const PREFIX = "nagi:draft:";
const ADD_DRAFT_KEY = `${PREFIX}add`;
const ADD_QUEUE_KEY = `${PREFIX}add-queue`;
const UNSAVED_PREFIX = `${PREFIX}unsaved:`;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class DraftStorage {
  readonly #storage: Storage | null;

  constructor(storage: Storage | null = defaultStorage()) {
    this.#storage = storage;
  }

  loadAddDraft(): string {
    return this.#get(ADD_DRAFT_KEY) ?? "";
  }

  saveAddDraft(text: string): void {
    if (text === "") this.#remove(ADD_DRAFT_KEY);
    else this.#set(ADD_DRAFT_KEY, text);
  }

  loadAddQueue(): string[] {
    const raw = this.#get(ADD_QUEUE_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  saveAddQueue(titles: readonly string[]): void {
    if (titles.length === 0) this.#remove(ADD_QUEUE_KEY);
    else this.#set(ADD_QUEUE_KEY, JSON.stringify(titles));
  }

  /** 保存できなかったタイトルとメモ（`<タスクの id>:<項目>` → 文字） */
  loadUnsaved(): [string, string][] {
    const storage = this.#storage;
    if (!storage) return [];
    const entries: [string, string][] = [];
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key === null || !key.startsWith(UNSAVED_PREFIX)) continue;
        const value = storage.getItem(key);
        if (value !== null) entries.push([key.slice(UNSAVED_PREFIX.length), value]);
      }
    } catch {
      return entries;
    }
    return entries;
  }

  saveUnsaved(key: string, value: string): void {
    this.#set(UNSAVED_PREFIX + key, value);
  }

  removeUnsaved(key: string): void {
    this.#remove(UNSAVED_PREFIX + key);
  }

  #get(key: string): string | null {
    try {
      return this.#storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  #set(key: string, value: string): void {
    try {
      this.#storage?.setItem(key, value);
    } catch (error) {
      console.error("下書きを残せませんでした", error);
    }
  }

  #remove(key: string): void {
    try {
      this.#storage?.removeItem(key);
    } catch {
      // 消せなくても、次に保存できたときに上書きされる
    }
  }
}
