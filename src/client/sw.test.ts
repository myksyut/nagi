import { describe, expect, it, vi } from "vitest";
import swSource from "../../public/sw.js?raw";

/**
 * チケット8：Service Worker（public/sw.js）。オフラインで開いたときに offline.html を出すためだけに使い、
 * 画面ファイルはキャッシュせず、navigate 以外のリクエストには触らない。
 * happy-dom には Service Worker の実行環境がないので、self・caches・fetch を偽物にしてハンドラーを直接呼ぶ
 */

type Handler = (event: unknown) => void;

function loadSw() {
  const handlers = new Map<string, Handler>();
  const fakeSelf = {
    addEventListener: (type: string, handler: Handler) => {
      handlers.set(type, handler);
    },
    skipWaiting: vi.fn(async () => {}),
    registration: { navigationPreload: { enable: vi.fn(async () => {}) } },
    clients: { claim: vi.fn(async () => {}) },
  };

  const cacheAdd = vi.fn(async (_request: Request) => {});
  const cacheMatch = vi.fn(
    async (_url: string, _opts?: unknown) => undefined as Response | undefined,
  );
  const fakeCache = { add: cacheAdd };
  const cachesOpen = vi.fn(async (_name: string) => fakeCache);
  const cachesKeys = vi.fn(async () => ["nagi-offline-v1", "nagi-offline-v2"]);
  const cachesDelete = vi.fn(async (_name: string) => true);
  const fakeCaches = {
    open: cachesOpen,
    keys: cachesKeys,
    delete: cachesDelete,
    match: cacheMatch,
  };

  const fakeFetch = vi.fn(async (_request: Request) => new Response("ok"));

  new Function("self", "caches", "fetch", swSource)(fakeSelf, fakeCaches, fakeFetch);

  return {
    handlers,
    fakeSelf,
    fakeCaches,
    fakeFetch,
    cacheAdd,
    cachesOpen,
    cachesKeys,
    cachesDelete,
    cacheMatch,
  };
}

function fireInstall(handlers: Map<string, Handler>): Promise<void> {
  let waited: Promise<void> = Promise.resolve();
  handlers.get("install")?.({ waitUntil: (p: Promise<unknown>) => (waited = p.then(() => {})) });
  return waited;
}

function fireActivate(handlers: Map<string, Handler>): Promise<void> {
  let waited: Promise<void> = Promise.resolve();
  handlers.get("activate")?.({ waitUntil: (p: Promise<unknown>) => (waited = p.then(() => {})) });
  return waited;
}

describe("install：offline.html だけをキャッシュする", () => {
  it("そのキャッシュに、offline.html だけを add する", async () => {
    const { handlers, cachesOpen, cacheAdd } = loadSw();
    await fireInstall(handlers);
    expect(cachesOpen).toHaveBeenCalledWith("nagi-offline-v2");
    expect(cacheAdd).toHaveBeenCalledTimes(1);
    const request = cacheAdd.mock.calls[0]?.[0] as Request;
    expect(new URL(request.url).pathname).toBe("/offline.html");
  });
});

describe("activate：古い版のキャッシュだけを消す", () => {
  it("今の版（nagi-offline-v2）以外を削除する", async () => {
    const { handlers, cachesDelete } = loadSw();
    await fireActivate(handlers);
    expect(cachesDelete).toHaveBeenCalledWith("nagi-offline-v1");
    expect(cachesDelete).not.toHaveBeenCalledWith("nagi-offline-v2");
  });
});

describe("fetch：ページを開くとき（navigate）だけを受ける", () => {
  it("navigate 以外のリクエストには respondWith しない（API や画面のファイルに触らない）", () => {
    const { handlers } = loadSw();
    const respondWith = vi.fn();
    handlers.get("fetch")?.({
      request: { mode: "cors", url: "https://example.test/api/sync" },
      respondWith,
    });
    expect(respondWith).not.toHaveBeenCalled();
  });

  it("navigate が届けば、そのまま fetch の結果を返す", async () => {
    const { handlers, fakeFetch } = loadSw();
    let responded: Promise<Response> | undefined;
    handlers.get("fetch")?.({
      request: { mode: "navigate", url: "https://example.test/today" },
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    const response = await responded;
    expect(fakeFetch).toHaveBeenCalled();
    expect(await response?.text()).toBe("ok");
  });

  it("navigate で fetch が失敗したら、キャッシュした offline.html を返す", async () => {
    const { handlers, fakeFetch, cacheMatch } = loadSw();
    fakeFetch.mockRejectedValueOnce(new Error("オフライン"));
    cacheMatch.mockResolvedValueOnce(new Response("<p>オフラインです</p>"));

    let responded: Promise<Response> | undefined;
    handlers.get("fetch")?.({
      request: { mode: "navigate", url: "https://example.test/today" },
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
    });
    const response = await responded;
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("<p>オフラインです</p>");
    expect(cacheMatch).toHaveBeenCalledWith("/offline.html", { cacheName: "nagi-offline-v2" });
  });
});

describe("fetch：offline.html の控えが消えていたら入れ直す", () => {
  it("ページを開けたときに控えがなければ add し、あれば何もしない", async () => {
    const { handlers, cacheMatch, cacheAdd } = loadSw();
    const waits: Promise<unknown>[] = [];
    const open = async () => {
      let responded: Promise<Response> | undefined;
      handlers.get("fetch")?.({
        request: { mode: "navigate", url: "https://example.test/today" },
        respondWith: (p: Promise<Response>) => {
          responded = p;
        },
        waitUntil: (p: Promise<unknown>) => waits.push(p),
      });
      await responded;
      await Promise.all(waits.splice(0));
    };

    cacheMatch.mockResolvedValueOnce(undefined);
    await open();
    expect(cacheAdd).toHaveBeenCalledTimes(1);
    expect(new URL((cacheAdd.mock.calls[0]?.[0] as Request).url).pathname).toBe("/offline.html");

    cacheMatch.mockResolvedValueOnce(new Response("<p>オフラインです</p>"));
    await open();
    expect(cacheAdd).toHaveBeenCalledTimes(1);
  });
});
