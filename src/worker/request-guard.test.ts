import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://nagi.example.com";

describe("requireSameOriginJson", () => {
  it.each(["GET", "HEAD", "OPTIONS"] as const)(
    "%s は Origin が違っても・なくても弾かれない",
    async (method) => {
      const res = await exports.default.fetch(`${ORIGIN}/api/session`, {
        method,
        headers: { Origin: "https://evil.example.com" },
      });
      // ログインなしなので 401 にはなるが、403/415 にはならない
      expect(res.status).toBe(401);
    },
  );

  it("POST で Origin が違えば 403", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_origin" });
  });

  it("POST で Origin がなければ 403", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  it("POST で Content-Type が JSON でなければ 415", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/x-www-form-urlencoded" },
      body: "a=b",
    });
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media_type" });
  });

  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])(
    "Content-Type: %s は通る",
    async (contentType) => {
      const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": contentType },
        body: "{}",
      });
      expect(res.status).toBe(204);
    },
  );
});
