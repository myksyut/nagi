import { z } from "zod";

/**
 * GitHub の OAuth（Web application flow）とのやり取りは、すべてこのファイルに閉じ込める。
 * scope は付けない（/user の id は scope なしで取れる）。GitHub のアクセストークンは ID を確かめたら捨てる。
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";

export class GitHubOAuthError extends Error {
  override name = "GitHubOAuthError";
}

export function createAuthorizationUrl(options: {
  clientId: string;
  redirectUri: string;
  state: string;
}): URL {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("state", options.state);
  url.searchParams.set("allow_signup", "false");
  return url;
}

// GitHub は失敗しても HTTP 200 で { error, error_description } を返すので、error を必ず見る
const tokenResponseSchema = z.union([
  z.object({ error: z.string(), error_description: z.string().optional() }),
  z.object({ access_token: z.string().min(1) }),
]);

/** 認可コードをアクセストークンに換える */
export async function exchangeCodeForToken(options: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<string> {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code: options.code,
      redirect_uri: options.redirectUri,
    }),
  });
  if (!response.ok) {
    throw new GitHubOAuthError(`トークンの交換に失敗しました（HTTP ${response.status}）`);
  }
  const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new GitHubOAuthError("トークンの交換の応答が読めません");
  }
  if ("error" in parsed.data) {
    throw new GitHubOAuthError(`トークンの交換に失敗しました（${parsed.data.error}）`);
  }
  return parsed.data.access_token;
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
