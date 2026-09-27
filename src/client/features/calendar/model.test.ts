import { describe, expect, it } from "vitest";
import { monthWeeks, weekdayOf } from "./model";

/**
 * チケット13の完了の条件1（の一部）：月の表の週（monthWeeks）が、月末・月初・年またぎでも
 * 日曜始まりで正しく組めること。native Date（実装とは独立に曜日を数える）と突き合わせて確かめる
 */

function jsWeekday(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function lastDayOfMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(day).padStart(2, "0")}`;
}

const MONTHS = [
  "2026-09", // 見出しの他のテストで曜日が確かめられている月
  "2026-08", // 31日で終わる月
  "2026-12", // 年またぎ（12月→1月）
  "2027-01", // 年またぎの先
  "2024-02", // うるう年の2月
  "2025-02", // 平年の2月
];

describe("weekdayOf", () => {
  it("Date.UTC の曜日（0が日曜）と一致する", () => {
    for (const date of ["2026-09-01", "2026-09-27", "2026-09-28", "2026-12-31", "2027-01-01"]) {
      expect(weekdayOf(date)).toBe(jsWeekday(date));
    }
  });
});

describe("monthWeeks", () => {
  it("各週は7日で、日曜始まり・土曜終わり", () => {
    for (const month of MONTHS) {
      for (const week of monthWeeks(month)) {
        expect(week).toHaveLength(7);
        expect(jsWeekday(week[0] as string)).toBe(0);
        expect(jsWeekday(week[6] as string)).toBe(6);
      }
    }
  });

  it("日が1日ずつ連続している（重複や飛びがない）", () => {
    for (const month of MONTHS) {
      const days = monthWeeks(month).flat();
      for (let i = 1; i < days.length; i++) {
        const prev = new Date(`${days[i - 1]}T00:00:00.000Z`).getTime();
        const cur = new Date(`${days[i]}T00:00:00.000Z`).getTime();
        expect(cur - prev).toBe(24 * 60 * 60 * 1000);
      }
    }
  });

  it("その月の1日と末日をどちらも含む", () => {
    for (const month of MONTHS) {
      const days = monthWeeks(month).flat();
      expect(days).toContain(`${month}-01`);
      expect(days).toContain(lastDayOfMonth(month));
    }
  });

  it("前後の月の日がはみ出すのは、週の中の分だけ（前後1週間より多くはみ出さない）", () => {
    for (const month of MONTHS) {
      const days = monthWeeks(month).flat();
      const first = `${month}-01`;
      const last = lastDayOfMonth(month);
      const before = days.filter((d) => d < first);
      const after = days.filter((d) => d > last);
      expect(before.length).toBeLessThanOrEqual(6);
      expect(after.length).toBeLessThanOrEqual(6);
    }
  });

  it("年またぎ（12月→1月）でも、前後の月の日を含めて正しく組まれる", () => {
    const days = monthWeeks("2026-12").flat();
    expect(days.some((d) => d.startsWith("2027-01"))).toBe(true);
    expect(days).toContain("2026-12-01");
    expect(days).toContain("2026-12-31");
  });
});
