import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 書き込みのリクエスト（POST など）は、Origin が自分の URL であることと、本文が JSON であることを確かめる。
 * 別のサイトのフォームや、単純なリクエストからの書き込みを防ぐ
 */
export const requireSameOriginJson = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  if (c.req.header("Origin") !== new URL(c.req.url).origin) {
    return c.json({ error: "forbidden_origin" }, 403);
  }
  const contentType = c.req.header("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  return next();
});
