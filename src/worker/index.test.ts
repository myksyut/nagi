import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
