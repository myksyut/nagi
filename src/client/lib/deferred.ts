import { useEffect, useSyncExternalStore } from "react";

/**
 * 後から読み込むモジュール（⌘K、`?` の一覧、完了ログ、日付の入力のカレンダー、p の候補、チェックリストの編集、
 * border-beam、Motion の機能）。起動に要らないコードを最初の JS から外し、起動のあとの空いた時間にまとめて先読みする
 * （startDeferredLoading）。先読みが済んでいれば、使うときに待たずに描ける（読み込み済みのモジュールはそのまま返す）。
 * 先読みの前に使われたときは、その場で読み込みを始め、届いたら描き直す。
 * 読み込めなかったときは failed になり、使う側が「読み込めませんでした・もう一度」を出して読み直せる。
 * 開き直したとき（useDeferred の retryKey）と、つながり直したとき（online）にも読み直す
 */

/** 読み込みの状態（変わるたびに別のオブジェクトにする） */
export type DeferredState<T> = {
  /** 読み込み済みならモジュール、まだなら undefined */
  readonly module: T | undefined;
  /** 最後の読み込みが失敗した（読み直しを始めると false に戻る） */
  readonly failed: boolean;
};

export type Deferred<T> = {
  readonly state: DeferredState<T>;
  /** 読み込み済みならモジュール、まだなら undefined */
  readonly current: T | undefined;
  /** 読み込む（読み込み中なら同じものを返す。失敗したあとに呼ぶと、読み直す） */
  load(): Promise<T>;
  /** 状態が変わったときに呼ぶ。戻り値を呼ぶとやめる */
  subscribe(listener: () => void): () => void;
};

const registry: Deferred<unknown>[] = [];

/** 後から読み込むモジュールを登録する。importer には `() => import("…")` を渡す（Vite がここで分ける） */
export function defer<T>(importer: () => Promise<T>): Deferred<T> {
  let state: DeferredState<T> = { module: undefined, failed: false };
  let loading: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const set = (next: DeferredState<T>) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const deferred: Deferred<T> = {
    get state() {
      return state;
    },
    get current() {
      return state.module;
    },
    load() {
      if (state.module !== undefined) return Promise.resolve(state.module);
      if (loading) return loading;
      if (state.failed) set({ module: undefined, failed: false });
      loading = importer().then(
        (module) => {
          loading = null;
          set({ module, failed: false });
          return module;
        },
        (error: unknown) => {
          loading = null;
          set({ module: undefined, failed: true });
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

/** 登録したモジュールをすべて読み込む（読み込めなかったものは、使うときやつながり直したときにもう一度読む） */
export async function preloadDeferred(): Promise<void> {
  const results = await Promise.allSettled(registry.map((deferred) => deferred.load()));
  for (const result of results) {
    if (result.status !== "rejected") continue;
    console.error("後から読み込む部品を読めませんでした", result.reason);
  }
}

/** 読み込めなかったものだけを、もう一度読む */
function retryFailed(): void {
  for (const deferred of registry) {
    if (deferred.state.failed) deferred.load().catch(() => {});
  }
}

/** 空いた時間を待ちきれないときの上限（ミリ秒） */
const IDLE_TIMEOUT_MS = 1500;

/**
 * 起動のあとの空いた時間に、すべて先読みする（最初のキー操作で読み込みを待たせないため。
 * requestIdleCallback のない Safari では少し遅らせて読む）。つながり直したら、読み込めなかったものを読み直す。
 * 戻り値を呼ぶとやめる
 */
export function startDeferredLoading(win: Window = window): () => void {
  const preload = () => void preloadDeferred();
  let cancel: () => void;
  const { requestIdleCallback, cancelIdleCallback } = win;
  if (typeof requestIdleCallback === "function" && typeof cancelIdleCallback === "function") {
    const handle = requestIdleCallback.call(win, preload, { timeout: IDLE_TIMEOUT_MS });
    cancel = () => cancelIdleCallback.call(win, handle);
  } else {
    const timer = win.setTimeout(preload, 200);
    cancel = () => win.clearTimeout(timer);
  }
  win.addEventListener("online", retryFailed);
  return () => {
    cancel();
    win.removeEventListener("online", retryFailed);
  };
}

/**
 * 読み込めるまで読み直す（失敗したら、つながり直したときか、間を空けて）。読み込めるまで待つ Promise を返す。
 * 読み直しの道を持たない受け手（Motion の LazyMotion）に渡す
 */
export function loadUntilLoaded<T>(deferred: Deferred<T>, win: Window = window): Promise<T> {
  return new Promise((resolve) => {
    const attempt = (delay: number) => {
      deferred.load().then(resolve, () => {
        const again = () => {
          win.clearTimeout(timer);
          win.removeEventListener("online", again);
          attempt(Math.min(delay * 2, 30_000));
        };
        const timer = win.setTimeout(again, delay);
        win.addEventListener("online", again);
      });
    };
    attempt(2000);
  });
}

export type DeferredView<T> = DeferredState<T> & {
  /** 読み直す（「もう一度」のボタンから） */
  retry: () => void;
};

function loadAndReport<T>(deferred: Deferred<T>): void {
  deferred.load().catch((error: unknown) => console.error("部品を読み込めませんでした", error));
}

/**
 * 部品の中で使う。読み込み済みならそのモジュールを返す（先読みで届いたときも描き直す）。
 * needed のときにまだ読み込んでいなければ、読み込みを始める（届くまでは module が undefined）。
 * 失敗していれば failed が true になる。needed が立ち直したときと、retryKey が変わったとき（開き直したとき）は読み直す
 */
export function useDeferred<T>(
  deferred: Deferred<T>,
  needed = true,
  retryKey?: unknown,
): DeferredView<T> {
  const state = useSyncExternalStore(
    deferred.subscribe,
    () => deferred.state,
    () => deferred.state,
  );
  const missing = needed && state.module === undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: retryKey は、開き直したときに読み直すためだけに使う
  useEffect(() => {
    if (missing) loadAndReport(deferred);
  }, [deferred, missing, retryKey]);
  return { ...state, retry: () => loadAndReport(deferred) };
}
