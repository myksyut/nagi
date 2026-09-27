import { autorun, reaction } from "mobx";
import { describe, expect, it, vi } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { PROJECT_BOARD_COMPLETED_DAYS, TaskLists } from "./lists";
import { LogicalDay } from "./logical-day";
import { Replica } from "./replica";

/** 4. 各リストの中身と並び。10：ボードの計算（todayBoard・projectBoard・projectColors）と観測の取りこぼし */

function setup(now: () => Date = () => new Date("2026-01-15T05:00:00.000Z")) {
  const replica = new Replica();
  const day = new LogicalDay({ now, timeZone: "Asia/Tokyo" });
  const lists = new TaskLists(replica, day);
  return { replica, day, lists };
}

let seqCounter = 0;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
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

describe("todayBoard", () => {
  it("今日のタスクを未着手・進行中・完了に分ける。未着手と進行中は今日の並び順、完了は completedToday と同じ", () => {
    const { replica, lists } = setup();
    const notStarted = makeTask({ bucket: "today", rank: "a1" });
    const inProgress = makeTask({
      bucket: "today",
      rank: "a0",
      startedAt: "2026-01-15T00:00:00.000Z",
    });
    const completed = makeTask({
      bucket: "later",
      completedAt: "2026-01-15T01:00:00.000Z",
    });
    const notToday = makeTask({ bucket: "later" });
    replica.replaceConfirmed(
      [notStarted, inProgress, completed, notToday].map((row) => ({
        kind: "task" as const,
        row,
      })),
    );

    const board = lists.todayBoard;
    expect(board.notStarted.map((t) => t.id)).toEqual([notStarted.id]);
    expect(board.inProgress.map((t) => t.id)).toEqual([inProgress.id]);
    expect(board.completed.map((t) => t.id)).toEqual([completed.id]);
    expect(lists.inProgressToday.map((t) => t.id)).toEqual([inProgress.id]);
    expect(lists.inProgressTodayCount).toBe(1);
  });
});

describe("projectBoard", () => {
  it("未着手は置き場ごと（今日は進行中を除く）、進行中は今日の並び順、完了は直近 PROJECT_BOARD_COMPLETED_DAYS 日", () => {
    const { replica, lists } = setup();
    const projectId = "proj-1";
    const todayNotStarted = makeTask({ bucket: "today", rank: "a0", projectId });
    const todayInProgress = makeTask({
      bucket: "today",
      rank: "a1",
      projectId,
      startedAt: "2026-01-15T00:00:00.000Z",
    });
    const scheduled = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01", projectId });
    const later = makeTask({ bucket: "later", projectId });
    const inbox = makeTask({ bucket: "inbox", projectId });
    // 直近7日（今日を含む論理日付）に完了したもの
    const recentlyCompleted = makeTask({
      bucket: "later",
      projectId,
      completedAt: "2026-01-10T00:00:00.000Z",
    });
    // 7日より前に完了したもの（プロジェクトのボードの完了列には出ない）
    const oldCompleted = makeTask({
      bucket: "later",
      projectId,
      completedAt: "2025-12-01T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [
        todayNotStarted,
        todayInProgress,
        scheduled,
        later,
        inbox,
        recentlyCompleted,
        oldCompleted,
      ].map((row) => ({ kind: "task" as const, row })),
    );

    const board = lists.projectBoard(projectId);
    expect(board.notStarted.today.map((t) => t.id)).toEqual([todayNotStarted.id]);
    expect(board.notStarted.scheduled.map((t) => t.id)).toEqual([scheduled.id]);
    expect(board.notStarted.later.map((t) => t.id)).toEqual([later.id]);
    expect(board.notStarted.inbox.map((t) => t.id)).toEqual([inbox.id]);
    expect(board.inProgress.map((t) => t.id)).toEqual([todayInProgress.id]);
    expect(board.completed.map((t) => t.id)).toEqual([recentlyCompleted.id]);
    expect(lists.inProgressCountOfProject(projectId)).toBe(1);
  });

  it("完了の境目は PROJECT_BOARD_COMPLETED_DAYS 日ちょうど前の論理日付を含む", () => {
    const { replica, lists, day } = setup();
    const projectId = "proj-1";
    const boundary = makeTask({
      bucket: "later",
      projectId,
      completedAt: `2026-01-${String(15 - (PROJECT_BOARD_COMPLETED_DAYS - 1)).padStart(2, "0")}T05:00:00.000Z`,
    });
    replica.replaceConfirmed([{ kind: "task", row: boundary }]);
    expect(day.today).toBe("2026-01-15");
    expect(lists.projectBoard(projectId).completed.map((t) => t.id)).toEqual([boundary.id]);
  });
});

describe("projectColors / projectColor", () => {
  it("color があればその色、なければ作成順（アーカイブ済みも数に入る）で決まる色。削除済みは undefined", () => {
    const { replica, lists } = setup();
    const first = makeProject({ createdAt: "2026-01-01T00:00:00.000Z" });
    const archived = makeProject({
      createdAt: "2026-01-02T00:00:00.000Z",
      archivedAt: "2026-01-03T00:00:00.000Z",
    });
    const withColor = makeProject({ createdAt: "2026-01-03T00:00:00.000Z", color: "pink" });
    const deleted = makeProject({
      createdAt: "2026-01-04T00:00:00.000Z",
      deletedAt: "2026-01-05T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [first, archived, withColor, deleted].map((row) => ({ kind: "project" as const, row })),
    );

    expect(lists.projectColor(first.id)).toBe("violet");
    expect(lists.projectColor(archived.id)).toBe("sky");
    expect(lists.projectColor(withColor.id)).toBe("pink");
    expect(lists.projectColor(deleted.id)).toBeUndefined();
    expect(lists.projectColors.size).toBe(3);
  });
});

describe("10-修正1：projectColor(id) は ID ごとに、色に効く項目だけを観測する", () => {
  function coloredSetup() {
    const { replica, lists } = setup();
    const a = makeProject({ createdAt: "2026-01-01T00:00:00.000Z", seq: nextSeq() });
    const b = makeProject({ createdAt: "2026-01-02T00:00:00.000Z", seq: nextSeq() });
    replica.replaceConfirmed([a, b].map((row) => ({ kind: "project" as const, row })));
    return { replica, lists, a, b };
  }

  it("A の色を読む autorun は、B の色が変わっても再実行されない。A の色が変わると再実行される", () => {
    const { replica, lists, a, b } = coloredSetup();
    let runs = 0;
    let seen: string | undefined;
    const dispose = autorun(() => {
      seen = lists.projectColor(a.id);
      runs++;
    });
    expect([runs, seen]).toEqual([1, "violet"]);

    replica.mergeConfirmed([{ kind: "project", row: { ...b, color: "amber", seq: nextSeq() } }]);
    expect(lists.projectColor(b.id)).toBe("amber");
    expect(runs).toBe(1);

    replica.mergeConfirmed([{ kind: "project", row: { ...a, color: "teal", seq: nextSeq() } }]);
    expect([runs, seen]).toEqual([2, "teal"]);
    dispose();
  });

  it("A の名前やアーカイブを変えても、色の計算は B を読み直さない（作成順の並べ直しも色の一覧の計算もしない）", () => {
    const { replica, lists, a, b } = coloredSetup();
    let runs = 0;
    const dispose = autorun(() => {
      void [lists.projectColor(a.id), lists.projectColor(b.id), lists.projectColors];
      runs++;
    });
    const rowA = replica.project(a.id);
    const rowB = replica.project(b.id);
    if (!rowA || !rowB) throw new Error("row が見つかりません");
    // 行の読み方（peek と field）は共通の親クラスにある
    const base = Object.getPrototypeOf(Object.getPrototypeOf(rowB));
    const peek = vi.spyOn(base, "peek");
    const field = vi.spyOn(base, "field");

    replica.mergeConfirmed([
      { kind: "project", row: { ...a, name: "新しい名前", seq: nextSeq() } },
    ]);
    replica.mergeConfirmed([
      {
        kind: "project",
        row: { ...a, name: "新しい名前", archivedAt: "2026-01-05T00:00:00.000Z", seq: nextSeq() },
      },
    ]);

    const readsOfB = [...peek.mock.contexts, ...field.mock.contexts].filter(
      (context) => context === rowB,
    );
    expect(readsOfB).toEqual([]);
    expect(runs).toBe(1);
    peek.mockRestore();
    field.mockRestore();
    dispose();
  });

  it("作成順が変わる変更（前のプロジェクトの削除・作成の時刻）には追いつく", () => {
    const { replica, lists, a, b } = coloredSetup();
    const seen: (string | undefined)[] = [];
    const dispose = reaction(
      () => lists.projectColor(b.id),
      (color) => seen.push(color),
    );
    expect(lists.projectColor(b.id)).toBe("sky");

    // A を B より後に作ったことにする → B が先頭
    replica.mergeConfirmed([
      { kind: "project", row: { ...a, createdAt: "2026-01-03T00:00:00.000Z", seq: nextSeq() } },
    ]);
    expect(seen).toEqual(["violet"]);
    expect(lists.projectColor(a.id)).toBe("sky");

    // 新しいプロジェクトが先頭に入ると、B は2番目に戻る
    const c = makeProject({ createdAt: "2025-12-31T00:00:00.000Z", seq: nextSeq() });
    replica.mergeConfirmed([{ kind: "project", row: c }]);
    expect(seen).toEqual(["violet", "sky"]);

    // 先頭（C）を削除すると、B はまた先頭。削除したプロジェクトの色は undefined
    replica.mergeConfirmed([
      { kind: "project", row: { ...c, deletedAt: "2026-01-06T00:00:00.000Z", seq: nextSeq() } },
    ]);
    expect(seen).toEqual(["violet", "sky", "violet"]);
    expect(lists.projectColor(c.id)).toBeUndefined();
    expect(lists.projectColor("no-such-project")).toBeUndefined();
    dispose();
  });
});

describe("観測の取りこぼしがないこと", () => {
  it("並びが変わらないまま進行中にする・戻すと、todayBoard を読む autorun が再実行される", () => {
    const { replica, lists } = setup();
    const task = makeTask({ bucket: "today", rank: "a0", seq: nextSeq() });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    let seen: string[] = [];
    const dispose = autorun(() => {
      seen = lists.todayBoard.inProgress.map((t) => t.id);
    });
    expect(seen).toEqual([]);

    // 別のタブが同じタスクを進行中にした、という体で確定データに差分を重ねる（並びは変わらない）
    replica.mergeConfirmed([
      {
        kind: "task",
        row: { ...task, startedAt: "2026-01-15T00:00:00.000Z", seq: nextSeq() },
      },
    ]);
    expect(seen).toEqual([task.id]);

    replica.mergeConfirmed([{ kind: "task", row: { ...task, startedAt: null, seq: nextSeq() } }]);
    expect(seen).toEqual([]);

    dispose();
  });

  it("タイトルだけを変えても、todayBoard と projectColors を読む reaction は動かない", () => {
    const { replica, lists } = setup();
    const task = makeTask({ bucket: "today", seq: nextSeq() });
    const project = makeProject({ createdAt: "2026-01-01T00:00:00.000Z", seq: nextSeq() });
    replica.replaceConfirmed([
      { kind: "task", row: task },
      { kind: "project", row: project },
    ]);

    const taskSpy: unknown[] = [];
    const disposeTask = reaction(
      () => lists.todayBoard,
      (v) => taskSpy.push(v),
    );
    const colorSpy: unknown[] = [];
    const disposeColor = reaction(
      () => lists.projectColors,
      (v) => colorSpy.push(v),
    );

    replica.mergeConfirmed([
      { kind: "task", row: { ...task, title: "新しいタイトル", seq: nextSeq() } },
    ]);
    replica.mergeConfirmed([
      { kind: "project", row: { ...project, name: "新しい名前", seq: nextSeq() } },
    ]);

    expect(taskSpy).toHaveLength(0);
    expect(colorSpy).toHaveLength(0);

    disposeTask();
    disposeColor();
  });

  it("TaskRow：startedAt・status・isInProgress は項目ごとに観測する（タイトル変更では動かず、startedAt の変化で動く）", () => {
    const { replica } = setup();
    const task = makeTask({ bucket: "today", seq: nextSeq() });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const row = replica.task(task.id);
    if (!row) throw new Error("row が見つかりません");

    let startedAtRuns = 0;
    let isInProgressRuns = 0;
    const disposeStarted = autorun(() => {
      void row.startedAt;
      startedAtRuns++;
    });
    const disposeStatus = autorun(() => {
      void row.isInProgress;
      isInProgressRuns++;
    });
    expect(startedAtRuns).toBe(1);
    expect(isInProgressRuns).toBe(1);

    replica.mergeConfirmed([
      { kind: "task", row: { ...task, title: "新しいタイトル", seq: nextSeq() } },
    ]);
    expect(startedAtRuns).toBe(1);
    expect(isInProgressRuns).toBe(1);

    replica.mergeConfirmed([
      { kind: "task", row: { ...task, startedAt: "2026-01-15T00:00:00.000Z", seq: nextSeq() } },
    ]);
    expect(startedAtRuns).toBe(2);
    expect(isInProgressRuns).toBe(2);
    expect(row.status).toBe("in-progress");

    disposeStarted();
    disposeStatus();
  });

  it("ProjectRow.color も項目ごとに観測する（名前の変更では動かず、色の変化で動く）", () => {
    const { replica } = setup();
    const project = makeProject({ seq: nextSeq() });
    replica.replaceConfirmed([{ kind: "project", row: project }]);
    const row = replica.project(project.id);
    if (!row) throw new Error("row が見つかりません");

    let runs = 0;
    const dispose = autorun(() => {
      void row.color;
      runs++;
    });
    expect(runs).toBe(1);

    replica.mergeConfirmed([
      { kind: "project", row: { ...project, name: "新しい名前", seq: nextSeq() } },
    ]);
    expect(runs).toBe(1);

    replica.mergeConfirmed([
      { kind: "project", row: { ...project, color: "amber", seq: nextSeq() } },
    ]);
    expect(runs).toBe(2);
    expect(row.color).toBe("amber");

    dispose();
  });

  it("プロジェクトのボードの完了列：完了の並びが同じまま completedAt が7日の境目をまたぐと、列から抜ける・入る", () => {
    const { replica, lists } = setup();
    const projectId = "proj-1";
    // 8日前（境目の外）の完了
    const task = makeTask({
      bucket: "later",
      projectId,
      completedAt: "2026-01-07T05:00:00.000Z",
      seq: nextSeq(),
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    expect(lists.projectBoard(projectId).completed).toHaveLength(0);

    // 別のタブが、境目の内側（直近7日）に完了した時刻へ書き換えた
    replica.mergeConfirmed([
      {
        kind: "task",
        row: { ...task, completedAt: "2026-01-10T05:00:00.000Z", seq: nextSeq() },
      },
    ]);
    expect(lists.projectBoard(projectId).completed.map((t) => t.id)).toEqual([task.id]);

    // 境目の外側へ戻す
    replica.mergeConfirmed([
      {
        kind: "task",
        row: { ...task, completedAt: "2025-12-01T05:00:00.000Z", seq: nextSeq() },
      },
    ]);
    expect(lists.projectBoard(projectId).completed).toHaveLength(0);
  });
});
