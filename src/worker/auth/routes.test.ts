import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { sessions } from "../db/schema";
import app from "../index";
import { decodeBase64Url } from "../test/base64url";
import { cookieHeader, findSetCookie } from "../test/cookies";
import { OAUTH_STATE_COOKIE } from "./cookies";
import { sha256Hex } from "./crypto";
import { GITHUB_TOKEN_URL, GITHUB_USER_URL } from "./github";
import { parseAllowedUserId } from "./routes";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./session";

const ORIGIN = "https://nagi.example.com";
const ALLOWED_USER_ID = 1001; // vitest.config.ts の ALLOWED_GITHUB_USER_ID

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM sessions").run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockGitHub(
  options: {
    tokenResponse?: Response | (() => Response);
    userResponse?: Response | (() => Response);
    userId?: number;
  } = {},
) {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(GITHUB_TOKEN_URL)) {
      if (options.tokenResponse) {
        return typeof options.tokenResponse === "function"
          ? options.tokenResponse()
          : options.tokenResponse;
      }
      return Response.json({ access_token: "gho_test_token" });
    }
    if (url.startsWith(GITHUB_USER_URL)) {
      if (options.userResponse) {
        return typeof options.userResponse === "function"
          ? options.userResponse()
          : options.userResponse;
      }
      return Response.json({ id: options.userId ?? ALLOWED_USER_ID });
    }
    throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init)}`);
  });
  return spy;
}

async function sessionRows() {
  return getDb(env.DB).select().from(sessions);
}

describe("GET /auth/login", () => {
  it("state を Cookie に入れ、GitHub の認可画面へ 302 する", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("Location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe("test-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);
    expect(location.searchParams.get("allow_signup")).toBe("false");
    expect(location.searchParams.get("scope")).toBeNull();
    expect(location.searchParams.get("state")).toBeTruthy();

    const stateCookie = findSetCookie(res.headers.getSetCookie(), OAUTH_STATE_COOKIE);
    expect(stateCookie?.value).toBe(location.searchParams.get("state"));
    expect(stateCookie?.attrs.HttpOnly).toBe(true);
    expect(stateCookie?.attrs.Secure).toBe(true);
    expect(stateCookie?.attrs.SameSite).toBe("Lax");
    expect(stateCookie?.attrs.Path).toBe("/");
    expect(stateCookie?.attrs["Max-Age"]).toBe("600");
    // state は 32 バイトの乱数を base64url にしたもの
    expect(decodeBase64Url(stateCookie?.value ?? "")).toHaveLength(32);
  });

  it("state は発行のたびに違う値になる", async () => {
    const states = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await exports.default.fetch(`${ORIGIN}/auth/login`, { redirect: "manual" });
      const state = findSetCookie(res.headers.getSetCookie(), OAUTH_STATE_COOKIE)?.value ?? "";
      expect(decodeBase64Url(state)).toHaveLength(32);
      states.add(state);
    }
    expect(states.size).toBe(3);
  });

  it("GITHUB_CLIENT_ID が空なら /login?error=config へ、state は発行しない", async () => {
    const res = await app.request(
      `${ORIGIN}/auth/login`,
      { redirect: "manual" },
      { ...env, GITHUB_CLIENT_ID: "" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=config");
    expect(res.headers.getSetCookie()).toHaveLength(0);
  });
});

describe("GET /auth/callback", () => {
  it("許可した ID ならセッションができ、GitHub との2回のやり取りも正しい", async () => {
    const spy = mockGitHub();
    const state = "test-state-value";

    const res = await exports.default.fetch(
      `${ORIGIN}/auth/callback?code=test-code&state=${state}`,
      {
        redirect: "manual",
        headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) },
      },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");

    // state の Cookie は消え、セッションの Cookie が出る
    const clearedState = findSetCookie(res.headers.getSetCookie(), OAUTH_STATE_COOKIE);
    expect(clearedState?.value).toBe("");
    const sidCookie = findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE);
    expect(sidCookie).toBeDefined();
    expect(sidCookie?.attrs.HttpOnly).toBe(true);
    expect(sidCookie?.attrs.Secure).toBe(true);
    expect(sidCookie?.attrs.SameSite).toBe("Lax");
    expect(sidCookie?.attrs.Path).toBe("/");
    expect(sidCookie?.attrs.Expires).toBeTruthy();
    const token = sidCookie?.value ?? "";
    // セッションのトークンは 32 バイトの乱数を base64url にしたもの
    expect(decodeBase64Url(token)).toHaveLength(32);

    // D1 には1行だけ。id はトークンの SHA-256 で、トークンそのものは無い
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(await sha256Hex(token));
    for (const value of Object.values(rows[0] ?? {})) {
      expect(value).not.toBe(token);
    }
    const expiresAt = new Date(rows[0]?.expiresAt ?? 0).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS + 60_000);

    // GitHub とのやり取り：トークン交換 → ユーザー取得の順
    expect(spy).toHaveBeenCalledTimes(2);

    const [tokenUrl, tokenInit] = spy.mock.calls[0] ?? [];
    expect(tokenUrl).toBe(GITHUB_TOKEN_URL);
    expect(tokenInit?.method).toBe("POST");
    expect(new Headers(tokenInit?.headers).get("Accept")).toBe("application/json");
    expect(new Headers(tokenInit?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = tokenInit?.body as URLSearchParams;
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("code")).toBe("test-code");
    expect(body.get("redirect_uri")).toBe(`${ORIGIN}/auth/callback`);

    const [userUrl, userInit] = spy.mock.calls[1] ?? [];
    expect(userUrl).toBe(GITHUB_USER_URL);
    expect(new Headers(userInit?.headers).get("Authorization")).toBe("Bearer gho_test_token");
    expect(new Headers(userInit?.headers).get("Accept")).toBe("application/vnd.github+json");
    expect(new Headers(userInit?.headers).get("User-Agent")).toBeTruthy();

    // 発行されたセッションで /api/session が通る
    const sessionRes = await exports.default.fetch(`${ORIGIN}/api/session`, {
      headers: { Cookie: cookieHeader({ [SESSION_COOKIE]: token }) },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ authenticated: true });
  });

  it("ログインするたびに、別のセッションのトークンが出る", async () => {
    mockGitHub();
    const tokens = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const state = `state-${i}`;
      const res = await exports.default.fetch(`${ORIGIN}/auth/callback?code=c&state=${state}`, {
        redirect: "manual",
        headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) },
      });
      const token = findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE)?.value ?? "";
      expect(decodeBase64Url(token)).toHaveLength(32);
      tokens.add(token);
    }
    expect(tokens.size).toBe(3);
    expect(await sessionRows()).toHaveLength(3);
  });

  it("違う ID なら /login?error=forbidden で、セッションは作らない", async () => {
    mockGitHub({ userId: 999 });
    const state = "s";

    const res = await exports.default.fetch(`${ORIGIN}/auth/callback?code=c&state=${state}`, {
      redirect: "manual",
      headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) },
    });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=forbidden");
    expect(findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE)).toBeUndefined();
    expect(await sessionRows()).toHaveLength(0);
  });

  describe("state が合わない", () => {
    it.each([
      ["state が一致しない", { cookie: "a", query: "b" }],
      ["Cookie がない", { cookie: undefined, query: "a" }],
      ["state がない", { cookie: "a", query: undefined }],
    ])(
      "%s なら /login?error=state で、GitHub には問い合わせない",
      async (_label, { cookie, query }) => {
        const spy = vi.spyOn(globalThis, "fetch");

        const params = new URLSearchParams({ code: "c" });
        if (query !== undefined) params.set("state", query);
        const res = await exports.default.fetch(`${ORIGIN}/auth/callback?${params}`, {
          redirect: "manual",
          headers:
            cookie !== undefined ? { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: cookie }) } : {},
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/login?error=state");
        expect(spy).not.toHaveBeenCalled();
        expect(await sessionRows()).toHaveLength(0);
      },
    );

    it("code がなければ /login?error=state で、GitHub には問い合わせない", async () => {
      const spy = vi.spyOn(globalThis, "fetch");
      const state = "s";
      const res = await exports.default.fetch(`${ORIGIN}/auth/callback?state=${state}`, {
        redirect: "manual",
        headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/login?error=state");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("GitHub とのやり取りが失敗する", () => {
    const state = "s";
    const validCookie = { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) };

    it("?error= が付いていれば問い合わせずに /login?error=github", async () => {
      const spy = vi.spyOn(globalThis, "fetch");
      const res = await exports.default.fetch(
        `${ORIGIN}/auth/callback?error=access_denied&state=${state}`,
        { redirect: "manual", headers: validCookie },
      );
      expect(res.headers.get("Location")).toBe("/login?error=github");
      expect(spy).not.toHaveBeenCalled();
    });

    it("トークン交換が HTTP 200 でも { error } なら /login?error=github", async () => {
      mockGitHub({ tokenResponse: () => Response.json({ error: "bad_verification_code" }) });
      const res = await exports.default.fetch(`${ORIGIN}/auth/callback?code=c&state=${state}`, {
        redirect: "manual",
        headers: validCookie,
      });
      expect(res.headers.get("Location")).toBe("/login?error=github");
      expect(await sessionRows()).toHaveLength(0);
    });

    it("トークン交換が 5xx なら /login?error=github", async () => {
      mockGitHub({ tokenResponse: () => new Response("boom", { status: 500 }) });
      const res = await exports.default.fetch(`${ORIGIN}/auth/callback?code=c&state=${state}`, {
        redirect: "manual",
        headers: validCookie,
      });
      expect(res.headers.get("Location")).toBe("/login?error=github");
      expect(await sessionRows()).toHaveLength(0);
    });

    it("/user が 401 なら /login?error=github", async () => {
      mockGitHub({ userResponse: () => new Response("unauthorized", { status: 401 }) });
      const res = await exports.default.fetch(`${ORIGIN}/auth/callback?code=c&state=${state}`, {
        redirect: "manual",
        headers: validCookie,
      });
      expect(res.headers.get("Location")).toBe("/login?error=github");
      expect(await sessionRows()).toHaveLength(0);
    });
  });

  it("ALLOWED_GITHUB_USER_ID が不正なら /login?error=config で、GitHub には問い合わせない", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const state = "s";
    const res = await app.request(
      `${ORIGIN}/auth/callback?code=c&state=${state}`,
      { redirect: "manual", headers: { Cookie: cookieHeader({ [OAUTH_STATE_COOKIE]: state }) } },
      { ...env, ALLOWED_GITHUB_USER_ID: "not-a-number" },
    );
    expect(res.headers.get("Location")).toBe("/login?error=config");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("POST /auth/logout", () => {
  it("正しい Origin と JSON なら 204。行が消え、Cookie も消える", async () => {
    const db = getDb(env.DB);
    const token = "logout-test-token";
    await db.insert(sessions).values({
      id: await sha256Hex(token),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      createdAt: new Date().toISOString(),
    });

    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: {
        Origin: ORIGIN,
        "Content-Type": "application/json",
        Cookie: cookieHeader({ [SESSION_COOKIE]: token }),
      },
      body: "{}",
    });

    expect(res.status).toBe(204);
    const cleared = findSetCookie(res.headers.getSetCookie(), SESSION_COOKIE);
    expect(cleared?.value).toBe("");
    expect(await sessionRows()).toHaveLength(0);
  });

  it("Cookie がなくても 204（既にログアウト済み扱い）", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(204);
  });
});

describe("parseAllowedUserId", () => {
  it.each([
    ["1001", 1001],
    ["1", 1],
    ["9007199254740991", 9007199254740991], // Number.MAX_SAFE_INTEGER
  ])("%s は %i", (input, expected) => {
    expect(parseAllowedUserId(input)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["0"],
    ["-5"],
    ["abc"],
    ["01"],
    ["1.5"],
    ["9007199254740993"], // MAX_SAFE_INTEGER を超える
  ])("%s は null", (input) => {
    expect(parseAllowedUserId(input)).toBeNull();
  });
});
