import { z } from "zod";

/**
 * GitHub の OAuth（デバイスフロー）とのやり取りは、すべてこのファイルに閉じ込める。
 * TUI は Worker を通してだけ GitHub とやり取りし、GitHub のアクセストークンは Worker の外に出さない。
 * scope は付けない（/user の id は scope なしで取れる）。アクセストークンは ID を確かめたら捨てる。
 * デバイスフローでは Client secret は要らない（OAuth App の設定で「Enable Device Flow」を有効にしておく）
 */

export const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
/** トークンを取りにいくときの grant_type（デバイスフロー） */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** slow_down の応答に interval がなかったときに返す、次に聞くまでの秒数（GitHub の最短は 5 秒） */
export const SLOW_DOWN_FALLBACK_INTERVAL_SECONDS = 10;

export class GitHubOAuthError extends Error {
  override name = "GitHubOAuthError";
}

const FORM_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/x-www-form-urlencoded",
};

// GitHub は失敗しても HTTP 200 で { error, error_description } を返すことがあるので、error を必ず見る
const errorResponseSchema = z.object({ error: z.string().min(1) });

const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().min(1),
  expires_in: z.int().positive(),
  interval: z.int().nonnegative(),
});

export type DeviceCode = {
  /** TUI が /auth/device/token に送り返すコード（画面には出さない） */
  deviceCode: string;
  /** 利用者が verificationUri のページに打ち込むコード */
  userCode: string;
  verificationUri: string;
  /** deviceCode と userCode の有効期限（秒） */
  expiresIn: number;
  /** トークンを聞きにいく間隔の下限（秒） */
  interval: number;
};

/** デバイスコードを発行してもらう（ログインの最初の一歩） */
export async function requestDeviceCode(clientId: string): Promise<DeviceCode> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: new URLSearchParams({ client_id: clientId }),
  });
  const body: unknown = await response.json().catch(() => null);
  // デバイスフローが無効（device_flow_disabled）のときなど。理由をログに残せるように、先に error を見る
  const failed = errorResponseSchema.safeParse(body);
  if (failed.success) {
    throw new GitHubOAuthError(`デバイスコードの発行に失敗しました（${failed.data.error}）`);
  }
  if (!response.ok) {
    throw new GitHubOAuthError(`デバイスコードの発行に失敗しました（HTTP ${response.status}）`);
  }
  const parsed = deviceCodeResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubOAuthError("デバイスコードの発行の応答が読めません");
  }
  return {
    deviceCode: parsed.data.device_code,
    userCode: parsed.data.user_code,
    verificationUri: parsed.data.verification_uri,
    expiresIn: parsed.data.expires_in,
    interval: parsed.data.interval,
  };
}

const tokenErrorResponseSchema = z.object({
  error: z.string().min(1),
  // slow_down のときに付く、次からの間隔（秒）。読めない値なら、ないものとして扱う
  interval: z.int().positive().optional().catch(undefined),
});
const tokenResponseSchema = z.object({ access_token: z.string().min(1) });

/**
 * トークンを1回聞きにいった結果
 * - authorized：利用者が承認した。accessToken は GitHub のアクセストークン（Worker の外に出さない）
 * - pending：まだ承認されていない（同じ間隔でまた聞く）
 * - slow_down：聞くのが速すぎる（次からは interval 秒あける）
 * - expired：コードの期限が切れた・コードが違う（最初からやり直す）
 * - denied：利用者が拒否した
 */
export type DeviceTokenPoll =
  | { status: "authorized"; accessToken: string }
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "expired" }
  | { status: "denied" };

/**
 * デバイスコードでアクセストークンを1回だけ聞きにいく（待って繰り返すのは TUI の側）。
 * 待てば済むもの・やり直せば済むものは結果として返し、それ以外（設定の誤り・GitHub の不調など）は例外にする
 */
export async function pollDeviceToken(options: {
  clientId: string;
  deviceCode: string;
}): Promise<DeviceTokenPoll> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: FORM_HEADERS,
    body: new URLSearchParams({
      client_id: options.clientId,
      device_code: options.deviceCode,
      grant_type: DEVICE_GRANT_TYPE,
    }),
  });
  const body: unknown = await response.json().catch(() => null);
  const failed = tokenErrorResponseSchema.safeParse(body);
  if (failed.success) {
    switch (failed.data.error) {
      case "authorization_pending":
        return { status: "pending" };
      case "slow_down":
        return {
          status: "slow_down",
          interval: failed.data.interval ?? SLOW_DOWN_FALLBACK_INTERVAL_SECONDS,
        };
      case "expired_token":
      case "incorrect_device_code":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      default:
        // device_flow_disabled・incorrect_client_credentials・unsupported_grant_type など
        throw new GitHubOAuthError(`トークンの取得に失敗しました（${failed.data.error}）`);
    }
  }
  if (!response.ok) {
    throw new GitHubOAuthError(`トークンの取得に失敗しました（HTTP ${response.status}）`);
  }
  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GitHubOAuthError("トークンの取得の応答が読めません");
  }
  return { status: "authorized", accessToken: parsed.data.access_token };
}

const userResponseSchema = z.object({ id: z.number().int().positive() });

/** アクセストークンの持ち主の GitHub ユーザー ID（数値） */
export async function fetchGitHubUserId(accessToken: string): Promise<number> {
  const response = await fetch(GITHUB_USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub の API では User-Agent が必須
      "User-Agent": "nagi",
    },
  });
  if (!response.ok) {
    throw new GitHubOAuthError(`ユーザーの取得に失敗しました（HTTP ${response.status}）`);
  }
  const parsed = userResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new GitHubOAuthError("ユーザーの応答が読めません");
  }
  return parsed.data.id;
}
