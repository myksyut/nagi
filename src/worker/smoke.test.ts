import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("Cookie なしの /api/* は 401", async () => {
  const res = await exports.default.fetch("https://nagi.example.com/api/session");
  expect(res.status).toBe(401);
});
