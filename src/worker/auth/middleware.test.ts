import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { sessions } from "../db/schema";
import app from "../index";
import { sha256Hex } from "./crypto";
import { isAuthDisabled } from "./middleware";
import { generateSessionToken, SESSION_TTL_MS } from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_URL = "https://nagi.example.com/api/session";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
});

/** lastExtendedAt に延ばしたばかりのセッションを直に作り、そのトークンを返す */
async function insertSession(lastExtendedAt: number = Date.now()): Promise<string> {
  const token = generateSessionToken();
  await getDb(env.DB)
    .insert(sessions)
    .values({
      id: await sha256Hex(token),
      expiresAt: new Date(lastExtendedAt + SESSION_TTL_MS).toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });
  return token;
}

async function storedExpiresAt(token: string): Promise<string | undefined> {
  const row = await getDb(env.DB).query.sessions.findFirst({
    where: eq(sessions.id, await sha256Hex(token)),
  });
  return row?.expiresAt;
}

function getSession(headers: Record<string, string> = {}) {
  return exports.default.fetch(SESSION_URL, { headers });
}

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
  it("Authorization がなければ 401", async () => {
    const res = await getSession();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("知らないトークンなら 401", async () => {
    const res = await getSession({ Authorization: `Bearer ${generateSessionToken()}` });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("有効なトークンなら 200。Set-Cookie は出さない", async () => {
    const token = await insertSession();

    const res = await getSession({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("Cookie にトークンがあっても見ない（401）", async () => {
    const token = await insertSession();

    const res = await getSession({ Cookie: `__Host-sid=${token}` });

    expect(res.status).toBe(401);
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });

  it("Bearer の形でなければ 401（有効なトークンでも）", async () => {
    const token = await insertSession();
    for (const authorization of [token, `Basic ${token}`, `Token ${token}`, "Bearer"]) {
      const res = await getSession({ Authorization: authorization });
      expect(res.status).toBe(401);
    }
  });

  it("期限切れのトークンは 401 で、行も消える", async () => {
    // 1 年と 1 分前に延ばしたきり → 期限は 1 分前
    const token = await insertSession(Date.now() - SESSION_TTL_MS - 60 * 1000);

    const res = await getSession({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await storedExpiresAt(token)).toBeUndefined();
  });

  it("最後に延ばしてから 1 日たっていなければ、期限は延ばさない", async () => {
    const lastExtendedAt = Date.now() - (DAY_MS - 60 * 60 * 1000);
    const token = await insertSession(lastExtendedAt);

    const res = await getSession({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    expect(await storedExpiresAt(token)).toBe(
      new Date(lastExtendedAt + SESSION_TTL_MS).toISOString(),
    );
  });

  it("最後に延ばしてから 1 日たっていれば、期限を今から 1 年に延ばす", async () => {
    const now = Date.now();
    // 最後に延ばしたのは 1 日と少し前 → このリクエストで延長される
    const token = await insertSession(now - (DAY_MS + 60 * 60 * 1000));

    const res = await getSession({ Authorization: `Bearer ${token}` });

    expect(res.status).toBe(200);
    const expiresAt = new Date((await storedExpiresAt(token)) ?? 0).getTime();
    expect(expiresAt).toBeGreaterThan(now + SESSION_TTL_MS - 5000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);
  });

  it("並列のリクエストで延長しても、どちらも 200 で、期限は今から 1 年になる", async () => {
    const now = Date.now();
    const token = await insertSession(now - 2 * DAY_MS);

    const request = () => getSession({ Authorization: `Bearer ${token}` });
    const responses = await Promise.all([request(), request()]);

    for (const res of responses) expect(res.status).toBe(200);
    const expiresAt = new Date((await storedExpiresAt(token)) ?? 0).getTime();
    expect(expiresAt).toBeGreaterThan(now + SESSION_TTL_MS - 5000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS);
  });

  it("AUTH_DISABLED かつ localhost ならトークンなしでも 200", async () => {
    const res = await app.request(
      "http://localhost:5317/api/session",
      {},
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true });
  });

  it("AUTH_DISABLED でも localhost 以外ならトークンなしは 401", async () => {
    const res = await app.request(
      "https://nagi.example.com/api/session",
      {},
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(401);
  });
});
