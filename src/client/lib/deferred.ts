import { useEffect, useSyncExternalStore } from "react";

/**
 * 後から読み込むモジュール（⌘K、`?` の一覧、完了ログ、日付の入力のカレンダー、p の候補、border-beam など）。
 * 起動に要らないコードを最初の JS から外し、起動のあとの空いた時間にまとめて先読みする（preloadDeferredWhenIdle）。
 * 先読みが済んでいれば、使うときに待たずに描ける（読み込み済みのモジュールはそのまま返す）。
 * 先読みの前に使われたときは、その場で読み込みを始め、届いたら描き直す。
 * 先読みで届いたときも、使っている部品を描き直す（⌘K などは、閉じたまま先に組み立てておける）
 */
export type Deferred<T> = {
  /** 読み込み済みならモジュール、まだなら undefined */
  readonly current: T | undefined;
  /** 読み込む（何度呼んでも1回だけ。失敗したら、次に呼んだときにもう一度読む） */
  load(): Promise<T>;
  /** 読み込み終えたときに呼ぶ。戻り値を呼ぶとやめる */
  subscribe(listener: () => void): () => void;
};

const registry: Deferred<unknown>[] = [];

/** 後から読み込むモジュールを登録する。importer には `() => import("…")` を渡す（Vite がここで分ける） */
export function defer<T>(importer: () => Promise<T>): Deferred<T> {
  let current: T | undefined;
  let loading: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const deferred: Deferred<T> = {
    get current() {
      return current;
    },
    load() {
      loading ??= importer().then(
        (module) => {
          current = module;
          for (const listener of listeners) listener();
          return module;
        },
        (error: unknown) => {
          loading = null;
          throw error;
        },
      );
      return loading;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  registry.push(deferred);
  return deferred;
}

/** 登録したモジュールをすべて読み込む（読み込めなかったものは、使うときにもう一度読む） */
export async function preloadDeferred(): Promise<void> {
  const results = await Promise.allSettled(registry.map((deferred) => deferred.load()));
  for (const result of results) {
    if (result.status !== "rejected") continue;
    console.error("後から読み込む部品を読めませんでした", result.reason);
  }
}

/** 空いた時間を待ちきれないときの上限（ミリ秒） */
const IDLE_TIMEOUT_MS = 1500;

/**
 * 起動のあとの空いた時間に、すべて先読みする。最初のキー操作で読み込みを待たせないため。
 * requestIdleCallback のない Safari では、少し遅らせて読む。戻り値を呼ぶと、まだ始めていなければやめる
 */
export function preloadDeferredWhenIdle(win: Window = window): () => void {
  if (typeof win.requestIdleCallback === "function") {
    const handle = win.requestIdleCallback(() => void preloadDeferred(), {
      timeout: IDLE_TIMEOUT_MS,
    });
    return () => win.cancelIdleCallback(handle);
  }
  const timer = win.setTimeout(() => void preloadDeferred(), 200);
  return () => win.clearTimeout(timer);
}

/**
 * 部品の中で使う。読み込み済みならそのモジュールを返す（先読みで届いたときも描き直す）。
 * needed のときにまだ読み込んでいなければ、読み込みを始める（届くまでは undefined）
 */
export function useDeferred<T>(deferred: Deferred<T>, needed = true): T | undefined {
  const current = useSyncExternalStore(
    deferred.subscribe,
    () => deferred.current,
    () => deferred.current,
  );
  const missing = needed && current === undefined;
  useEffect(() => {
    if (!missing) return;
    deferred.load().catch((error: unknown) => console.error("部品を読み込めませんでした", error));
  }, [deferred, missing]);
  return current;
}
