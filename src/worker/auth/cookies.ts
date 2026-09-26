import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import { SESSION_COOKIE } from "./session";

/** __Host- の Cookie は Secure・Path=/・Domain なしが必須 */
const HOST_COOKIE: CookieOptions = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" };

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, { ...HOST_COOKIE, expires: expiresAt });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, HOST_COOKIE);
}

/** OAuth の state を入れる短命の Cookie */
export const OAUTH_STATE_COOKIE = "__Host-oauth_state";
const OAUTH_STATE_MAX_AGE_SECONDS = 10 * 60;

export function setOAuthStateCookie(c: Context, state: string): void {
  setCookie(c, OAUTH_STATE_COOKIE, state, { ...HOST_COOKIE, maxAge: OAUTH_STATE_MAX_AGE_SECONDS });
}

export function clearOAuthStateCookie(c: Context): void {
  deleteCookie(c, OAUTH_STATE_COOKIE, HOST_COOKIE);
}
