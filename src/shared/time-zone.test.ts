import { describe, expect, it } from "vitest";
import { timeZoneSchema } from "./time-zone";

describe("timeZoneSchema", () => {
  it("読める名前は通る", () => {
    expect(timeZoneSchema.safeParse("Asia/Tokyo").success).toBe(true);
    expect(timeZoneSchema.safeParse("America/Los_Angeles").success).toBe(true);
  });

  it("読めない名前は落ちる", () => {
    expect(timeZoneSchema.safeParse("Mars/Base").success).toBe(false);
    expect(timeZoneSchema.safeParse("").success).toBe(false);
  });

  it("65 文字は落ちる", () => {
    expect(timeZoneSchema.safeParse("A".repeat(65)).success).toBe(false);
  });
});
