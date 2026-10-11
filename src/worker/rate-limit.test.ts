import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { limitByIp, limitByUser } from "./rate-limit";
import type { AppEnv } from "./types";

/** 呼ばれた鍵を覚え、決めた答えを返す回数制限の代わり */
function fakeLimiter(success: boolean) {
  const keys: string[] = [];
  const limiter: RateLimit = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success };
    },
  };
  return { limiter, keys };
}

function appWith(limiter: RateLimit) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("userId", "user-1");
    return next();
  });
  app.post("/by-ip", limitByIp("AUTH_START_LIMITER"), (c) => c.json({ ok: true }));
  app.post("/by-user", limitByUser("API_LIMITER"), (c) => c.json({ ok: true }));
  const call = (path: string, headers: Record<string, string> = {}) =>
    app.request(
      path,
      { method: "POST", headers },
      {
        ...env,
        AUTH_START_LIMITER: limiter,
        API_LIMITER: limiter,
      },
    );
  return call;
}

describe("回数制限", () => {
  it("超えたら 429 の rate_limited と Retry-After: 60 を返し、先へは進まない", async () => {
    const call = appWith(fakeLimiter(false).limiter);

    for (const path of ["/by-ip", "/by-user"]) {
      const res = await call(path);
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("60");
      expect(await res.json()).toEqual({ error: "rate_limited" });
    }
  });

  it("超えていなければ通す", async () => {
    const call = appWith(fakeLimiter(true).limiter);

    expect((await call("/by-ip")).status).toBe(200);
    expect((await call("/by-user")).status).toBe(200);
  });

  it("IP ごとの制限は CF-Connecting-IP で数え、ないとき（pnpm dev）は local で数える", async () => {
    const { limiter, keys } = fakeLimiter(true);
    const call = appWith(limiter);

    await call("/by-ip", { "CF-Connecting-IP": "203.0.113.7" });
    await call("/by-ip");

    expect(keys).toEqual(["203.0.113.7", "local"]);
  });

  it("利用者ごとの制限は、ログインしている利用者の ID で数える", async () => {
    const { limiter, keys } = fakeLimiter(true);

    await appWith(limiter)("/by-user", { "CF-Connecting-IP": "203.0.113.7" });

    expect(keys).toEqual(["user-1"]);
  });
});
