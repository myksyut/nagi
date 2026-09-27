import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { createAppStore, StoreProvider } from "./data";
import { registerServiceWorker } from "./service-worker";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root が見つかりません");

// 手元の控えの読み込みは、描画より先に始める。ログイン画面では同期しない
const store = createAppStore();
if (window.location.pathname !== "/login") void store.start();

createRoot(root).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);

// オフラインで開いたときに「オフラインです」を出すためだけの Service Worker
registerServiceWorker();
