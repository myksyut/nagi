import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { sessions } from "../db/schema";
import app from "../index";
import { cookieHeader, findSetCookie } from "../test/cookies";
import { sha256Hex } from "./crypto";
import { isAuthDisabled } from "./middleware";
import { generateSessionToken, SESSION_COOKIE, SESSION_TTL_MS } from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
});

describe("isAuthDisabled", () => {
  const disabledEnv = { AUTH_DISABLED: "true" };
  const enabledEnv = { AUTH_DISABLED: undefined };

  it.each(["http://localhost:5317/", "http://127.0.0.1:5317/", "http://[::1]:5317/"])(
    "AUTH_DISABLED=true かつ %s は true",
    (url) => {
      expect(isAuthDisabled(disabledEnv, url)).toBe(true);
    },
  );

  it("AUTH_DISABLED=true でも localhost でなければ false", () => {
    expect(isAuthDisabled(disabledEnv, "https://nagi.example.com/")).toBe(false);
  });

  it("AUTH_DISABLED が true 以外なら localhost でも false", () => {
    expect(isAuthDisabled(enabledEnv, "http://localhost:5317/")).toBe(false);
    expect(isAuthDisabled({ AUTH_DISABLED: "false" }, "http://localhost:5317/")).toBe(false);
    expect(isAuthDisabled({ AUTH_DISABLED: "TRUE" }, "http://localhost:5317/")).toBe(false);
  });
});

describe("requireSession", () => {
  it("Cookie がなければ 401", async () => {
    const res = await exports.default.fetch("https://nagi.example.com/api/session");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("知らない Cookie なら 401 で、Cookie を消す", async () => {
    const res = await exports.default.fetch("https://nagi.example.com/api/session", {
      headers: { Cookie: cookieHeader({ [SESSION_COOKIE]: generateSessionToken() }) },
    });
    expect(res.status).toBe(401);
    const cleared = findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE);
    expect(cleared?.value).toBe("");
  });

  it("有効な Cookie なら 200 で、延長していなければ Set-Cookie を出さない", async () => {
    const db = getDb(env.DB);
    const token = generateSessionToken();
    const now = new Date();
    // 直前に延長したばかり（1 日たっていない）
    await db.insert(sessions).values({
      id: await sha256Hex(token),
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    });

    const res = await exports.default.fetch("https://nagi.example.com/api/session", {
      headers: { Cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE)).toBeUndefined();
  });

  it("延長した場合は __Host-sid を出し直す", async () => {
    const db = getDb(env.DB);
    const token = generateSessionToken();
    const now = Date.now();
    // 最後に延ばしたのは 1 日と少し前 → このリクエストで延長される
    const lastExtendedAt = now - (DAY_MS + 60 * 60 * 1000);
    await db.insert(sessions).values({
      id: await sha256Hex(token),
      expiresAt: new Date(lastExtendedAt + SESSION_TTL_MS).toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    const res = await exports.default.fetch("https://nagi.example.com/api/session", {
      headers: { Cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
    });
    expect(res.status).toBe(200);
    const reissued = findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE);
    expect(reissued?.value).toBe(token);
    expect(reissued?.attrs.HttpOnly).toBe(true);
    expect(reissued?.attrs.Secure).toBe(true);
    expect(reissued?.attrs.SameSite).toBe("Lax");
    expect(reissued?.attrs.Path).toBe("/");

    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, await sha256Hex(token)),
    });
    expect(new Date(row?.expiresAt ?? 0).getTime()).toBeGreaterThan(now + SESSION_TTL_MS - 5000);
  });

  it("AUTH_DISABLED かつ localhost なら Cookie なしでも 200", async () => {
    const res = await app.request(
      "http://localhost:5317/api/session",
      {},
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
  });

  it("AUTH_DISABLED でも localhost 以外なら Cookie なしは 401", async () => {
    const res = await app.request(
      "https://nagi.example.com/api/session",
      {},
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(401);
  });
});
