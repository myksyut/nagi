import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { readBearerToken } from "./bearer";
import { fetchGitHubUserId, pollDeviceToken, requestDeviceCode } from "./github";
import { createSession, deleteSession } from "./session";

/**
 * TUI のログイン（GitHub のデバイスフロー）。
 * 1. TUI が /auth/device/start を呼び、返ってきた userCode を利用者が verificationUri のページに打ち込む
 * 2. TUI が interval 秒ごとに /auth/device/token を呼び、status が ok になったら token を手元に置く
 * 3. そのあとは `Authorization: Bearer <token>` で /api/* を呼ぶ
 *
 * 失敗の応答（{ error }）
 * - config（500）：GITHUB_CLIENT_ID か ALLOWED_GITHUB_USER_ID が入っていない・正しくない
 * - github（502）：GitHub とのやり取りの失敗（OAuth App のデバイスフローが無効のときも。理由はログに残す）
 * - invalid_request（400）：/auth/device/token の本文の形が違う
 */
export type AuthErrorResponse = { error: "config" | "github" | "invalid_request" };

/** POST /auth/device/start の応答 */
export type DeviceStartResponse = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

/**
 * POST /auth/device/token の応答（どれも HTTP 200）
 * - pending：まだ承認されていない（同じ間隔でまた聞く）
 * - slow_down：聞くのが速すぎる（次からは interval 秒あける）
 * - expired：コードの期限が切れた・コードが違う（/auth/device/start からやり直す）
 * - denied：利用者が GitHub で拒否した
 * - forbidden：承認されたが、許可していない GitHub ユーザーだった（セッションは作らない）
 * - ok：ログインできた。token はセッションのトークン、expiresAt はその期限（ISO 8601）
 */
export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "forbidden" }
  | { status: "ok"; token: string; expiresAt: string };

/** GitHub のデバイスコードは 40 文字。念のため長さに上限を付ける */
const deviceTokenRequestSchema = z.strictObject({ deviceCode: z.string().min(1).max(256) });

/** 許可する GitHub ユーザー ID。正の整数でなければ null（誰も通さない） */
export function parseAllowedUserId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** ログインに要る設定。どちらかが欠けていれば null（GitHub には問い合わせない） */
function readLoginConfig(
  env: Pick<Cloudflare.Env, "GITHUB_CLIENT_ID" | "ALLOWED_GITHUB_USER_ID">,
): { clientId: string; allowedUserId: number } | null {
  const allowedUserId = parseAllowedUserId(env.ALLOWED_GITHUB_USER_ID);
  if (!env.GITHUB_CLIENT_ID || allowedUserId === null) return null;
  return { clientId: env.GITHUB_CLIENT_ID, allowedUserId };
}

export const authRoutes = new Hono<AppEnv>()
  .post("/device/start", async (c) => {
    const config = readLoginConfig(c.env);
    if (!config) return c.json({ error: "config" } satisfies AuthErrorResponse, 500);

    try {
      const code = await requestDeviceCode(config.clientId);
      return c.json(code satisfies DeviceStartResponse);
    } catch (e) {
      console.error("デバイスコードの発行に失敗しました", e);
      return c.json({ error: "github" } satisfies AuthErrorResponse, 502);
    }
  })
  .post("/device/token", async (c) => {
    const parsed = deviceTokenRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "invalid_request" } satisfies AuthErrorResponse, 400);
    }
    const config = readLoginConfig(c.env);
    if (!config) return c.json({ error: "config" } satisfies AuthErrorResponse, 500);

    let userId: number;
    try {
      const poll = await pollDeviceToken({
        clientId: config.clientId,
        deviceCode: parsed.data.deviceCode,
      });
      if (poll.status !== "authorized") return c.json(poll satisfies DeviceTokenResponse);
      // GitHub のアクセストークンは ID を確かめるためだけに使い、保存も返しもしない
      userId = await fetchGitHubUserId(poll.accessToken);
    } catch (e) {
      console.error("GitHub でのログインに失敗しました", e);
      return c.json({ error: "github" } satisfies AuthErrorResponse, 502);
    }
    if (userId !== config.allowedUserId) {
      return c.json({ status: "forbidden" } satisfies DeviceTokenResponse);
    }

    const session = await createSession(getDb(c.env.DB), new Date());
    return c.json({
      status: "ok",
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
    } satisfies DeviceTokenResponse);
  })
  .post("/logout", async (c) => {
    const token = readBearerToken(c.req.header("Authorization"));
    if (token) await deleteSession(getDb(c.env.DB), token);
    return c.body(null, 204);
  });
