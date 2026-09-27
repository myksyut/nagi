/*
 * nagi の Service Worker。オフラインで開いたときに offline.html（「オフラインです」）を出すためだけに使う。
 * キャッシュに置くのは offline.html だけ。画面のファイル（HTML・JS・CSS）はキャッシュしない
 * （新しい版がすぐ届くように。技術計画「最初の表示を速くする」）。
 * offline.html を変えたら CACHE の番号を上げる（古い控えは activate で消える）
 */
const CACHE = "nagi-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
      // ページを開くときの通信を、Service Worker の起動と並べて始める（起動を待たせない）
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  // ページを開くとき（アドレスバー・再読み込み）だけを受ける。API や画面のファイルには触らない
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        return offlineResponse();
      }
    })(),
  );
});

async function offlineResponse() {
  const cached = await caches.match(OFFLINE_URL, { cacheName: CACHE });
  if (!cached) return Response.error();
  // 控えがリダイレクトの結果でも、ページを開く応答として使えるように作り直す
  return new Response(await cached.blob(), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
