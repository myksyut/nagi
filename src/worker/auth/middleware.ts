import { createMiddleware } from "hono/factory";
import { getDb } from "../db/client";
import { OWNER_USER_ID } from "../db/schema";
import type { AppEnv } from "../types";
import { readBearerToken } from "./bearer";
import { deleteSession, validateSession } from "./session";
import { mayUse, readSignupPolicy } from "./users";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 手元の開発でログインを外すか。AUTH_DISABLED が "true" で、かつ localhost へのリクエストのときだけ。
 * 本番の URL（workers.dev）には、AUTH_DISABLED があっても効かない。
 * 外したときは、OWNER_USER_ID の利用者として扱う
 */
export function isAuthDisabled(env: Pick<Cloudflare.Env, "AUTH_DISABLED">, url: string): boolean {
  return env.AUTH_DISABLED === "true" && LOCAL_HOSTNAMES.has(new URL(url).hostname);
}

/**
 * `Authorization: Bearer <token>` のセッションがなければ 401（Cookie は見ない）。
 * 有効なら、1 日 1 回まで有効期限を延ばし（validateSession）、セッションの持ち主を userId に入れる
 * （このあとの処理は、その利用者の行だけを扱う）。
 * 持ち主が、いまの設定ではログインできない人（許可から外した人）なら、そのセッションを消して 401。
 * だれがログインできるかの設定が正しくなければ、だれも通さない（500 の config）
 */
export const requireSession = createMiddleware<AppEnv>(async (c, next) => {
  if (isAuthDisabled(c.env, c.req.url)) {
    c.set("userId", OWNER_USER_ID);
    return next();
  }

  const token = readBearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const db = getDb(c.env.DB);
  const session = await validateSession(db, token, new Date());
  if (!session) return c.json({ error: "unauthorized" }, 401);

  const policy = readSignupPolicy(c.env);
  if (policy === null) return c.json({ error: "config" }, 500);
  if (!mayUse(policy, session)) {
    await deleteSession(db, token);
    return c.json({ error: "unauthorized" }, 401);
  }
  c.set("userId", session.userId);
  return next();
});
