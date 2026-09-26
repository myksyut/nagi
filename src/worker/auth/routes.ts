import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  OAUTH_STATE_COOKIE,
  setOAuthStateCookie,
  setSessionCookie,
} from "./cookies";
import { encodeBase64Url, randomBytes } from "./crypto";
import { createAuthorizationUrl, exchangeCodeForToken, fetchGitHubUserId } from "./github";
import { createSession, deleteSession, SESSION_COOKIE } from "./session";

/**
 * 失敗したときはログイン画面（/login?error=...）へ戻す。値は画面の login-screen.tsx と対応する
 * - config：GITHUB_CLIENT_ID か ALLOWED_GITHUB_USER_ID が入っていない
 * - state：state が無い・合わない・期限切れ
 * - github：GitHub での拒否や、GitHub とのやり取りの失敗
 * - forbidden：許可していない GitHub ユーザー
 */
type LoginError = "config" | "state" | "github" | "forbidden";

function loginErrorPath(error: LoginError): string {
  return `/login?error=${error}`;
}

function callbackUrl(requestUrl: string): string {
  return new URL("/auth/callback", requestUrl).toString();
}

/** 許可する GitHub ユーザー ID。正の整数でなければ null（誰も通さない） */
export function parseAllowedUserId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

export const authRoutes = new Hono<AppEnv>()
  .get("/login", (c) => {
    if (!c.env.GITHUB_CLIENT_ID) return c.redirect(loginErrorPath("config"));

    const state = encodeBase64Url(randomBytes(32));
    setOAuthStateCookie(c, state);
    const url = createAuthorizationUrl({
      clientId: c.env.GITHUB_CLIENT_ID,
      redirectUri: callbackUrl(c.req.url),
      state,
    });
    return c.redirect(url.toString());
  })
  .get("/callback", async (c) => {
    // state は1回かぎり。成否にかかわらず消す
    const expectedState = getCookie(c, OAUTH_STATE_COOKIE);
    clearOAuthStateCookie(c);

    const { code, state, error } = c.req.query();
    if (error) return c.redirect(loginErrorPath("github"));
    if (!code || !state || !expectedState || state !== expectedState) {
      return c.redirect(loginErrorPath("state"));
    }

    const allowedUserId = parseAllowedUserId(c.env.ALLOWED_GITHUB_USER_ID);
    if (allowedUserId === null || !c.env.GITHUB_CLIENT_ID) {
      return c.redirect(loginErrorPath("config"));
    }

    let userId: number;
    try {
      const accessToken = await exchangeCodeForToken({
        clientId: c.env.GITHUB_CLIENT_ID,
        clientSecret: c.env.GITHUB_CLIENT_SECRET,
        code,
        redirectUri: callbackUrl(c.req.url),
      });
      // アクセストークンは ID を確かめるためだけに使い、保存しない
      userId = await fetchGitHubUserId(accessToken);
    } catch (e) {
      console.error("GitHub でのログインに失敗しました", e);
      return c.redirect(loginErrorPath("github"));
    }
    if (userId !== allowedUserId) return c.redirect(loginErrorPath("forbidden"));

    const session = await createSession(getDb(c.env.DB), new Date());
    setSessionCookie(c, session.token, session.expiresAt);
    return c.redirect("/");
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await deleteSession(getDb(c.env.DB), token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });
