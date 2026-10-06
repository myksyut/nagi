import { and, eq, isNull } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client";
import { meta, OWNER_USER_ID, users } from "../db/schema";
import { initialMetaRows } from "../sync/meta";

/**
 * だれがログインできるか（設定から読む）
 * - ownerGitHubUserId：OWNER_GITHUB_USER_ID。利用者を分ける前からあったデータの持ち主（OWNER_USER_ID）として
 *   ログインする GitHub ユーザー。なければ null
 * - open：SIGNUP が "open"。GitHub のアカウントがあれば、だれでも登録できる
 * - allowed：ALLOWED_GITHUB_USER_IDS。open でないときに、持ち主のほかに登録・ログインできる GitHub ユーザー
 */
export type SignupPolicy = {
  ownerGitHubUserId: number | null;
  open: boolean;
  allowed: ReadonlySet<number>;
};

/** GitHub のユーザー ID。正の整数でなければ null */
export function parseGitHubUserId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * 設定を読む。正しくなければ null（だれも通さず、設定の不備として返す）。
 * - OWNER_GITHUB_USER_ID・ALLOWED_GITHUB_USER_IDS は、書いてあるなら正の整数（後者はカンマ区切り。前後の空白は無視）
 * - SIGNUP は "open" か "allowlist"（書いていなければ "allowlist"）
 * - "allowlist" なのに、持ち主も許可した人もいない（だれもログインできない）のも、設定の不備にする
 */
export function readSignupPolicy(
  env: Pick<Cloudflare.Env, "OWNER_GITHUB_USER_ID" | "SIGNUP" | "ALLOWED_GITHUB_USER_IDS">,
): SignupPolicy | null {
  const signup = env.SIGNUP || "allowlist";
  if (signup !== "open" && signup !== "allowlist") return null;

  let ownerGitHubUserId: number | null = null;
  if (env.OWNER_GITHUB_USER_ID) {
    ownerGitHubUserId = parseGitHubUserId(env.OWNER_GITHUB_USER_ID);
    if (ownerGitHubUserId === null) return null;
  }

  const allowed = new Set<number>();
  for (const part of (env.ALLOWED_GITHUB_USER_IDS ?? "").split(",")) {
    const text = part.trim();
    if (text === "") continue;
    const id = parseGitHubUserId(text);
    if (id === null) return null;
    allowed.add(id);
  }

  const open = signup === "open";
  if (!open && ownerGitHubUserId === null && allowed.size === 0) return null;
  return { ownerGitHubUserId, open, allowed };
}

function mayLogin(policy: SignupPolicy, githubUserId: number): boolean {
  return (
    policy.open || githubUserId === policy.ownerGitHubUserId || policy.allowed.has(githubUserId)
  );
}

/**
 * すでにいる利用者が、いまの設定でも使えるか（セッションの確認のたびに見る。許可から外した人は、ここで止まる）。
 * 持ち主の行にまだ GitHub ユーザーが入っていないあいだ（利用者を分ける前からのセッション）は、持ち主として通す
 */
export function mayUse(
  policy: SignupPolicy,
  user: { userId: string; githubUserId: number | null },
): boolean {
  if (user.githubUserId === null) return user.userId === OWNER_USER_ID;
  return mayLogin(policy, user.githubUserId);
}

async function findUserId(db: Db, githubUserId: number): Promise<string | null> {
  const row = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.githubUserId, githubUserId))
    .get();
  return row?.id ?? null;
}

/** 利用者と、その meta の行を作る（1つのバッチ。どちらかだけが残ることはない） */
async function createUser(db: Db, githubUserId: number, now: Date): Promise<string> {
  const id = crypto.randomUUID();
  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(users).values({ id, githubUserId, createdAt: now.toISOString() }),
    db.insert(meta).values(initialMetaRows(id)),
  ];
  try {
    await db.batch(statements);
    return id;
  } catch (error) {
    // 同じ GitHub ユーザーのログインが同時に来て、先に作られていた（github_user_id の一意の索引に当たった）
    const existing = await findUserId(db, githubUserId);
    if (existing !== null) return existing;
    throw error;
  }
}

/**
 * GitHub でログインした人に当たる利用者の ID を返す。ログインできない人なら null（利用者は作らない）。
 * 1. その GitHub ユーザーの利用者がすでにいれば、それ
 * 2. 持ち主（OWNER_GITHUB_USER_ID）の最初のログインなら、OWNER_USER_ID の行にその GitHub ユーザーを入れる
 *    （一度入れたら、設定を変えても持ち主は変わらない）
 * 3. どちらでもなければ、新しい利用者を作る
 * 許可から外した人は、すでに利用者がいてもログインできない（残っているセッションは、期限まで使える）
 */
export async function resolveUser(
  db: Db,
  policy: SignupPolicy,
  githubUserId: number,
  now: Date,
): Promise<string | null> {
  if (!mayLogin(policy, githubUserId)) return null;

  const existing = await findUserId(db, githubUserId);
  if (existing !== null) return existing;

  if (githubUserId === policy.ownerGitHubUserId) {
    const claimed = await db
      .update(users)
      .set({ githubUserId })
      .where(and(eq(users.id, OWNER_USER_ID), isNull(users.githubUserId)));
    if (claimed.meta.changes > 0) return OWNER_USER_ID;
    // 同時に来たログインが、先に入れていた
    const raced = await findUserId(db, githubUserId);
    if (raced !== null) return raced;
    // 持ち主の行には、もう別の GitHub ユーザーが入っている（あとから設定を変えた）。ふつうの利用者として作る
  }
  return createUser(db, githubUserId, now);
}
