import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { clearSessionCookie, setSessionCookie } from "./cookies";
import { SESSION_COOKIE, validateSession } from "./session";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 手元の開発でログインを外すか。AUTH_DISABLED が "true" で、かつ localhost へのリクエストのときだけ。
 * 本番の URL（workers.dev）には、AUTH_DISABLED があっても効かない
 */
export function isAuthDisabled(env: Pick<Cloudflare.Env, "AUTH_DISABLED">, url: string): boolean {
  return env.AUTH_DISABLED === "true" && LOCAL_HOSTNAMES.has(new URL(url).hostname);
}

/** セッションがなければ 401。有効なら、1 日 1 回まで有効期限を延ばして Cookie も出し直す */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (isAuthDisabled(c.env, c.req.url)) return next();

  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const session = await validateSession(getDb(c.env.DB), token, new Date());
  if (!session) {
    clearSessionCookie(c);
    return c.json({ error: "unauthorized" }, 401);
  }
  if (session.extended) setSessionCookie(c, token, session.expiresAt);
  return next();
});
