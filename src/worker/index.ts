import { Hono } from "hono";
import { requireSession } from "./auth/middleware";
import { authRoutes } from "./auth/routes";
import { requireSameOriginJson } from "./request-guard";
import { createSyncRoutes, type SyncRoutesOptions } from "./sync/routes";
import type { AppEnv } from "./types";

/**
 * Worker が受けるのは /api/* と /auth/* だけ（wrangler.jsonc の run_worker_first）。
 * それ以外は静的配信が画面ファイルを返す。画面ファイル自体はログインなしで配信する。
 * テストでは現在時刻（now）を差し替えたアプリを作れる
 */
export function createApp({ now = () => new Date() }: Partial<SyncRoutesOptions> = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", requireSameOriginJson);
  app.route("/auth", authRoutes);

  app.use("/api/*", requireSession);
  /** ログインしているかを確かめるためだけの口 */
  app.get("/api/session", (c) => c.json({ authenticated: true }));
  app.route("/api", createSyncRoutes({ now }));

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

export default createApp();
