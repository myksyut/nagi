import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./types";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 書き込みのリクエスト（POST など）は、本文が JSON であることを確かめる。
 * Origin は、付いているときだけ、自分の URL と同じであることを確かめる。
 * ブラウザは POST に必ず Origin を付けるので、別のサイトのフォームやスクリプトからの書き込みは止まる
 * （手元で AUTH_DISABLED にしているときも）。Origin を付けない TUI や curl は通る
 */
export const requireSameOriginJson = createMiddleware<AppEnv>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const origin = c.req.header("Origin");
  if (origin !== undefined && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "forbidden_origin" }, 403);
  }
  const contentType = c.req.header("Content-Type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return c.json({ error: "unsupported_media_type" }, 415);
  }
  return next();
});
