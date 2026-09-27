/**
 * Service Worker（public/sw.js）を登録する。オフラインで開いたときに offline.html を出すためだけに使い、
 * 画面のファイルはキャッシュしない。開発サーバーでは登録しない（Vite の読み込みの邪魔をしないように）。
 * 起動の読み込みと取り合わないよう、ページの読み込みが終わってから登録する
 */
export function registerServiceWorker(win: Window = window): void {
  if (!import.meta.env.PROD || !("serviceWorker" in win.navigator)) return;
  const register = () => {
    win.navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Service Worker を登録できませんでした", error);
    });
  };
  if (win.document.readyState === "complete") register();
  else win.addEventListener("load", register, { once: true });
}
