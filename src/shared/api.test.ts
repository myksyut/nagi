import { describe, expect, it } from "vitest";
import { API_VERSION } from "./api";

describe("API_VERSION", () => {
  it("API_VERSION は現在 2 である（回帰の目印。2 で進行中とプロジェクトの色を足した）", () => {
    expect(API_VERSION).toBe(2);
  });
});
