import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { TaskLists } from "./lists";
import { LogicalDay } from "./logical-day";
import { Replica } from "./replica";

/** 4. 各リストの中身と並び */

function setup(now: () => Date = () => new Date("2026-01-15T05:00:00.000Z")) {
  const replica = new Replica();
  const day = new LogicalDay({ now, timeZone: "Asia/Tokyo" });
  const lists = new TaskLists(replica, day);
  return { replica, day, lists };
}

describe("受信箱", () => {
  it("古い順（createdAt）、同じなら id で並ぶ", () => {
    const { replica, lists } = setup();
    const b = makeTask({ bucket: "inbox", createdAt: "2026-01-02T00:00:00.000Z" });
    const a = makeTask({ bucket: "inbox", createdAt: "2026-01-01T00:00:00.000Z" });
    const c1 = makeTask({ bucket: "inbox", createdAt: "2026-01-03T00:00:00.000Z", id: "id-c1" });
    const c2 = makeTask({ bucket: "inbox", createdAt: "2026-01-03T00:00:00.000Z", id: "id-c2" });
    replica.replaceConfirmed([b, a, c2, c1].map((row) => ({ kind: "task" as const, row })));
    expect(lists.inbox.map((t) => t.id)).toEqual([a.id, b.id, "id-c1", "id-c2"]);
  });
});

describe("今日とあとで", () => {
  it("rank 順。rank が同じなら id 順", () => {
    const { replica, lists } = setup();
    const a = makeTask({ bucket: "today", rank: "b", id: "id-a" });
    const b = makeTask({ bucket: "today", rank: "a" });
    const tie1 = makeTask({ bucket: "today", rank: "m", id: "id-tie1" });
    const tie2 = makeTask({ bucket: "today", rank: "m", id: "id-tie2" });
    replica.replaceConfirmed([a, b, tie2, tie1].map((row) => ({ kind: "task" as const, row })));
    // rank は文字列の順（"a" < "b" < "m"）。同じ rank（tie1, tie2）は id 順
    expect(lists.today.map((t) => t.id)).toEqual([b.id, "id-a", "id-tie1", "id-tie2"]);
  });

  it("later も rank 順", () => {
    const { replica, lists } = setup();
    const a = makeTask({ bucket: "later", rank: "z" });
    const b = makeTask({ bucket: "later", rank: "a" });
    replica.replaceConfirmed([a, b].map((row) => ({ kind: "task" as const, row })));
    expect(lists.later.map((t) => t.id)).toEqual([b.id, a.id]);
  });
});

describe("予定", () => {
  it("日付順。同じ日は rank 順", () => {
    const { replica, lists } = setup();
    const later = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01", rank: "a" });
    const earlier = makeTask({ bucket: "scheduled", scheduledOn: "2026-01-20", rank: "z" });
    const sameA = makeTask({ bucket: "scheduled", scheduledOn: "2026-01-25", rank: "b" });
    const sameB = makeTask({ bucket: "scheduled", scheduledOn: "2026-01-25", rank: "a" });
    replica.replaceConfirmed(
      [later, earlier, sameA, sameB].map((row) => ({ kind: "task" as const, row })),
    );
    expect(lists.scheduled.map((t) => t.id)).toEqual([earlier.id, sameB.id, sameA.id, later.id]);
  });
});

describe("完了ログ", () => {
  it("完了した日ごとに新しい順で並び、今日完了したものは入らない", () => {
    const { replica, lists } = setup(() => new Date("2026-01-15T05:00:00.000Z"));
    // 論理日付は 2026-01-15（午前4時基準なので 05:00 UTC+9 でも同日）
    // 論理日付 2026-01-14 は [2026-01-13T19:00Z, 2026-01-14T19:00Z) の範囲
    const today = makeTask({ completedAt: "2026-01-15T01:00:00.000Z", id: "id-today" });
    const yesterday1 = makeTask({ completedAt: "2026-01-14T05:00:00.000Z", id: "id-y1" });
    const yesterday2 = makeTask({ completedAt: "2026-01-14T15:00:00.000Z", id: "id-y2" });
    const older = makeTask({ completedAt: "2026-01-10T10:00:00.000Z", id: "id-older" });
    replica.replaceConfirmed(
      [today, yesterday1, yesterday2, older].map((row) => ({ kind: "task" as const, row })),
    );

    const logbook = lists.logbook;
    const ids = logbook.flatMap((day) => day.tasks.map((t) => t.id));
    expect(ids).not.toContain("id-today");
    // 新しい日が先、同じ日の中は完了時刻の新しい順
    expect(logbook.map((d) => d.tasks.map((t) => t.id))).toEqual([
      ["id-y2", "id-y1"],
      ["id-older"],
    ]);
  });
});

describe("完了済み・削除済みは各リストに出ない", () => {
  it("today バケットでも完了済みは inbox/today/scheduled/later に出ない", () => {
    const { replica, lists } = setup();
    const open = makeTask({ bucket: "today", id: "id-open" });
    const completed = makeTask({
      bucket: "today",
      completedAt: "2026-01-14T00:00:00.000Z",
      id: "id-done",
    });
    const deleted = makeTask({
      bucket: "today",
      deletedAt: "2026-01-14T00:00:00.000Z",
      id: "id-deleted",
    });
    replica.replaceConfirmed(
      [open, completed, deleted].map((row) => ({ kind: "task" as const, row })),
    );
    expect(lists.today.map((t) => t.id)).toEqual(["id-open"]);
  });
});

describe("プロジェクト別", () => {
  it("lists.project(id) が today/scheduled/later/inbox/completed をそれぞれ計算する", () => {
    const { replica, lists } = setup();
    const projectId = "proj-1";
    const other = "proj-2";
    const inbox = makeTask({ bucket: "inbox", projectId, id: "id-inbox" });
    const today = makeTask({ bucket: "today", projectId, id: "id-today" });
    const scheduled = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-02-01",
      projectId,
      id: "id-scheduled",
    });
    const later = makeTask({ bucket: "later", projectId, id: "id-later" });
    const completed = makeTask({
      bucket: "later",
      completedAt: "2026-01-01T00:00:00.000Z",
      projectId,
      id: "id-completed",
    });
    const notInProject = makeTask({ bucket: "today", projectId: other, id: "id-other" });
    replica.replaceConfirmed(
      [inbox, today, scheduled, later, completed, notInProject].map((row) => ({
        kind: "task" as const,
        row,
      })),
    );

    const groups = lists.project(projectId);
    expect(groups.inbox.map((t) => t.id)).toEqual(["id-inbox"]);
    expect(groups.today.map((t) => t.id)).toEqual(["id-today"]);
    expect(groups.scheduled.map((t) => t.id)).toEqual(["id-scheduled"]);
    expect(groups.later.map((t) => t.id)).toEqual(["id-later"]);
    expect(groups.completed.map((t) => t.id)).toEqual(["id-completed"]);
  });
});

describe("lists.projects", () => {
  it("アーカイブ済み・削除済みを除いて作成順に並ぶ", () => {
    const { replica, lists } = setup();
    const p1 = makeProject({ createdAt: "2026-01-01T00:00:00.000Z", id: "p1" });
    const p2 = makeProject({ createdAt: "2026-01-02T00:00:00.000Z", id: "p2" });
    const archived = makeProject({
      createdAt: "2026-01-03T00:00:00.000Z",
      archivedAt: "2026-01-04T00:00:00.000Z",
      id: "p-archived",
    });
    const deleted = makeProject({
      createdAt: "2026-01-04T00:00:00.000Z",
      deletedAt: "2026-01-05T00:00:00.000Z",
      id: "p-deleted",
    });
    replica.replaceConfirmed(
      [p2, p1, archived, deleted].map((row) => ({ kind: "project" as const, row })),
    );
    expect(lists.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });
});

describe("日付の切り替わりの前後", () => {
  it("completedToday / completedTodayCount は午前4時（Asia/Tokyo）をまたぐと切り替わる", () => {
    // 2026-01-15 03:59:59 JST = 2026-01-14 18:59:59Z（論理日付はまだ 1/14）
    const beforeBoundary = () => new Date("2026-01-14T18:59:59.000Z");
    const { replica, lists, day } = setup(beforeBoundary);
    expect(day.today).toBe("2026-01-14");

    // 1/14 のあいだに完了したタスク
    const completed = makeTask({ completedAt: "2026-01-14T12:00:00.000Z", bucket: "later" });
    replica.replaceConfirmed([{ kind: "task", row: completed }]);
    expect(lists.completedTodayCount).toBe(1);

    // 4:00:00 JST（= 2026-01-14T19:00:00Z）で日付が変わる
    const day2 = new LogicalDay({
      now: () => new Date("2026-01-14T19:00:00.000Z"),
      timeZone: "Asia/Tokyo",
    });
    const lists2 = new TaskLists(replica, day2);
    expect(day2.today).toBe("2026-01-15");
    // 1/14 に完了したものは、もう「今日の完了」ではない
    expect(lists2.completedTodayCount).toBe(0);
    // 完了ログには入る
    expect(lists2.logbook.flatMap((d) => d.tasks.map((t) => t.id))).toContain(completed.id);
  });

  it("到着の印（isArrivedToday）は arrivedOn が今日のときだけ true", () => {
    const { replica, lists, day } = setup(() => new Date("2026-01-15T05:00:00.000Z"));
    const arrivedToday = makeTask({ bucket: "today", arrivedOn: day.today, id: "id-arrived" });
    const arrivedYesterday = makeTask({ bucket: "today", arrivedOn: "2026-01-14", id: "id-old" });
    const neverArrived = makeTask({ bucket: "today", arrivedOn: null, id: "id-none" });
    replica.replaceConfirmed(
      [arrivedToday, arrivedYesterday, neverArrived].map((row) => ({
        kind: "task" as const,
        row,
      })),
    );
    const today = lists.today;
    const byId = (id: string) => {
      const row = today.find((t) => t.id === id);
      if (!row) throw new Error(`not found: ${id}`);
      return row;
    };
    expect(lists.isArrivedToday(byId("id-arrived"))).toBe(true);
    expect(lists.isArrivedToday(byId("id-old"))).toBe(false);
    expect(lists.isArrivedToday(byId("id-none"))).toBe(false);
  });
});
