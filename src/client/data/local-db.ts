import type { Project, SyncRow, Task } from "@shared/model";

/**
 * 手元の控え（IndexedDB）。保存するのは確定データ（タスクとプロジェクト）とカーソルだけで、
 * 送信中の操作は保存しない。タブどうしで共有するので、行は seq が新しいときだけ上書きする
 * （古いタブが新しい行を巻き戻さないように）
 */

export type LocalSnapshot = { tasks: Task[]; projects: Project[]; cursor: number };

export interface LocalDb {
  /** 保存してある確定データとカーソルを、同じ時点の中身として読む */
  load(): Promise<LocalSnapshot>;
  /**
   * 行を書く。手元より seq が新しい行だけを上書きする。
   * cursor を渡したら、保存済みのカーソルより大きいときだけ進める（行と同じトランザクションで）
   */
  putRows(rows: readonly SyncRow[], cursor?: number): Promise<void>;
  /** 手元を捨てて、rows と cursor に置き換える（差分の取得で reset が来たとき） */
  replaceAll(rows: readonly SyncRow[], cursor: number): Promise<void>;
  /** deletedBefore（ISO 8601）より前に削除された行を捨てる */
  purgeDeleted(deletedBefore: string): Promise<void>;
  close(): void;
}

export const LOCAL_DB_NAME = "nagi";
/**
 * 保存形式の版。形を変えたら上げる。版が変わると、開いたときに手元のデータを捨てて作り直し、
 * カーソル 0 から取り直す
 */
export const LOCAL_DB_VERSION = 1;

const TASKS = "tasks";
const PROJECTS = "projects";
const META = "meta";
const DELETED_AT_INDEX = "deletedAt";
const CURSOR_KEY = "cursor";

function storeNameOf(kind: SyncRow["kind"]): string {
  return kind === "task" ? TASKS : PROJECTS;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("transaction aborted"));
  });
}

/** 保存形式を作り直す。前の版の中身はすべて捨てる */
function recreateStores(db: IDBDatabase): void {
  for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
  // 削除済みの行だけが deletedAt の索引に入る（null は索引の鍵にならない）
  db.createObjectStore(TASKS, { keyPath: "id" }).createIndex(DELETED_AT_INDEX, "deletedAt");
  db.createObjectStore(PROJECTS, { keyPath: "id" }).createIndex(DELETED_AT_INDEX, "deletedAt");
  db.createObjectStore(META);
}

/** 行を seq が新しいときだけ書く（同じトランザクションの中で読んでから書く） */
function putIfNewer(store: IDBObjectStore, row: Task | Project): void {
  const read = store.get(row.id);
  read.onsuccess = () => {
    const current = read.result as { seq: number } | undefined;
    if (current === undefined || current.seq < row.seq) store.put(row);
  };
}

class IndexedLocalDb implements LocalDb {
  #db: IDBDatabase | null;
  /** 書き込みは呼んだ順に1つずつ流す（reset の置き換えと、その前の書き込みが入れ替わらないように） */
  #writes: Promise<void> = Promise.resolve();

  constructor(db: IDBDatabase) {
    this.#db = db;
    // ほかのタブが新しい版で開こうとしたら閉じて譲る。このタブは、以後は手元に保存しない
    db.onversionchange = () => this.close();
  }

  async load(): Promise<LocalSnapshot> {
    const db = this.#db;
    if (!db) return { tasks: [], projects: [], cursor: 0 };
    const transaction = db.transaction([TASKS, PROJECTS, META], "readonly");
    const [tasks, projects, cursor] = await Promise.all([
      requestToPromise(transaction.objectStore(TASKS).getAll()),
      requestToPromise(transaction.objectStore(PROJECTS).getAll()),
      requestToPromise(transaction.objectStore(META).get(CURSOR_KEY)),
    ]);
    return {
      tasks: tasks as Task[],
      projects: projects as Project[],
      cursor: typeof cursor === "number" ? cursor : 0,
    };
  }

  putRows(rows: readonly SyncRow[], cursor?: number): Promise<void> {
    return this.#write((db) => {
      const transaction = db.transaction([TASKS, PROJECTS, META], "readwrite");
      for (const { kind, row } of rows) putIfNewer(transaction.objectStore(storeNameOf(kind)), row);
      if (cursor !== undefined) {
        const meta = transaction.objectStore(META);
        const read = meta.get(CURSOR_KEY);
        read.onsuccess = () => {
          const saved = typeof read.result === "number" ? read.result : 0;
          if (cursor > saved) meta.put(cursor, CURSOR_KEY);
        };
      }
      return transactionDone(transaction);
    });
  }

  replaceAll(rows: readonly SyncRow[], cursor: number): Promise<void> {
    return this.#write((db) => {
      const transaction = db.transaction([TASKS, PROJECTS, META], "readwrite");
      const tasks = transaction.objectStore(TASKS);
      const projects = transaction.objectStore(PROJECTS);
      tasks.clear();
      projects.clear();
      for (const { kind, row } of rows) (kind === "task" ? tasks : projects).put(row);
      transaction.objectStore(META).put(cursor, CURSOR_KEY);
      return transactionDone(transaction);
    });
  }

  purgeDeleted(deletedBefore: string): Promise<void> {
    return this.#write((db) => {
      const transaction = db.transaction([TASKS, PROJECTS], "readwrite");
      for (const name of [TASKS, PROJECTS]) {
        const range = IDBKeyRange.upperBound(deletedBefore, true);
        const request = transaction.objectStore(name).index(DELETED_AT_INDEX).openCursor(range);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          cursor.delete();
          cursor.continue();
        };
      }
      return transactionDone(transaction);
    });
  }

  close(): void {
    this.#db?.close();
    this.#db = null;
  }

  #write(run: (db: IDBDatabase) => Promise<void>): Promise<void> {
    const next = this.#writes.then(() => (this.#db ? run(this.#db) : undefined));
    // 失敗しても後ろの書き込みは続ける（呼んだ側には失敗を返す）
    this.#writes = next.catch(() => {});
    return next;
  }
}

/** IndexedDB が使えないときの代わり（保存しない。起動のたびにカーソル 0 から取る） */
export function createMemoryLocalDb(): LocalDb {
  return {
    load: async () => ({ tasks: [], projects: [], cursor: 0 }),
    putRows: async () => {},
    replaceAll: async () => {},
    purgeDeleted: async () => {},
    close: () => {},
  };
}

export type OpenLocalDbOptions = {
  name?: string;
  /** 保存形式の版（テストで切り替えを確かめるときに渡す） */
  version?: number;
  indexedDB?: IDBFactory;
};

/**
 * 手元の控えを開く。保存してある版が違えば、中身を捨てて作り直す。
 * IndexedDB が使えない・開けない（新しい版のタブがすでに開いたなど）ときは、保存しない代わりを返す
 */
export async function openLocalDb({
  name = LOCAL_DB_NAME,
  version = LOCAL_DB_VERSION,
  indexedDB: factory = globalThis.indexedDB,
}: OpenLocalDbOptions = {}): Promise<LocalDb> {
  if (!factory) return createMemoryLocalDb();
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, version);
      request.onupgradeneeded = () => recreateStores(request.result);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new IndexedLocalDb(db);
  } catch (error) {
    console.warn("手元の控え（IndexedDB）を開けないため、保存せずに動きます", error);
    return createMemoryLocalDb();
  }
}
