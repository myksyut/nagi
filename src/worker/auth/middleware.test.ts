import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { OWNER_USER_ID, sessions } from "../db/schema";
import app from "../index";
import { insertRawUser, resetSyncTables } from "../test/sync-app";
import { sha256Hex } from "./crypto";
import { isAuthDisabled } from "./middleware";
import { generateSessionToken, SESSION_TTL_MS } from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;
const SESSION_URL = "https://nagi.example.com/api/session";

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user_sessions").run();
});

/** lastExtendedAt に延ばしたばかりのセッション（持ち主は userId）を直に作り、そのトークンを返す */
async function insertSession(
  lastExtendedAt: number = Date.now(),
  userId: string = OWNER_USER_ID,
): Promise<string> {
  const token = generateSessionToken();
  await getDb(env.DB)
    .insert(sessions)
    .values({
      userId,
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
    expect(await res.json()).toEqual({ authenticated: true, userId: OWNER_USER_ID });
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
    expect(await res.json()).toEqual({ authenticated: true, userId: OWNER_USER_ID });
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

describe("セッションの持ち主が、いまの設定でも使える人か", () => {
  const db = getDb(env.DB);
  const sessionOf = (token: string, overrides: Partial<Cloudflare.Env>) =>
    app.request(
      SESSION_URL,
      { headers: { Authorization: `Bearer ${token}` } },
      { ...env, ...overrides },
    );

  beforeEach(async () => {
    // 持ち主のほかの利用者を消し、持ち主はまだログインしたことがない状態（github_user_id が NULL）に戻す
    await resetSyncTables(db);
    await env.DB.prepare("UPDATE users SET github_user_id = NULL WHERE id = ?")
      .bind(OWNER_USER_ID)
      .run();
  });

  it("許可した人のセッションは通り、その人の userId が返る", async () => {
    const userId = await insertRawUser(db, 1002);
    const token = await insertSession(Date.now(), userId);

    const res = await sessionOf(token, { ALLOWED_GITHUB_USER_IDS: "1002" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, userId });
  });

  it("許可から外した人のセッションは 401 になり、そのセッションは消える。ほかの人のセッションは残る", async () => {
    const removed = await insertRawUser(db, 1002);
    const kept = await insertRawUser(db, 1003);
    const removedToken = await insertSession(Date.now(), removed);
    const keptToken = await insertSession(Date.now(), kept);
    const ownerToken = await insertSession();
    const only1003 = { ALLOWED_GITHUB_USER_IDS: "1003" };

    const res = await sessionOf(removedToken, only1003);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(await storedExpiresAt(removedToken)).toBeUndefined();
    expect((await sessionOf(keptToken, only1003)).status).toBe(200);
    expect((await sessionOf(ownerToken, only1003)).status).toBe(200);
    // 許可し直しても、消えたセッションは戻らない（ログインし直す）
    expect((await sessionOf(removedToken, { ALLOWED_GITHUB_USER_IDS: "1002,1003" })).status).toBe(
      401,
    );
  });

  it("SIGNUP を open から allowlist に戻すと、一覧にない人のセッションは止まる", async () => {
    const userId = await insertRawUser(db, 999);
    const token = await insertSession(Date.now(), userId);

    expect((await sessionOf(token, { SIGNUP: "open" })).status).toBe(200);
    expect((await sessionOf(token, { SIGNUP: "allowlist" })).status).toBe(401);
  });

  it("持ち主は、GitHub ユーザーがまだ入っていなくても（利用者を分ける前からのセッション）通る", async () => {
    const token = await insertSession();

    // OWNER_GITHUB_USER_ID を外して、ほかの人だけを許可していても
    const res = await sessionOf(token, {
      OWNER_GITHUB_USER_ID: "",
      ALLOWED_GITHUB_USER_IDS: "1002",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ authenticated: true, userId: OWNER_USER_ID });
  });

  it("持ち主の行に入っている GitHub ユーザーが、設定の持ち主でも許可した人でもなくなったら、止まる", async () => {
    await env.DB.prepare("UPDATE users SET github_user_id = 1001 WHERE id = ?")
      .bind(OWNER_USER_ID)
      .run();
    const token = await insertSession();

    expect((await sessionOf(token, {})).status).toBe(200);
    expect(
      (await sessionOf(token, { OWNER_GITHUB_USER_ID: "2002", ALLOWED_GITHUB_USER_IDS: "" }))
        .status,
    ).toBe(401);
  });

  it.each([
    ["SIGNUP が知らない値", { SIGNUP: "everyone" }],
    ["ALLOWED_GITHUB_USER_IDS に数でないものがある", { ALLOWED_GITHUB_USER_IDS: "abc" }],
    ["だれもログインできない設定", { OWNER_GITHUB_USER_ID: "", ALLOWED_GITHUB_USER_IDS: "" }],
  ])(
    "設定が正しくなければ、有効なセッションでも通さない（500 の config）。セッションは消さない：%s",
    async (_label, overrides) => {
      const token = await insertSession();

      const res = await sessionOf(token, overrides);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "config" });
      expect(await storedExpiresAt(token)).toBeDefined();
      // トークンがなければ、設定を見る前に 401
      expect((await app.request(SESSION_URL, {}, { ...env, ...overrides })).status).toBe(401);
    },
  );
});
