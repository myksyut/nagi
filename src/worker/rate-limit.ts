import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiErrorResponse } from "../shared/api";
import type { AppEnv } from "./types";

/** 回数制限の窓（wrangler.jsonc の ratelimits の period）。Retry-After に使う */
const RETRY_AFTER_SECONDS = "60";

type LimiterName = "AUTH_START_LIMITER" | "AUTH_POLL_LIMITER" | "API_LIMITER";

/** 鍵ごとに数え、超えたら 429 の `rate_limited` と `Retry-After` を返す */
function rateLimit(name: LimiterName, key: (c: Context<AppEnv>) => string) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const { success } = await c.env[name].limit({ key: key(c) });
    if (success) return next();
    return c.json({ error: "rate_limited" } satisfies ApiErrorResponse, 429, {
      "Retry-After": RETRY_AFTER_SECONDS,
    });
  });
}

/** IP ごとに数える。`CF-Connecting-IP` がないとき（`pnpm dev`）は "local" */
export const limitByIp = (name: LimiterName) =>
  rateLimit(name, (c) => c.req.header("CF-Connecting-IP") ?? "local");

/** 利用者ごとに数える。requireSession のあとにかける */
export const limitByUser = (name: LimiterName) => rateLimit(name, (c) => c.get("userId"));
