import { computed, reaction } from "mobx";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { TaskRow } from "@/data/rows";
import { FakeServer } from "@/test/fake-server";
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

describe("sectionsByDate の計算し直し（予定の画面の見出し）", () => {
  const stores: AppStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
  });

  /** 予定のリストからまとまりを作る計算と、それが計算し直された回数 */
  async function setup(tasks: { title: string; scheduledOn: string; rank: string }[]) {
    const server = new FakeServer();
    for (const task of tasks) server.putTask(makeTask({ ...task, bucket: "scheduled" }));
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
    });
    stores.push(store);
    await store.start();
    let runs = 0;
    const sections = computed(() => {
      runs++;
      return sectionsByDate(store.lists.scheduled, TODAY);
    });
    const headings = () => sections.get().map((section) => section.heading);
    const dispose = reaction(headings, () => {});
    return { store, headings, runs: () => runs, dispose };
  }

  const idOf = (store: AppStore, title: string) =>
    store.lists.scheduled.find((task) => task.title === title)?.id ?? "";

  it("1件だけの予定日を変えると、見出しが変わる（行の並びは変わらない）", async () => {
    const { store, headings, dispose } = await setup([
      { title: "A", scheduledOn: "2026-10-05", rank: "a0" },
    ]);
    expect(headings()).toEqual(["10/5(月)"]);
    store.actions.moveTasks([idOf(store, "A")], { bucket: "scheduled", on: "2026-10-06" });
    expect(headings()).toEqual(["10/6(火)"]);
    dispose();
  });

  it("並びが変わらない複数件で予定日を変えても、見出しが変わる", async () => {
    const { store, headings, dispose } = await setup([
      { title: "A", scheduledOn: "2026-10-05", rank: "a0" },
      { title: "B", scheduledOn: "2026-10-07", rank: "a0" },
    ]);
    expect(headings()).toEqual(["10/5(月)", "10/7(水)"]);
    store.actions.moveTasks([idOf(store, "A")], { bucket: "scheduled", on: "2026-10-06" });
    expect(store.lists.scheduled.map((task) => task.title)).toEqual(["A", "B"]);
    expect(headings()).toEqual(["10/6(火)", "10/7(水)"]);
    dispose();
  });

  it("タイトルを直しただけでは、まとまりを計算し直さない", async () => {
    const { store, runs, dispose } = await setup([
      { title: "A", scheduledOn: "2026-10-05", rank: "a0" },
      { title: "B", scheduledOn: "2026-10-07", rank: "a0" },
    ]);
    const before = runs();
    store.actions.updateTask(idOf(store, "A"), { title: "A2" });
    store.actions.updateTask(idOf(store, "B"), { memo: "メモ" });
    expect(runs()).toBe(before);
    store.actions.moveTasks([idOf(store, "B")], { bucket: "scheduled", on: "2026-10-08" });
    expect(runs()).toBe(before + 1);
    dispose();
  });
});
