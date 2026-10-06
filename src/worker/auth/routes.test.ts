import { env } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { meta, OWNER_USER_ID, sessions, users } from "../db/schema";
import app from "../index";
import { decodeBase64Url } from "../test/base64url";
import { resetSyncTables } from "../test/sync-app";
import { sha256Hex } from "./crypto";
import {
  DEVICE_GRANT_TYPE,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  SLOW_DOWN_FALLBACK_INTERVAL_SECONDS,
} from "./github";
import { SESSION_TTL_MS } from "./session";

const BASE = "https://nagi.example.com";
const OWNER_GITHUB_USER_ID = 1001; // vitest.config.ts の OWNER_GITHUB_USER_ID（SIGNUP は allowlist で、ほかに許可した人はいない）
const GITHUB_ACCESS_TOKEN = "gho_test_token";

const DEVICE_CODE_RESPONSE = {
  device_code: "3584d83530557fdd1f46af8289938c8ef79f9dc5",
  user_code: "WDJB-MJHT",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
  interval: 5,
};

beforeEach(async () => {
  // 持ち主のほかの利用者を消し、持ち主もまだログインしたことがない状態に戻す
  await resetSyncTables();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_sessions"),
    env.DB.prepare("UPDATE users SET github_user_id = NULL WHERE id = ?").bind(OWNER_USER_ID),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

type MockResponse = Response | (() => Response);

function respond(response: MockResponse): Response {
  return typeof response === "function" ? response() : response;
}

/** GitHub とのやり取り（fetch）を差し替える。何も渡さなければ、持ち主（OWNER_GITHUB_USER_ID）が承認した流れになる */
function mockGitHub(
  options: {
    deviceResponse?: MockResponse;
    tokenResponse?: MockResponse;
    userResponse?: MockResponse;
    userId?: number;
  } = {},
) {
  const spy = vi.spyOn(globalThis, "fetch");
  spy.mockImplementation(async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === GITHUB_DEVICE_CODE_URL) {
      return options.deviceResponse
        ? respond(options.deviceResponse)
        : Response.json(DEVICE_CODE_RESPONSE);
    }
    if (url === GITHUB_TOKEN_URL) {
      return options.tokenResponse
        ? respond(options.tokenResponse)
        : Response.json({ access_token: GITHUB_ACCESS_TOKEN, token_type: "bearer", scope: "" });
    }
    if (url === GITHUB_USER_URL) {
      return options.userResponse
        ? respond(options.userResponse)
        : Response.json({ id: options.userId ?? OWNER_GITHUB_USER_ID });
    }
    throw new Error(`unexpected fetch: ${url} ${JSON.stringify(init)}`);
  });
  return spy;
}

/** 失敗の理由を残す console.error を黙らせて、呼ばれ方を確かめられるようにする */
function muteConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

/** console.error に渡されたものを、1つの文字列にまとめる（理由が残っているかを確かめる） */
function loggedText(spy: ReturnType<typeof muteConsoleError>): string {
  return spy.mock.calls
    .flat()
    .map((value) => (value instanceof Error ? `${value.name}: ${value.message}` : String(value)))
    .join("\n");
}

/** TUI と同じ形の POST（Origin なし、本文は JSON） */
function postInit(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return exports.default.fetch(`${BASE}${path}`, postInit(body, headers));
}

async function sessionRows() {
  return getDb(env.DB).select().from(sessions);
}

async function userRows() {
  return getDb(env.DB).select().from(users);
}

/** 設定（env）を差し替えて /auth/device/token を呼ぶ。GitHub では githubUserId の人が承認した流れにする */
async function loginAs(githubUserId: number, overrides: Partial<Cloudflare.Env> = {}) {
  vi.restoreAllMocks();
  mockGitHub({ userId: githubUserId });
  const res = await app.request(
    `${BASE}/auth/device/token`,
    postInit({ deviceCode: "device-code" }),
    { ...env, ...overrides },
  );
  return (await res.json()) as { status: string; token?: string; userId?: string };
}

/** セッションのトークンの持ち主（users.id） */
async function sessionUserId(token: string | undefined): Promise<string | undefined> {
  if (token === undefined) throw new Error("トークンがありません");
  const id = await sha256Hex(token);
  return (await sessionRows()).find((row) => row.id === id)?.userId;
}

describe("POST /auth/device/start", () => {
  it("ログインなしで呼べて、GitHub のデバイスコードを返す。GitHub へは client_id だけを送る", async () => {
    const spy = mockGitHub();

    const res = await post("/auth/device/start", {});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      deviceCode: DEVICE_CODE_RESPONSE.device_code,
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      expiresIn: 900,
      interval: 5,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe(GITHUB_DEVICE_CODE_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    const body = init?.body as URLSearchParams;
    // scope は付けない。Client secret も送らない
    expect([...body.keys()]).toEqual(["client_id"]);
    expect(body.get("client_id")).toBe("test-client-id");
    // セッションはまだ作らない
    expect(await sessionRows()).toHaveLength(0);
  });

  it.each([
    ["GITHUB_CLIENT_ID が空", { GITHUB_CLIENT_ID: "" }],
    ["OWNER_GITHUB_USER_ID が数でない", { OWNER_GITHUB_USER_ID: "not-a-number" }],
    ["SIGNUP が知らない値", { SIGNUP: "everyone" }],
    ["ALLOWED_GITHUB_USER_IDS に数でないものがある", { ALLOWED_GITHUB_USER_IDS: "1002,abc" }],
    ["allowlist なのに、ログインできる人がだれもいない", { OWNER_GITHUB_USER_ID: "" }],
  ])("%s なら 500 の config で、GitHub には問い合わせない", async (_label, overrides) => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await app.request(`${BASE}/auth/device/start`, postInit({}), {
      ...env,
      ...overrides,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "config" });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    [
      "デバイスフローが無効（HTTP 200 の { error }）",
      () => Response.json({ error: "device_flow_disabled" }),
      "device_flow_disabled",
    ],
    [
      "デバイスフローが無効（HTTP 400 の { error }）",
      () => Response.json({ error: "device_flow_disabled" }, { status: 400 }),
      "device_flow_disabled",
    ],
    ["GitHub が 5xx", () => new Response("boom", { status: 503 }), "HTTP 503"],
    ["応答が読めない", () => Response.json({ device_code: "only" }), "読めません"],
  ])("%s なら 502 の github で、理由をログに残す", async (_label, deviceResponse, reason) => {
    mockGitHub({ deviceResponse });
    const errorSpy = muteConsoleError();

    const res = await post("/auth/device/start", {});

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "github" });
    expect(loggedText(errorSpy)).toContain(reason);
  });

  it("GitHub につながらなくても 502 の github", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    const errorSpy = muteConsoleError();

    const res = await post("/auth/device/start", {});

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "github" });
    expect(loggedText(errorSpy)).toContain("network down");
  });
});

describe("POST /auth/device/token", () => {
  const deviceCode = DEVICE_CODE_RESPONSE.device_code;

  it("まだ承認されていなければ pending。GitHub へは client_id・device_code・grant_type を送る", async () => {
    const spy = mockGitHub({
      tokenResponse: () => Response.json({ error: "authorization_pending" }),
    });

    const res = await post("/auth/device/token", { deviceCode });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });

    // 聞くのはトークンの口だけ（/user までは行かない）
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] ?? [];
    expect(url).toBe(GITHUB_TOKEN_URL);
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
    const body = init?.body as URLSearchParams;
    expect([...body.keys()].sort()).toEqual(["client_id", "device_code", "grant_type"]);
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("device_code")).toBe(deviceCode);
    expect(body.get("grant_type")).toBe(DEVICE_GRANT_TYPE);
    expect(DEVICE_GRANT_TYPE).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(await sessionRows()).toHaveLength(0);
  });

  it.each([
    ["GitHub が返した interval", { error: "slow_down", interval: 10 }, 10],
    ["GitHub が返した interval（長め）", { error: "slow_down", interval: 25 }, 25],
    ["interval がなければ安全な値", { error: "slow_down" }, SLOW_DOWN_FALLBACK_INTERVAL_SECONDS],
    [
      "interval が数でなければ安全な値",
      { error: "slow_down", interval: "soon" },
      SLOW_DOWN_FALLBACK_INTERVAL_SECONDS,
    ],
  ])("速すぎれば slow_down：%s", async (_label, githubBody, interval) => {
    mockGitHub({ tokenResponse: () => Response.json(githubBody) });

    const res = await post("/auth/device/token", { deviceCode });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "slow_down", interval });
    expect(await sessionRows()).toHaveLength(0);
  });

  it.each([
    ["expired_token", "expired"],
    ["incorrect_device_code", "expired"],
    ["access_denied", "denied"],
  ])("GitHub の %s は %s", async (githubError, status) => {
    const spy = mockGitHub({ tokenResponse: () => Response.json({ error: githubError }) });

    const res = await post("/auth/device/token", { deviceCode });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await sessionRows()).toHaveLength(0);
  });

  it("持ち主が承認したら ok。持ち主（OWNER_USER_ID）のセッションができ、そのトークンで /api/session が通る", async () => {
    const spy = mockGitHub();

    const res = await post("/auth/device/token", { deviceCode });

    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text) as {
      status: string;
      token: string;
      expiresAt: string;
      userId: string;
    };
    expect(Object.keys(body).sort()).toEqual(["expiresAt", "status", "token", "userId"]);
    expect(body.status).toBe("ok");
    expect(body.userId).toBe(OWNER_USER_ID);
    // セッションのトークンは 32 バイトの乱数を base64url にしたもの
    expect(decodeBase64Url(body.token)).toHaveLength(32);
    // 期限は ISO 8601 で、今から 1 年
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt);
    const expiresAt = new Date(body.expiresAt).getTime();
    expect(expiresAt).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 60_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + SESSION_TTL_MS + 60_000);

    // D1 には1行だけ。id はトークンの SHA-256 で、トークンそのものは無い
    const rows = await sessionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(await sha256Hex(body.token));
    expect(rows[0]?.expiresAt).toBe(body.expiresAt);
    // 持ち主のセッション。新しい利用者は作らず、持ち主の行に GitHub のユーザー ID が入る
    expect(rows[0]?.userId).toBe(OWNER_USER_ID);
    expect((await userRows()).map((row) => [row.id, row.githubUserId])).toEqual([
      [OWNER_USER_ID, OWNER_GITHUB_USER_ID],
    ]);
    for (const value of Object.values(rows[0] ?? {})) {
      expect(value).not.toBe(body.token);
    }

    // GitHub のアクセストークンは、応答にも D1 にも出さない
    expect(text).not.toContain(GITHUB_ACCESS_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(GITHUB_ACCESS_TOKEN);
    expect(res.headers.getSetCookie()).toHaveLength(0);

    // GitHub とのやり取り：トークンの取得 → ユーザーの取得の順
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[0]?.[0]).toBe(GITHUB_TOKEN_URL);
    const [userUrl, userInit] = spy.mock.calls[1] ?? [];
    expect(userUrl).toBe(GITHUB_USER_URL);
    expect(new Headers(userInit?.headers).get("Authorization")).toBe(
      `Bearer ${GITHUB_ACCESS_TOKEN}`,
    );
    expect(new Headers(userInit?.headers).get("Accept")).toBe("application/vnd.github+json");
    expect(new Headers(userInit?.headers).get("User-Agent")).toBeTruthy();

    // 発行されたトークンで /api/session が通る
    const sessionRes = await exports.default.fetch(`${BASE}/api/session`, {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(sessionRes.status).toBe(200);
    expect(await sessionRes.json()).toEqual({ authenticated: true, userId: OWNER_USER_ID });
  });

  it("ログインするたびに、別のセッションのトークンが出る", async () => {
    mockGitHub();
    const tokens = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await post("/auth/device/token", { deviceCode: `device-code-${i}` });
      const body = (await res.json()) as { token: string };
      expect(decodeBase64Url(body.token)).toHaveLength(32);
      tokens.add(body.token);
    }
    expect(tokens.size).toBe(3);
    expect(await sessionRows()).toHaveLength(3);
  });

  it("承認されても、許可していない GitHub ユーザーなら forbidden で、利用者もセッションも作らない", async () => {
    const spy = mockGitHub({ userId: 999 });

    const res = await post("/auth/device/token", { deviceCode });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "forbidden" });
    expect(text).not.toContain(GITHUB_ACCESS_TOKEN);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(await sessionRows()).toHaveLength(0);
    expect((await userRows()).map((row) => row.id)).toEqual([OWNER_USER_ID]);
  });

  describe("持ち主のほかの利用者", () => {
    const ALLOW_1002_1003 = { ALLOWED_GITHUB_USER_IDS: " 1002, 1003 " };

    it("許可した人が初めてログインすると、利用者と meta の行ができ、その人のセッションになる。2 回目は同じ利用者", async () => {
      const first = await loginAs(1002, ALLOW_1002_1003);
      expect(first.status).toBe("ok");

      const created = (await userRows()).filter((row) => row.id !== OWNER_USER_ID);
      expect(created).toHaveLength(1);
      const userId = created[0]?.id ?? "";
      expect(created[0]?.githubUserId).toBe(1002);
      expect(first.userId).toBe(userId);
      expect(await sessionUserId(first.token)).toBe(userId);
      // 通し番号などは、その人のぶんが初期値で入る
      const metaRows = await getDb(env.DB).select().from(meta);
      expect(
        metaRows
          .filter((row) => row.userId === userId)
          .map((row) => [row.key, row.value])
          .sort(),
      ).toEqual([
        ["last_rollover_on", ""],
        ["purged_through_seq", "0"],
        ["seq", "0"],
      ]);

      const second = await loginAs(1002, ALLOW_1002_1003);
      expect(second.status).toBe("ok");
      expect(second.token).not.toBe(first.token);
      expect(await sessionUserId(second.token)).toBe(userId);
      expect(await userRows()).toHaveLength(2);
    });

    it("人ごとに別の利用者になる（持ち主とも別）", async () => {
      const owner = await loginAs(OWNER_GITHUB_USER_ID, ALLOW_1002_1003);
      const a = await loginAs(1002, ALLOW_1002_1003);
      const b = await loginAs(1003, ALLOW_1002_1003);

      const ids = [
        await sessionUserId(owner.token),
        await sessionUserId(a.token),
        await sessionUserId(b.token),
      ];
      expect(ids[0]).toBe(OWNER_USER_ID);
      expect(new Set(ids).size).toBe(3);
      expect(await userRows()).toHaveLength(3);
    });

    it("同じ人のログインが同時に来ても、利用者は 1 人だけできる", async () => {
      mockGitHub({ userId: 1002 });
      const login = () =>
        app.request(`${BASE}/auth/device/token`, postInit({ deviceCode: "device-code" }), {
          ...env,
          ...ALLOW_1002_1003,
        });

      const bodies = await Promise.all(
        (await Promise.all([login(), login(), login()])).map(
          (res) => res.json() as Promise<{ status: string; token: string }>,
        ),
      );

      expect(bodies.map((body) => body.status)).toEqual(["ok", "ok", "ok"]);
      const created = (await userRows()).filter((row) => row.id !== OWNER_USER_ID);
      expect(created).toHaveLength(1);
      for (const body of bodies) expect(await sessionUserId(body.token)).toBe(created[0]?.id);
      expect(
        (await getDb(env.DB).select().from(meta)).filter((row) => row.userId === created[0]?.id),
      ).toHaveLength(3);
    });

    it("持ち主のログインが同時に来ても、どれも持ち主（OWNER_USER_ID）になり、利用者は増えない", async () => {
      mockGitHub();
      const login = () => post("/auth/device/token", { deviceCode: "device-code" });

      const bodies = await Promise.all(
        (await Promise.all([login(), login(), login()])).map(
          (res) => res.json() as Promise<{ status: string; token: string; userId: string }>,
        ),
      );

      expect(bodies.map((body) => [body.status, body.userId])).toEqual([
        ["ok", OWNER_USER_ID],
        ["ok", OWNER_USER_ID],
        ["ok", OWNER_USER_ID],
      ]);
      expect((await userRows()).map((row) => [row.id, row.githubUserId])).toEqual([
        [OWNER_USER_ID, OWNER_GITHUB_USER_ID],
      ]);
    });

    it("持ち主に設定する前に、その人がふつうの利用者として登録されていたら、あとから設定しても持ち主にはならない", async () => {
      // 持ち主を設定せずに、1001 を許可した人として登録した
      const before = { OWNER_GITHUB_USER_ID: "", ALLOWED_GITHUB_USER_IDS: "1001" };
      const first = await loginAs(1001, before);
      expect(first.status).toBe("ok");
      expect(first.userId).not.toBe(OWNER_USER_ID);

      // あとから 1001 を持ち主に設定しても、1001 はもとの利用者のまま（持ち主の行は、だれのものでもないまま）
      const second = await loginAs(1001, { OWNER_GITHUB_USER_ID: "1001" });
      expect(second.userId).toBe(first.userId);
      expect((await userRows()).map((row) => [row.id, row.githubUserId]).sort()).toEqual(
        [
          [OWNER_USER_ID, null],
          [first.userId, 1001],
        ].sort(),
      );
    });

    it("許可から外した人は、利用者がいても forbidden（新しいセッションは作らない）", async () => {
      expect((await loginAs(1002, ALLOW_1002_1003)).status).toBe("ok");
      const sessionsBefore = await sessionRows();

      expect((await loginAs(1002, { ALLOWED_GITHUB_USER_IDS: "1003" })).status).toBe("forbidden");

      expect(await sessionRows()).toEqual(sessionsBefore);
      expect(await userRows()).toHaveLength(2);
    });

    it("SIGNUP が open なら、許可の一覧にない人も登録できる（一覧が空でも、持ち主がいなくても）", async () => {
      const open = { SIGNUP: "open", OWNER_GITHUB_USER_ID: "", ALLOWED_GITHUB_USER_IDS: "" };

      const body = await loginAs(999, open);

      expect(body.status).toBe("ok");
      const created = (await userRows()).filter((row) => row.id !== OWNER_USER_ID);
      expect(created.map((row) => row.githubUserId)).toEqual([999]);
      expect(await sessionUserId(body.token)).toBe(created[0]?.id);
    });

    it("持ち主の行は、最初にログインした持ち主のもののまま（あとから OWNER_GITHUB_USER_ID を変えても、移らない）", async () => {
      expect(await sessionUserId((await loginAs(OWNER_GITHUB_USER_ID)).token)).toBe(OWNER_USER_ID);

      // 設定の持ち主を 2002 に変えた。2002 は持ち主の行を取れず、ふつうの利用者になる
      const changed = { OWNER_GITHUB_USER_ID: "2002", ALLOWED_GITHUB_USER_IDS: "1001" };
      const newcomer = await loginAs(2002, changed);
      expect(newcomer.status).toBe("ok");
      const newcomerId = await sessionUserId(newcomer.token);
      expect(newcomerId).not.toBe(OWNER_USER_ID);

      // もとの持ち主は、許可されていれば、これまでどおり持ち主の行でログインする
      expect(await sessionUserId((await loginAs(1001, changed)).token)).toBe(OWNER_USER_ID);
      expect((await userRows()).map((row) => [row.id, row.githubUserId]).sort()).toEqual(
        [
          [OWNER_USER_ID, 1001],
          [newcomerId, 2002],
        ].sort(),
      );
    });
  });

  it.each([
    ["空のオブジェクト", {}],
    ["deviceCode が文字列でない", { deviceCode: 12345 }],
    ["deviceCode が空", { deviceCode: "" }],
    ["deviceCode が長すぎる", { deviceCode: "a".repeat(257) }],
    ["知らない項目がある", { deviceCode: "abc", extra: true }],
    ["名前が違う（device_code）", { device_code: "abc" }],
    ["配列", ["abc"]],
    ["null", null],
    ["JSON でない", "not json"],
  ])(
    "本文の形が違えば 400 の invalid_request で、GitHub には問い合わせない：%s",
    async (_label, body) => {
      const spy = vi.spyOn(globalThis, "fetch");

      const res = await post("/auth/device/token", body);

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_request" });
      expect(spy).not.toHaveBeenCalled();
      expect(await sessionRows()).toHaveLength(0);
    },
  );

  it.each([
    ["GITHUB_CLIENT_ID が空", { GITHUB_CLIENT_ID: "" }],
    ["OWNER_GITHUB_USER_ID が数でない", { OWNER_GITHUB_USER_ID: "not-a-number" }],
    ["ALLOWED_GITHUB_USER_IDS に数でないものがある", { ALLOWED_GITHUB_USER_IDS: "1002,abc" }],
  ])("%s なら 500 の config で、GitHub には問い合わせない", async (_label, overrides) => {
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await app.request(`${BASE}/auth/device/token`, postInit({ deviceCode }), {
      ...env,
      ...overrides,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "config" });
    expect(spy).not.toHaveBeenCalled();
  });

  describe("GitHub とのやり取りが失敗する", () => {
    it.each([
      [
        "デバイスフローが無効",
        { tokenResponse: () => Response.json({ error: "device_flow_disabled" }) },
        "device_flow_disabled",
      ],
      [
        "Client ID が違う",
        { tokenResponse: () => Response.json({ error: "incorrect_client_credentials" }) },
        "incorrect_client_credentials",
      ],
      [
        "知らない error",
        { tokenResponse: () => Response.json({ error: "something_new" }) },
        "something_new",
      ],
      [
        "トークンの取得が 5xx",
        { tokenResponse: () => new Response("boom", { status: 500 }) },
        "HTTP 500",
      ],
      ["トークンの応答が読めない", { tokenResponse: () => Response.json({}) }, "読めません"],
      [
        "/user が 401",
        { userResponse: () => new Response("unauthorized", { status: 401 }) },
        "HTTP 401",
      ],
      ["/user の応答が読めない", { userResponse: () => Response.json({ id: "x" }) }, "読めません"],
    ])("%s なら 502 の github で、セッションは作らない", async (_label, options, reason) => {
      mockGitHub(options);
      const errorSpy = muteConsoleError();

      const res = await post("/auth/device/token", { deviceCode });

      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({ error: "github" });
      expect(loggedText(errorSpy)).toContain(reason);
      expect(await sessionRows()).toHaveLength(0);
    });
  });
});

describe("POST /auth/logout", () => {
  async function insertSession(token: string) {
    await getDb(env.DB)
      .insert(sessions)
      .values({
        userId: OWNER_USER_ID,
        id: await sha256Hex(token),
        expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
        createdAt: new Date().toISOString(),
      });
  }

  it("Bearer のトークンのセッションだけを消して 204。そのあとは 401", async () => {
    const token = "logout-test-token";
    const other = "other-device-token";
    await insertSession(token);
    await insertSession(other);
    const authorized = { Authorization: `Bearer ${token}` };

    const before = await exports.default.fetch(`${BASE}/api/session`, { headers: authorized });
    expect(before.status).toBe(200);

    const res = await post("/auth/logout", {}, authorized);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    // ほかの端末のセッションは残る
    const rows = await sessionRows();
    expect(rows.map((row) => row.id)).toEqual([await sha256Hex(other)]);

    const after = await exports.default.fetch(`${BASE}/api/session`, { headers: authorized });
    expect(after.status).toBe(401);
    expect(await after.json()).toEqual({ error: "unauthorized" });
  });

  it("ログインからログアウトまで：デバイスフローで出たトークンは、ログアウトのあと使えない", async () => {
    mockGitHub();
    const login = await post("/auth/device/token", { deviceCode: "device-code" });
    const { token } = (await login.json()) as { token: string };
    const authorized = { Authorization: `Bearer ${token}` };

    expect((await post("/auth/logout", {}, authorized)).status).toBe(204);

    expect(await sessionRows()).toHaveLength(0);
    const after = await exports.default.fetch(`${BASE}/api/session`, { headers: authorized });
    expect(after.status).toBe(401);
  });

  it("トークンがなくても 204（既にログアウト済み扱い）", async () => {
    await insertSession("someone-else");
    const res = await post("/auth/logout", {});
    expect(res.status).toBe(204);
    expect(await sessionRows()).toHaveLength(1);
  });

  it("知らないトークンでも 204", async () => {
    const res = await post("/auth/logout", {}, { Authorization: "Bearer unknown-token" });
    expect(res.status).toBe(204);
  });
});
