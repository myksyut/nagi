/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_VERSION, MIN_API_VERSION } from "./api";

describe("API の版", () => {
  it("Worker が受ける範囲は MIN_API_VERSION から API_VERSION まで（下限が上限を超えない）", () => {
    expect(MIN_API_VERSION).toBeLessThanOrEqual(API_VERSION);
  });

  it("TUI（tui/src/model.rs）の API_VERSION が、TypeScript の API_VERSION と同じ", () => {
    const source = readFileSync(new URL("../../tui/src/model.rs", import.meta.url), "utf8");
    const match = source.match(/^pub const API_VERSION: u32 = (\d+);$/m);
    expect(match?.[1]).toBeDefined();
    expect(Number(match?.[1])).toBe(API_VERSION);
  });
});
