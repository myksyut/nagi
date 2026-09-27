import { describe, expect, it } from "vitest";
import { TaskRow } from "@/data/rows";
import { makeTask } from "@/test/fixtures";
import {
  daysBetween,
  deadlineStatus,
  formatLongDate,
  formatShortDate,
  formatShortDateWithWeekday,
  scheduleHeading,
  sectionsByDate,
} from "./labels";

const TODAY = "2026-09-28"; // 月曜

describe("daysBetween", () => {
  it("先の日付は正、過去は負、同じ日は0", () => {
    expect(daysBetween(TODAY, "2026-10-02")).toBe(4);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween(TODAY, "2026-09-26")).toBe(-2);
  });
});

describe("formatShortDate・formatShortDateWithWeekday・formatLongDate", () => {
  it("同じ年は月/日だけ", () => {
    expect(formatShortDate("2026-10-02", TODAY)).toBe("10/2");
    expect(formatShortDateWithWeekday("2026-10-02", TODAY)).toBe("10/2(金)");
    expect(formatLongDate("2026-10-05", TODAY)).toBe("10月5日(月)");
  });

  it("年が違えば年を付ける", () => {
    expect(formatShortDate("2027-01-04", TODAY)).toBe("2027/1/4");
    expect(formatShortDateWithWeekday("2027-01-04", TODAY)).toBe("2027/1/4(月)");
    expect(formatLongDate("2027-01-04", TODAY)).toBe("2027年1月4日(月)");
  });
});

describe("deadlineStatus：4段階と境目", () => {
  it("4日以上先は「締切 M/D」（plain）", () => {
    expect(deadlineStatus("2026-10-02", TODAY)).toEqual({ tone: "plain", label: "締切 10/2" });
  });

  it("3日以内は「あとN日」（soon）", () => {
    expect(deadlineStatus("2026-10-01", TODAY)).toEqual({ tone: "soon", label: "あと3日" });
    expect(deadlineStatus("2026-09-29", TODAY)).toEqual({ tone: "soon", label: "あと1日" });
  });

  it("当日は「今日まで」（today）", () => {
    expect(deadlineStatus(TODAY, TODAY)).toEqual({ tone: "today", label: "今日まで" });
  });

  it("過ぎたら「N日超過」（overdue）", () => {
    expect(deadlineStatus("2026-09-27", TODAY)).toEqual({ tone: "overdue", label: "1日超過" });
    expect(deadlineStatus("2026-09-26", TODAY)).toEqual({ tone: "overdue", label: "2日超過" });
  });

  it("境目：+4日は plain、+3日は soon", () => {
    expect(deadlineStatus("2026-10-02", TODAY).tone).toBe("plain"); // +4
    expect(deadlineStatus("2026-10-01", TODAY).tone).toBe("soon"); // +3
  });

  it("境目：+1日は soon、0日は today、-1日は overdue", () => {
    expect(deadlineStatus("2026-09-29", TODAY).tone).toBe("soon"); // +1
    expect(deadlineStatus(TODAY, TODAY).tone).toBe("today"); // 0
    expect(deadlineStatus("2026-09-27", TODAY).tone).toBe("overdue"); // -1
  });

  it("年が違えば「締切 2027/1/4」", () => {
    expect(deadlineStatus("2027-01-04", TODAY)).toEqual({
      tone: "plain",
      label: "締切 2027/1/4",
    });
  });
});

describe("scheduleHeading", () => {
  it("今日・明日・それ以外", () => {
    expect(scheduleHeading(TODAY, TODAY)).toBe("今日");
    expect(scheduleHeading("2026-09-29", TODAY)).toBe("明日");
    expect(scheduleHeading("2026-10-02", TODAY)).toBe("10/2(金)");
  });
});

describe("sectionsByDate", () => {
  it("日付ごとにまとまり、見出しが付く", () => {
    const rows = [
      new TaskRow(makeTask({ title: "A", scheduledOn: TODAY })),
      new TaskRow(makeTask({ title: "B", scheduledOn: TODAY })),
      new TaskRow(makeTask({ title: "C", scheduledOn: "2026-09-29" })),
      new TaskRow(makeTask({ title: "D", scheduledOn: "2026-10-02" })),
    ];
    const sections = sectionsByDate(rows, TODAY);
    expect(sections.map((s) => s.heading)).toEqual(["今日", "明日", "10/2(金)"]);
    expect(sections.map((s) => s.rows.map((r) => r.title))).toEqual([["A", "B"], ["C"], ["D"]]);
  });

  it("行が空なら、まとまりも空", () => {
    expect(sectionsByDate([], TODAY)).toEqual([]);
  });
});
