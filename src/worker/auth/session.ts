import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sessions, users } from "../db/schema";
import { encodeBase64Url, randomBytes, sha256Hex } from "./crypto";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 有効期限は 1 年。使うたびに延長する */
export const SESSION_TTL_MS = 365 * DAY_MS;
/** 延長の書き込みは 1 日 1 回まで */
const EXTEND_INTERVAL_MS = DAY_MS;

export type Session = {
  /** セッションの持ち主（users.id） */
  userId: string;
  /** 持ち主の GitHub ユーザー ID（持ち主の行にまだ入っていなければ null） */
  githubUserId: number | null;
  expiresAt: Date;
  /**
   * 有効期限が延びた（expiresAt は延びたあとの期限）。
   * 並列のリクエストが先に延ばしていた場合も、その延ばした期限で true になる
   */
  extended: boolean;
};

/**
 * 32 バイトの乱数のトークン。ログインした TUI に渡し、`Authorization: Bearer` で受け取る。
 * D1 にはその SHA-256 だけを保存する
 */
export function generateSessionToken(): string {
  return encodeBase64Url(randomBytes(32));
}

export async function createSession(
  db: Db,
  userId: string,
  now: Date,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: await sha256Hex(token),
    userId,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });
  return { token, expiresAt };
}

/** トークンに当たる有効なセッションを返す。期限切れなら消して null */
export async function validateSession(db: Db, token: string, now: Date): Promise<Session | null> {
  const id = await sha256Hex(token);
  const row = await db
    .select({
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      githubUserId: users.githubUserId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, id))
    .get();
  if (!row) return null;
  const owner = { userId: row.userId, githubUserId: row.githubUserId };

  const expiresAt = new Date(row.expiresAt);
  if (!(expiresAt.getTime() > now.getTime())) {
    await db.delete(sessions).where(eq(sessions.id, id));
    return null;
  }

  // 最後に延ばしてから 1 日たっていれば、今から 1 年に延ばす
  const lastExtendedAt = expiresAt.getTime() - SESSION_TTL_MS;
  if (now.getTime() - lastExtendedAt < EXTEND_INTERVAL_MS) {
    return { ...owner, expiresAt, extended: false };
  }
  const extendedAt = new Date(now.getTime() + SESSION_TTL_MS);
  // 読んだ期限のままのときだけ書く。同じセッションへの並列のリクエストが先に延ばしていたら
  // 書かない（延長の書き込みは 1 日 1 回まで）
  const result = await db
    .update(sessions)
    .set({ expiresAt: extendedAt.toISOString() })
    .where(and(eq(sessions.id, id), eq(sessions.expiresAt, row.expiresAt)));
  if (result.meta.changes > 0) return { ...owner, expiresAt: extendedAt, extended: true };

  // 先を越された（ほかのリクエストが延ばした、またはログアウトで消えた）。今の行に合わせる
  // （消えていたら、ないセッションを有効として返さない）
  const latest = await db.query.sessions.findFirst({ where: eq(sessions.id, id) });
  if (!latest) return null;
  return { ...owner, expiresAt: new Date(latest.expiresAt), extended: true };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await sha256Hex(token)));
}
