import { describe, expect, it } from "vitest";
import { logicalDate } from "./logical-date";

describe("logicalDate", () => {
  it("★ 午前4時の境目（Asia/Tokyo）：3:59:59.999 は前日、4:00:00.000 は当日", () => {
    expect(logicalDate(new Date("2026-09-28T03:59:59.999+09:00"))).toBe("2026-09-27");
    expect(logicalDate(new Date("2026-09-28T04:00:00.000+09:00"))).toBe("2026-09-28");
  });

  it("深夜0時台は前日になる", () => {
    expect(logicalDate(new Date("2026-09-28T00:30:00+09:00"))).toBe("2026-09-27");
  });

  it("年をまたぐ", () => {
    expect(logicalDate(new Date("2027-01-01T03:59:59+09:00"))).toBe("2026-12-31");
    expect(logicalDate(new Date("2027-01-01T04:00:00+09:00"))).toBe("2027-01-01");
  });

  it("月をまたぐ", () => {
    expect(logicalDate(new Date("2026-10-01T03:59:59+09:00"))).toBe("2026-09-30");
    expect(logicalDate(new Date("2026-10-01T04:00:00+09:00"))).toBe("2026-10-01");
  });

  it("timeZone引数（UTC）でも同じ境目になる", () => {
    expect(logicalDate(new Date("2026-09-28T03:59:59.999Z"), "UTC")).toBe("2026-09-27");
    expect(logicalDate(new Date("2026-09-28T04:00:00.000Z"), "UTC")).toBe("2026-09-28");
  });
});
