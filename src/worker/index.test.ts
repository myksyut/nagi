import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getDb } from "./db/client";
import { OWNER_USER_ID, sessions } from "./db/schema";
import app from "./index";

const BASE = "https://nagi.example.com";

describe("知らない URL", () => {
  it("/api/* の下は 401 が先に立つ（セッションがないので）", async () => {
    const res = await exports.default.fetch(`${BASE}/api/does-not-exist`);
    expect(res.status).toBe(401);
  });

  it.each(["/", "/does-not-exist", "/login", "/index.html"])(
    "/api/* でも /auth/* でもなければ 404 の JSON（画面は配らない）：%s",
    async (path) => {
      const res = await exports.default.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found" });
    },
  );

  it("/auth/ 配下の知らないパスも 404", async () => {
    const res = await exports.default.fetch(`${BASE}/auth/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it.each(["/auth/login", "/auth/callback?code=c&state=s"])(
    "ブラウザ用のログインの口はもうない（404）：%s",
    async (path) => {
      const res = await exports.default.fetch(`${BASE}${path}`, { redirect: "manual" });
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    },
  );

  it("ログインの口は POST だけ（GET は 404）", async () => {
    for (const path of ["/auth/device/start", "/auth/device/token", "/auth/logout"]) {
      const res = await exports.default.fetch(`${BASE}${path}`);
      expect(res.status).toBe(404);
    }
  });
});

describe("staging の変数", () => {
  // env.staging.vars（wrangler.jsonc）と同じ値。staging は公開の URL なので、AUTH_DISABLED が紛れ込んでも、
  // localhost 以外ではログインを外さない
  const stagingEnv = { ...env, SIGNUP: "allowlist", ALLOWED_GITHUB_USER_IDS: "" };

  it.each(["/api/session", "/api/sync"])(
    "AUTH_DISABLED=true を渡されても、staging の URL ではトークンなしは 401：%s",
    async (path) => {
      const res = await app.request(
        `https://staging.usenagi.dev${path}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
        { ...stagingEnv, AUTH_DISABLED: "true" },
      );
      expect(res.status).toBe(401);
    },
  );
});

const JSON_HEADERS = { "Content-Type": "application/json", Origin: BASE };
const FAILING_LIMITER: RateLimit = { limit: async () => ({ success: false }) };

describe("本文の大きさ", () => {
  it("/api/* は 1 MiB まで。超えると 413 の payload_too_large", async () => {
    const res = await exports.default.fetch(`${BASE}/api/mutate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: " ".repeat(1024 * 1024 + 1),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("/auth/* は 4 KiB まで。超えると 413 の payload_too_large", async () => {
    const res = await exports.default.fetch(`${BASE}/auth/device/token`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ deviceCode: "x".repeat(5 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
  });

  it("上限以内なら、これまでと同じ答えが返る", async () => {
    const res = await exports.default.fetch(`${BASE}/api/mutate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: "{}",
    });
    expect(res.status).toBe(401);
  });
});

describe("応答のヘッダ", () => {
  it.each([
    ["/api/session", { method: "GET" }],
    ["/auth/device/token", { method: "POST", headers: JSON_HEADERS, body: "{}" }],
    ["/does-not-exist", { method: "GET" }],
  ])("%s の応答に X-Content-Type-Options: nosniff がある", async (path, init) => {
    const res = await exports.default.fetch(`${BASE}${path}`, init);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it.each([
    ["/api/session", { method: "GET" }],
    ["/api/does-not-exist", { method: "GET" }],
    ["/auth/device/token", { method: "POST", headers: JSON_HEADERS, body: "{}" }],
    ["/auth/does-not-exist", { method: "GET" }],
  ])("%s の応答は Cache-Control: no-store（エラーも）", async (path, init) => {
    const res = await exports.default.fetch(`${BASE}${path}`, init);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("413 と 429 の応答にも付く", async () => {
    const tooLarge = await exports.default.fetch(`${BASE}/api/mutate`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: " ".repeat(1024 * 1024 + 1),
    });
    expect(tooLarge.headers.get("Cache-Control")).toBe("no-store");
    expect(tooLarge.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const limited = await app.request(
      `${BASE}/auth/device/start`,
      { method: "POST", headers: JSON_HEADERS, body: "{}" },
      { ...env, AUTH_START_LIMITER: FAILING_LIMITER },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("回数制限", () => {
  const post = (path: string, limiters: Partial<Cloudflare.Env>) =>
    app.request(
      `${BASE}${path}`,
      { method: "POST", headers: JSON_HEADERS, body: "{}" },
      { ...env, ...limiters },
    );

  it.each([
    ["/auth/device/start", "AUTH_START_LIMITER"],
    ["/auth/device/token", "AUTH_POLL_LIMITER"],
    ["/auth/logout", "AUTH_POLL_LIMITER"],
  ] as const)("%s は %s で数え、超えたら 429 と Retry-After", async (path, name) => {
    const res = await post(path, { [name]: FAILING_LIMITER });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(await res.json()).toEqual({ error: "rate_limited" });
  });

  it("/api/* の制限は、ログインを確かめたあとにかかる（ログインしていなければ 401 のまま）", async () => {
    const unauthenticated = await app.request(
      `${BASE}/api/session`,
      {},
      {
        ...env,
        API_LIMITER: FAILING_LIMITER,
      },
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await app.request(
      "http://localhost/api/session",
      {},
      { ...env, AUTH_DISABLED: "true", API_LIMITER: FAILING_LIMITER },
    );
    expect(authenticated.status).toBe(429);
    expect(authenticated.headers.get("Retry-After")).toBe("60");
  });

  it("/api/* の制限は、利用者ごとの鍵で数える", async () => {
    const keys: string[] = [];
    const limiter: RateLimit = {
      limit: async ({ key }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await app.request(
      "http://localhost/api/session",
      {},
      { ...env, AUTH_DISABLED: "true", API_LIMITER: limiter },
    );
    expect(keys).toEqual([OWNER_USER_ID]);
  });
});

describe("scheduled（cron）", () => {
  it("期限切れのセッションを消し、有効なものは残す", async () => {
    const db = getDb(env.DB);
    await env.DB.prepare("DELETE FROM user_sessions").run();
    const now = Date.now();
    const row = (id: string, expiresAt: number) => ({
      id,
      userId: OWNER_USER_ID,
      expiresAt: new Date(expiresAt).toISOString(),
      createdAt: new Date(now).toISOString(),
    });
    await db
      .insert(sessions)
      .values([row("expired", now - 1000), row("valid", now + 24 * 60 * 60 * 1000)]);
    const ctx = createExecutionContext();

    app.scheduled({ scheduledTime: now, cron: "17 19 * * *", noRetry() {} }, env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await db.select().from(sessions)).map((r) => r.id)).toEqual(["valid"]);
  });
});
