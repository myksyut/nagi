import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { OWNER_USER_ID, sessions } from "../db/schema";
import { decodeBase64Url } from "../test/base64url";
import { sha256Hex } from "./crypto";
import {
  createSession,
  deleteSession,
  generateSessionToken,
  SESSION_TTL_MS,
  validateSession,
} from "./session";

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user_sessions").run();
});

describe("generateSessionToken", () => {
  it("32 バイトの乱数を base64url にしたもので、発行のたびに違う値になる", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const token = generateSessionToken();
      expect(decodeBase64Url(token)).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(5);
  });
});

describe("createSession", () => {
  it("作るたびに別のトークンと別の行になる", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const first = await createSession(db, OWNER_USER_ID, now);
    const second = await createSession(db, OWNER_USER_ID, now);

    expect(decodeBase64Url(first.token)).toHaveLength(32);
    expect(decodeBase64Url(second.token)).toHaveLength(32);
    expect(first.token).not.toBe(second.token);

    const ids = (await db.select().from(sessions)).map((row) => row.id).sort();
    expect(ids).toEqual([await sha256Hex(first.token), await sha256Hex(second.token)].sort());
  });

  it("トークンの SHA-256 だけを D1 に保存し、トークンそのものは保存しない", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { token, expiresAt } = await createSession(db, OWNER_USER_ID, now);

    expect(expiresAt.toISOString()).toBe(new Date(now.getTime() + SESSION_TTL_MS).toISOString());

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(await sha256Hex(token));
    expect(rows[0]?.id).not.toBe(token);
    expect(rows[0]?.expiresAt).toBe(expiresAt.toISOString());
    expect(rows[0]?.createdAt).toBe(now.toISOString());

    // D1 のどの列にも生のトークンは入っていない
    for (const value of Object.values(rows[0] ?? {})) {
      expect(value).not.toBe(token);
    }
  });
});

describe("validateSession", () => {
  it("知らないトークンは null", async () => {
    const db = getDb(env.DB);
    const result = await validateSession(db, generateSessionToken(), new Date());
    expect(result).toBeNull();
  });

  it("有効期限内で、最後の延長から1日たっていなければ延長しない", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    // 最後に延ばしたのは 23 時間前 → まだ延長しない
    const lastExtendedAt = now.getTime() - (DAY_MS - 60 * 60 * 1000);
    const expiresAt = new Date(lastExtendedAt + SESSION_TTL_MS);
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    const result = await validateSession(db, token, now);
    expect(result).not.toBeNull();
    expect(result?.extended).toBe(false);
    expect(result?.expiresAt.toISOString()).toBe(expiresAt.toISOString());

    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, await sha256Hex(token)),
    });
    expect(row?.expiresAt).toBe(expiresAt.toISOString());
  });

  it("最後の延長からちょうど1日たっていれば延長する", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    const lastExtendedAt = now.getTime() - DAY_MS;
    const expiresAt = new Date(lastExtendedAt + SESSION_TTL_MS);
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    const result = await validateSession(db, token, now);
    expect(result?.extended).toBe(true);
    expect(result?.expiresAt.toISOString()).toBe(
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    );

    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, await sha256Hex(token)),
    });
    expect(row?.expiresAt).toBe(result?.expiresAt.toISOString());
  });

  it("最後の延長から1日を超えていれば延長し、今から1年に延ばす", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    const lastExtendedAt = now.getTime() - (DAY_MS + 60 * 60 * 1000);
    const expiresAt = new Date(lastExtendedAt + SESSION_TTL_MS);
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    const result = await validateSession(db, token, now);
    expect(result?.extended).toBe(true);
    expect(result?.expiresAt.toISOString()).toBe(
      new Date(now.getTime() + SESSION_TTL_MS).toISOString(),
    );
  });

  it("同じセッションに並列で来ても、延長の書き込みは1回だけで、どちらも D1 と同じ期限を返す", async () => {
    const db = getDb(env.DB);
    const token = generateSessionToken();
    const id = await sha256Hex(token);
    const lastExtendedAt = new Date("2026-01-01T00:00:00.000Z").getTime();
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id,
      expiresAt: new Date(lastExtendedAt + SESSION_TTL_MS).toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    // 2つとも延長の条件を満たし、時刻だけが違う。両方が延長を書き込むと、期限が食い違う
    const nowA = new Date(lastExtendedAt + 2 * DAY_MS);
    const nowB = new Date(nowA.getTime() + 60 * 1000);
    const [a, b] = await Promise.all([
      validateSession(db, token, nowA),
      validateSession(db, token, nowB),
    ]);

    const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
    const stored = row?.expiresAt;
    // 入っているのは、どちらか一方の延長だけ
    expect([
      new Date(nowA.getTime() + SESSION_TTL_MS).toISOString(),
      new Date(nowB.getTime() + SESSION_TTL_MS).toISOString(),
    ]).toContain(stored);
    // どちらの結果も D1 と同じ期限になる（古い期限に戻らない）
    expect(a?.extended).toBe(true);
    expect(b?.extended).toBe(true);
    expect(a?.expiresAt.toISOString()).toBe(stored);
    expect(b?.expiresAt.toISOString()).toBe(stored);
  });

  it("延長しようとしたときに行が消えていたら null", async () => {
    const db = getDb(env.DB);
    const token = generateSessionToken();
    const lastExtendedAt = new Date("2026-01-01T00:00:00.000Z").getTime();
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: new Date(lastExtendedAt + SESSION_TTL_MS).toISOString(),
      createdAt: new Date(lastExtendedAt).toISOString(),
    });

    // 延長の確認（読む → 書く）と並んでログアウト（消す）が走る。消すほうが先に書き込むので、
    // 延長の書き込みは空振りし、ないセッションを有効として返してはいけない
    const [result] = await Promise.all([
      validateSession(db, token, new Date(lastExtendedAt + 2 * DAY_MS)),
      deleteSession(db, token),
    ]);

    expect(result).toBeNull();
    expect(await db.select().from(sessions)).toHaveLength(0);
  });

  it("期限切れなら行を消して null を返す", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() - 1000);
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(now.getTime() - SESSION_TTL_MS).toISOString(),
    });

    const result = await validateSession(db, token, now);
    expect(result).toBeNull();

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(0);
  });

  it("有効期限ちょうどは期限切れ扱い", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    await db.insert(sessions).values({
      userId: OWNER_USER_ID,
      id: await sha256Hex(token),
      expiresAt: now.toISOString(),
      createdAt: new Date(now.getTime() - SESSION_TTL_MS).toISOString(),
    });

    expect(await validateSession(db, token, now)).toBeNull();
  });
});

describe("deleteSession", () => {
  it("トークンに当たる行を消す", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { token } = await createSession(db, OWNER_USER_ID, now);

    await deleteSession(db, token);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(0);
  });

  it("知らないトークンでも失敗しない", async () => {
    const db = getDb(env.DB);
    await expect(deleteSession(db, generateSessionToken())).resolves.toBeUndefined();
  });
});
