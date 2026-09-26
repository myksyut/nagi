import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("知らない URL", () => {
  it("/api/* の下は 401 が先に立つ（セッションがないので）", async () => {
    const res = await exports.default.fetch("https://nagi.example.com/api/does-not-exist");
    expect(res.status).toBe(401);
  });

  it("/api/* でも /auth/* でもなければ 404 の JSON", async () => {
    const res = await exports.default.fetch("https://nagi.example.com/does-not-exist");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });

  it("/auth/ 配下の知らないパスも 404", async () => {
    const res = await exports.default.fetch("https://nagi.example.com/auth/does-not-exist");
    expect(res.status).toBe(404);
  });
});
