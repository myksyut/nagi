import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { sessions } from "../db/schema";
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
  await env.DB.prepare("DELETE FROM sessions").run();
});

describe("createSession", () => {
  it("トークンの SHA-256 だけを D1 に保存し、トークンそのものは保存しない", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-01T00:00:00.000Z");
    const { token, expiresAt } = await createSession(db, now);

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

  it("期限切れなら行を消して null を返す", async () => {
    const db = getDb(env.DB);
    const now = new Date("2026-01-10T00:00:00.000Z");
    const token = generateSessionToken();
    const expiresAt = new Date(now.getTime() - 1000);
    await db.insert(sessions).values({
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
    const { token } = await createSession(db, now);

    await deleteSession(db, token);

    const rows = await db.select().from(sessions);
    expect(rows).toHaveLength(0);
  });

  it("知らないトークンでも失敗しない", async () => {
    const db = getDb(env.DB);
    await expect(deleteSession(db, generateSessionToken())).resolves.toBeUndefined();
  });
});
