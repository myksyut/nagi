import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { ApiErrorResponse } from "../shared/api";
import { accountRoutes } from "./account/routes";
import { requireSession } from "./auth/middleware";
import { authRoutes } from "./auth/routes";
import { sweepExpiredSessions } from "./auth/session";
import { getDb } from "./db/client";
import { limitByIp, limitByUser } from "./rate-limit";
import { requireSameOriginJson } from "./request-guard";
import { createSyncRoutes, type SyncRoutesOptions } from "./sync/routes";
import type { AppEnv } from "./types";

const KIB = 1024;
/** 本文の上限。/api/* は同期の 1 まとまり（500 操作）が収まる大きさ、/auth/* は小さな JSON だけ */
const API_BODY_LIMIT = 1024 * KIB;
const AUTH_BODY_LIMIT = 4 * KIB;

const payloadTooLarge = (maxSize: number) =>
  bodyLimit({
    maxSize,
    onError: (c) => c.json({ error: "payload_too_large" } satisfies ApiErrorResponse, 413),
  });

/**
 * Worker がすべてのリクエストを受ける（画面のファイルは配らない。クライアントは TUI）。
 * - /auth/*：ログイン（GitHub のデバイスフロー）とログアウト
 * - /api/*：同期の API と、アカウントの削除・書き出し。`Authorization: Bearer <token>` のセッションが要る
 * - それ以外の URL：404 の JSON
 * どの応答にも、セキュリティのヘッダを付ける。/api/* と /auth/* の応答は、キャッシュさせない（no-store）。
 * 本文の大きさ（/api/* は 1 MiB、/auth/* は 4 KiB まで）と回数は、ここで制限する
 * テストでは現在時刻（now）を差し替えたアプリを作れる
 */
export function createApp({ now = () => new Date() }: Partial<SyncRoutesOptions> = {}) {
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  for (const path of ["/api/*", "/auth/*"]) {
    app.use(path, async (c, next) => {
      await next();
      c.header("Cache-Control", "no-store");
    });
  }
  app.use("/api/*", payloadTooLarge(API_BODY_LIMIT));
  app.use("/auth/*", payloadTooLarge(AUTH_BODY_LIMIT));
  app.use("*", requireSameOriginJson);

  app.on("POST", "/auth/device/start", limitByIp("AUTH_START_LIMITER"));
  app.on("POST", ["/auth/device/token", "/auth/logout"], limitByIp("AUTH_POLL_LIMITER"));
  app.route("/auth", authRoutes);

  app.use("/api/*", requireSession);
  app.use("/api/*", limitByUser("API_LIMITER"));
  /** ログインしているかと、だれとしてかを確かめる口（userId は users.id。画面が、手元の複製の持ち主を見分けるのに使う） */
  app.get("/api/session", (c) => c.json({ authenticated: true, userId: c.get("userId") }));
  app.route("/api", createSyncRoutes({ now }));
  app.route("/api", accountRoutes);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    console.error(error);
    return c.json({ error: "internal_error" }, 500);
  });
  return app;
}

/**
 * 既定の出力は fetch と scheduled を持つ。アプリ自体に scheduled を足すので、テストはそのまま
 * `.request()` でも呼べる
 */
export default Object.assign(createApp(), {
  /** cron（wrangler.jsonc の triggers.crons）で、期限切れのセッションを消す */
  scheduled(controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepExpiredSessions(getDb(env.DB), new Date(controller.scheduledTime)));
  },
}) satisfies ExportedHandler<Cloudflare.Env>;
