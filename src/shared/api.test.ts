import { describe, expect, it } from "vitest";
import { API_VERSION } from "./api";

describe("API_VERSION", () => {
  it("API_VERSION は現在 3 である（回帰の目印。2 で進行中とプロジェクトの色、3 で優先度と工数を足した）", () => {
    expect(API_VERSION).toBe(3);
  });
});
