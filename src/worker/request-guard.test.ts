import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://nagi.example.com";

function postLogout(headers: Record<string, string>, body: string = "{}") {
  return exports.default.fetch(`${ORIGIN}/auth/logout`, { method: "POST", headers, body });
}

describe("requireSameOriginJson", () => {
  it.each(["GET", "HEAD", "OPTIONS"] as const)(
    "%s は Origin が違っても・なくても弾かれない",
    async (method) => {
      for (const headers of [{ Origin: "https://evil.example.com" }, {}] as HeadersInit[]) {
        const res = await exports.default.fetch(`${ORIGIN}/api/session`, { method, headers });
        // ログインなしなので 401 にはなるが、403/415 にはならない
        expect(res.status).toBe(401);
      }
    },
  );

  it("POST で Origin がなければ通る（TUI や curl は Origin を付けない）", async () => {
    const res = await postLogout({ "Content-Type": "application/json" });
    expect(res.status).toBe(204);
  });

  it("POST で Origin が自分の URL と同じなら通る", async () => {
    const res = await postLogout({ Origin: ORIGIN, "Content-Type": "application/json" });
    expect(res.status).toBe(204);
  });

  it.each([
    ["別のサイト", "https://evil.example.com"],
    ["スキームが違う", "http://nagi.example.com"],
    ["ポートが違う", "https://nagi.example.com:8443"],
    ["null（サンドボックスの中のページなど）", "null"],
  ])("POST で Origin が自分の URL と違えば 403：%s", async (_label, origin) => {
    const res = await postLogout({ Origin: origin, "Content-Type": "application/json" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden_origin" });
  });

  it("別の Origin からの POST は、ログインの口（/auth/device/*）でも 403", async () => {
    for (const path of ["/auth/device/start", "/auth/device/token"]) {
      const res = await exports.default.fetch(`${ORIGIN}${path}`, {
        method: "POST",
        headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(403);
    }
  });

  it.each([
    ["Origin なし", {}],
    ["同じ Origin", { Origin: ORIGIN }],
  ])("POST で Content-Type が JSON でなければ 415（%s）", async (_label, originHeader) => {
    const res = await postLogout(
      { ...originHeader, "Content-Type": "application/x-www-form-urlencoded" },
      "a=b",
    );
    expect(res.status).toBe(415);
    expect(await res.json()).toEqual({ error: "unsupported_media_type" });
  });

  it("POST で Content-Type がなければ 415", async () => {
    const res = await exports.default.fetch(`${ORIGIN}/auth/logout`, { method: "POST" });
    expect(res.status).toBe(415);
  });

  it.each(["application/json", "application/json; charset=utf-8", "Application/JSON"])(
    "Content-Type: %s は通る",
    async (contentType) => {
      const res = await postLogout({ "Content-Type": contentType });
      expect(res.status).toBe(204);
    },
  );
});
