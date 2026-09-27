/**
 * 入力の下書きを localStorage に残す（再読み込み・ログインのし直し・新しいバージョンへの切り替えでも消えないように）。
 * - 追加欄の下書き（オフラインで追加できなかった文字も、閉じても残る）
 * - 保存できずに戻ってきた追加の文字の残り（「ほかに下書き N件」）
 * - 保存できなかったタイトルとメモの文字（次にそのタスクを開くと欄に戻る）
 * - サイドバーのプロジェクトの名前の控えの列（保存できなかった作成の名前と、画面を離れるときに欄に打っていた名前。
 *   次に名前の欄を開くと、古い順に入る。features/projects/create-field.tsx）。どのタブからも同じ1つの列を使う
 *
 * タブが2つあっても、互いの分を消さないようにする：
 * - タイトルとメモは、項目ごとに別のキーにする
 * - 追加欄の下書きと戻ってきた追加の残りは、どのタブからも同じ1つを使う。書くときは、そのときの最新を読んでから
 *   足す・取る（古い中身で上書きしない）。ほかのタブが書いたら storage の知らせで追う（subscribe）
 *
 * localStorage が使えないとき・書けなかったとき（容量切れなど）は、メモリの中で持ち、`persisted` が false になる
 * （新しいバージョンへの読み込み直しは、これを見て自動では行わない）
 */

const PREFIX = "nagi:draft:";
const ADD_DRAFT_KEY = `${PREFIX}add`;
const ADD_QUEUE_KEY = `${PREFIX}add-queue`;
const UNSAVED_PREFIX = `${PREFIX}unsaved:`;
const PROJECT_NAMES_KEY = `${PREFIX}project-names`;

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function parseQueue(raw: string | null): string[] {
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

/** ほかのタブが下書きを変えたときの知らせ（key が null なら、すべて消えた） */
export type DraftChange =
  | { kind: "add"; value: string }
  | { kind: "add-queue"; value: string[] }
  | { kind: "unsaved"; key: string; value: string | null }
  | { kind: "project-names"; value: string[] }
  | { kind: "cleared" };

export class DraftStorage {
  readonly #storage: Storage | null;
  /** 書けなかった（または localStorage がない）ときの控え */
  readonly #memory = new Map<string, string>();
  /** localStorage の中身が古いキー（書くか消すのに失敗した。控えのほうを読む） */
  readonly #stale = new Set<string>();
  /** 残すべき中身が、控えにしかないキー */
  readonly #unpersisted = new Set<string>();

  constructor(storage: Storage | null = defaultStorage()) {
    this.#storage = storage;
  }

  /** 残すべき下書きが、すべて localStorage に書けているか */
  get persisted(): boolean {
    return this.#unpersisted.size === 0;
  }

  // --- 追加欄の下書き -----------------------------------------------------------------------

  loadAddDraft(): string {
    return this.#read(ADD_DRAFT_KEY) ?? "";
  }

  /** 書けたら true */
  saveAddDraft(text: string): boolean {
    return this.#write(ADD_DRAFT_KEY, text === "" ? null : text);
  }

  /**
   * 追加できたので下書きを空にする。ただし、そのあいだにほかのタブが別の文字を書いていたら、それを残して返す
   * （古い中身で、ほかのタブの下書きを消さない）
   */
  clearAddDraftIf(added: string): string {
    const latest = this.loadAddDraft();
    if (latest !== "" && latest !== added) return latest;
    this.saveAddDraft("");
    return "";
  }

  // --- 戻ってきた追加の残り -----------------------------------------------------------------

  loadAddQueue(): string[] {
    return parseQueue(this.#read(ADD_QUEUE_KEY));
  }

  saveAddQueue(titles: readonly string[]): boolean {
    return this.#write(ADD_QUEUE_KEY, titles.length === 0 ? null : JSON.stringify(titles));
  }

  /** 最新の残りの後ろに足す。足したあとの残りを返す */
  appendToAddQueue(titles: readonly string[]): string[] {
    const next = [...this.loadAddQueue(), ...titles];
    if (titles.length > 0) this.saveAddQueue(next);
    return next;
  }

  /** 最新の残りから先頭を1つ取る。取ったもの（なければ undefined）と、取ったあとの残りを返す */
  takeFromAddQueue(): { taken: string | undefined; rest: string[] } {
    const [taken, ...rest] = this.loadAddQueue();
    if (taken !== undefined) this.saveAddQueue(rest);
    return { taken, rest };
  }

  // --- プロジェクトの名前の控えの列 -----------------------------------------------------------

  /** 控えの列（まだ欄に入れていない名前。古い順） */
  loadProjectNames(): string[] {
    return parseQueue(this.#read(PROJECT_NAMES_KEY));
  }

  /** 最新の残りの後ろに足す（ほかのタブが足した分を消さない）。足したあとの残りを返す */
  appendProjectNames(names: readonly string[]): string[] {
    const next = [...this.loadProjectNames(), ...names];
    if (names.length > 0) this.#write(PROJECT_NAMES_KEY, JSON.stringify(next));
    return next;
  }

  /** 最新の残りから先頭を1つ取る。取ったもの（なければ undefined）と、取ったあとの残りを返す */
  takeProjectName(): { taken: string | undefined; rest: string[] } {
    const [taken, ...rest] = this.loadProjectNames();
    if (taken !== undefined) {
      this.#write(PROJECT_NAMES_KEY, rest.length === 0 ? null : JSON.stringify(rest));
    }
    return { taken, rest };
  }

  // --- 保存できなかったタイトルとメモ -------------------------------------------------------

  /** 保存できなかったタイトルとメモ（`<タスクの id>:<項目>` → 文字） */
  loadUnsaved(): [string, string][] {
    const entries = new Map<string, string>();
    const storage = this.#storage;
    if (storage) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key === null || !key.startsWith(UNSAVED_PREFIX)) continue;
          const value = storage.getItem(key);
          if (value !== null) entries.set(key.slice(UNSAVED_PREFIX.length), value);
        }
      } catch {
        // 読めた分だけ
      }
    }
    for (const [key, value] of this.#memory) {
      if (key.startsWith(UNSAVED_PREFIX)) entries.set(key.slice(UNSAVED_PREFIX.length), value);
    }
    return [...entries];
  }

  saveUnsaved(key: string, value: string): boolean {
    return this.#write(UNSAVED_PREFIX + key, value);
  }

  removeUnsaved(key: string): boolean {
    return this.#write(UNSAVED_PREFIX + key, null);
  }

  // --- ほかのタブ ---------------------------------------------------------------------------

  /** ほかのタブが下書きを変えたら知らせる（storage の知らせ）。戻り値を呼ぶとやめる */
  subscribe(listener: (change: DraftChange) => void, win: Window = window): () => void {
    const onStorage = (event: StorageEvent) => {
      if (this.#storage === null || event.storageArea !== this.#storage) return;
      const { key, newValue } = event;
      if (key === null) listener({ kind: "cleared" });
      else if (key === ADD_DRAFT_KEY) listener({ kind: "add", value: newValue ?? "" });
      else if (key === ADD_QUEUE_KEY) listener({ kind: "add-queue", value: parseQueue(newValue) });
      else if (key === PROJECT_NAMES_KEY) {
        listener({ kind: "project-names", value: parseQueue(newValue) });
      } else if (key.startsWith(UNSAVED_PREFIX)) {
        listener({ kind: "unsaved", key: key.slice(UNSAVED_PREFIX.length), value: newValue });
      }
    };
    win.addEventListener("storage", onStorage);
    return () => win.removeEventListener("storage", onStorage);
  }

  // --- 読み書き -----------------------------------------------------------------------------

  #read(key: string): string | null {
    // 書けなかったキーは、メモリの控えが新しい
    if (this.#storage && !this.#stale.has(key)) {
      try {
        return this.#storage.getItem(key);
      } catch {
        // 読めなければ控えを見る
      }
    }
    return this.#memory.get(key) ?? null;
  }

  /** value が null なら消す。localStorage に書けたら（消せたら）true */
  #write(key: string, value: string | null): boolean {
    if (value === null) this.#memory.delete(key);
    else this.#memory.set(key, value);
    try {
      if (!this.#storage) throw new Error("localStorage を使えません");
      if (value === null) this.#storage.removeItem(key);
      else this.#storage.setItem(key, value);
      this.#stale.delete(key);
      this.#unpersisted.delete(key);
      this.#memory.delete(key);
      return true;
    } catch (error) {
      this.#stale.add(key);
      // 消すのに失敗しても、残すべき中身はない
      if (value === null) this.#unpersisted.delete(key);
      else this.#unpersisted.add(key);
      console.error("下書きを残せませんでした", error);
      return false;
    }
  }
}
