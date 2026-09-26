import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions } from "../db/schema";
import { encodeBase64Url, randomBytes, sha256Hex } from "./crypto";

export const SESSION_COOKIE = "__Host-sid";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 有効期限は 1 年。使うたびに延長する */
export const SESSION_TTL_MS = 365 * DAY_MS;
/** 延長の書き込みは 1 日 1 回まで */
const EXTEND_INTERVAL_MS = DAY_MS;

export type Session = {
  expiresAt: Date;
  /** このリクエストで有効期限を延ばした（Cookie も出し直す） */
  extended: boolean;
};

/** 32 バイトの乱数のトークン。Cookie に入れ、D1 にはその SHA-256 だけを保存する */
export function generateSessionToken(): string {
  return encodeBase64Url(randomBytes(32));
}

export async function createSession(
  db: Db,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });
  return { token, expiresAt };
}

/** トークンに当たる有効なセッションを返す。期限切れなら消して null */
export async function validateSession(db: Db, token: string, now: Date): Promise<Session | null> {
  const id = await sha256Hex(token);
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!row) return null;

  const expiresAt = new Date(row.expiresAt);
  if (!(expiresAt.getTime() > now.getTime())) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  // 最後に延ばしてから 1 日たっていれば、今から 1 年に延ばす
  const lastExtendedAt = expiresAt.getTime() - SESSION_TTL_MS;
  if (now.getTime() - lastExtendedAt < EXTEND_INTERVAL_MS) {
    return { expiresAt, extended: false };
  }
  const extendedAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.update(sessions).set({ expiresAt: extendedAt.toISOString() }).where(eq(sessions.id, id));
  return { expiresAt: extendedAt, extended: true };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}
