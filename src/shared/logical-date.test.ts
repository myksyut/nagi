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

  // TUI の dates.rs の「夏時間の切り替えの日も_土地の時計の午前4時に切り替わる」と同じ時刻
  it.each([
    // ロサンゼルス 3/8：2 時に夏時間（-07:00）が始まる。04:00 は 11:00Z
    ["2026-03-08T10:59:59.000Z", "America/Los_Angeles", "2026-03-07"],
    ["2026-03-08T11:00:00.000Z", "America/Los_Angeles", "2026-03-08"],
    // ロサンゼルス 11/1：2 時に夏時間が終わる（-08:00）。04:00 は 12:00Z
    ["2026-11-01T11:59:59.000Z", "America/Los_Angeles", "2026-10-31"],
    ["2026-11-01T12:00:00.000Z", "America/Los_Angeles", "2026-11-01"],
    // シドニー 4/5：3 時に夏時間が終わる（+10:00）。04:00 は 4/4 18:00Z
    ["2026-04-04T17:59:59.000Z", "Australia/Sydney", "2026-04-04"],
    ["2026-04-04T18:00:00.000Z", "Australia/Sydney", "2026-04-05"],
    // シドニー 10/4：2 時に夏時間（+11:00）が始まる。04:00 は 10/3 17:00Z
    ["2026-10-03T16:59:59.000Z", "Australia/Sydney", "2026-10-03"],
    ["2026-10-03T17:00:00.000Z", "Australia/Sydney", "2026-10-04"],
    // カトマンズ（+05:45）の 10/6 04:00 は 10/5 22:15Z
    ["2026-10-05T22:14:59.000Z", "Asia/Kathmandu", "2026-10-05"],
    ["2026-10-05T22:15:00.000Z", "Asia/Kathmandu", "2026-10-06"],
  ])(
    "夏時間の切り替えの日も、土地の時計の午前4時に切り替わる：%s %s は %s",
    (time, zone, expected) => {
      expect(logicalDate(new Date(time), zone)).toBe(expected);
    },
  );
});
