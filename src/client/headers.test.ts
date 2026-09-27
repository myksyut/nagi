import { describe, expect, it } from "vitest";
import headers from "../../public/_headers?raw";

/**
 * チケット8：public/_headers。`/assets/*`（Vite がハッシュを付けたファイル）だけを長くキャッシュさせる。
 * index.html・sw.js・offline.html は既定（毎回確かめる）のままにする
 */

describe("_headers", () => {
  it("/assets/* に、長い immutable のキャッシュを付ける", () => {
    const match = headers.match(/^\/assets\/\*\r?\n((?:[ \t].*\r?\n?)*)/m);
    expect(match?.[1]).toBeDefined();
    expect(match?.[1]).toMatch(/Cache-Control:\s*public, max-age=31536000, immutable/);
  });

  it("index.html・sw.js・offline.html には触らない（既定の max-age=0 のまま）", () => {
    for (const path of ["/index.html", "/sw.js", "/offline.html"]) {
      expect(headers).not.toContain(path);
    }
  });
});
