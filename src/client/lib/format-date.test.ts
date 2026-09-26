import { describe, expect, it } from "vitest";
import { formatDayHeading } from "./format-date";

describe("formatDayHeading", () => {
  it("月日と曜日を出す（例：9月26日 土曜日）", () => {
    // 2026-09-26 は土曜日
    expect(formatDayHeading("2026-09-26")).toBe("9月26日 土曜日");
  });

  it("today と年が同じなら年を付けない", () => {
    expect(formatDayHeading("2026-09-28", "2026-01-01")).toBe("9月28日 月曜日");
  });

  it("today と年が違えば年を付ける", () => {
    expect(formatDayHeading("2025-12-03", "2026-01-01")).toBe("2025年12月3日 水曜日");
  });

  it("today を省略すると date 自身の年と比べる（年は付かない）", () => {
    expect(formatDayHeading("2026-01-01")).toBe("1月1日 木曜日");
  });
});
