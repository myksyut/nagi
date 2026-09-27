import type { Mutation } from "@shared/mutations";
import { rankAfter } from "@shared/rank";
import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { normalizeTaskChanges, type OperationResult, TaskActions } from "./actions";
import { LogicalDay } from "./logical-day";
import type { OperationKind } from "./replica";
import { Replica } from "./replica";
import { UndoStack } from "./undo";

/** 11. 操作の入口の決まり */

function targetIdOf(mutation: Mutation): string {
  switch (mutation.type) {
    case "task.create":
      return mutation.task.id;
    case "task.update":
      return mutation.id;
    case "project.create":
      return mutation.project.id;
    case "project.update":
      return mutation.id;
  }
}

function setup(now: () => Date = () => new Date("2026-01-15T05:00:00.000Z")) {
  const replica = new Replica();
  const day = new LogicalDay({ now, timeZone: "Asia/Tokyo" });
  const undoStack = new UndoStack();
  const performed: { kind: OperationKind; mutations: Mutation[] }[] = [];
  let nextId = 0;
  const actions = new TaskActions({
    replica,
    day,
    undoStack,
    now,
    newId: () => `new-id-${++nextId}`,
    // AppStore.#perform と同じ契約（オフラインの確認は外し、noop/invalid の判定だけ再現する）
    perform: (kind, mutations): OperationResult => {
      if (mutations.length === 0) return { ok: false, reason: "noop" };
      performed.push({ kind, mutations });
      return { ok: true, operationId: "op-1", ids: [...new Set(mutations.map(targetIdOf))] };
    },
  });
  return { replica, day, actions, performed };
}

describe("addTask", () => {
  it("置き場の一番下（完了済み・削除済みの行よりも後ろ）に入る", () => {
    const { replica, actions, performed } = setup();
    const r1 = rankAfter(null);
    const r2 = rankAfter(r1);
    const r3 = rankAfter(r2);
    const open = makeTask({ bucket: "today", rank: r1 });
    const completed = makeTask({
      bucket: "today",
      rank: r2,
      completedAt: "2026-01-14T00:00:00.000Z",
    });
    const deleted = makeTask({ bucket: "today", rank: r3, deletedAt: "2026-01-14T00:00:00.000Z" });
    replica.replaceConfirmed(
      [open, completed, deleted].map((row) => ({ kind: "task" as const, row })),
    );

    actions.addTask({ title: "新しい", bucket: "today" });

    expect(performed).toHaveLength(1);
    const mutation = performed[0]?.mutations[0];
    expect(mutation?.type).toBe("task.create");
    const rank = mutation?.type === "task.create" ? mutation.task.rank : undefined;
    // 完了済み・削除済みの行（r3）より後ろ
    expect(rank !== undefined && rank > r3).toBe(true);
  });

  it("空白だけのタイトルは invalid", () => {
    const { actions, performed } = setup();
    const result = actions.addTask({ title: "   ", bucket: "inbox" });
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(performed).toHaveLength(0);
  });
});

describe("uncompleteTasks", () => {
  it("今日の一番下に戻り、予定だったものは scheduledOn が null になる", () => {
    const { replica, actions, performed } = setup();
    const todayRank = rankAfter(null);
    const inToday = makeTask({ bucket: "today", rank: todayRank });
    const completedFromScheduled = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-02-01",
      completedAt: "2026-01-14T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [inToday, completedFromScheduled].map((row) => ({ kind: "task" as const, row })),
    );

    actions.uncompleteTasks([completedFromScheduled.id]);

    expect(performed).toHaveLength(1);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: completedFromScheduled.id,
      changes: { completedAt: null, bucket: "today", scheduledOn: null },
    });
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    // 今日の既存の行より後ろに戻る
    expect(typeof changes?.rank === "string" && changes.rank > todayRank).toBe(true);
  });
});

describe("moveTasks", () => {
  it("予定へ移すとき、日付が今日か過去なら今日に入る（実際に scheduledOn が変わる場合、changes に含まれる）", () => {
    const { replica, actions, performed, day } = setup();
    // すでに予定（未来日）にあるタスクを、今日以前の日付で「予定へ」動かす
    const task = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    actions.moveTasks([task.id], { bucket: "scheduled", on: day.today });

    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { bucket: "today", scheduledOn: null },
    });
  });

  it("scheduled に変えるときは scheduledOn も、外すときは scheduledOn: null も同じ changes で送る", () => {
    const { replica, actions, performed } = setup();
    const task = makeTask({ bucket: "inbox" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    actions.moveTasks([task.id], { bucket: "scheduled", on: "2026-02-01" });
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { bucket: "scheduled", scheduledOn: "2026-02-01" },
    });

    const scheduledTask = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01" });
    replica.replaceConfirmed([{ kind: "task", row: scheduledTask }]);
    actions.moveTasks([scheduledTask.id], { bucket: "later" });
    expect(performed[1]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { bucket: "later", scheduledOn: null },
    });
  });
});

describe("setDeadline", () => {
  it("あとで・予定のタスクに今日以前の締切を付けると、今日の到着位置へ移り、到着の印が付く", () => {
    const { replica, actions, performed, day } = setup();
    // scheduledOn を持つ予定のタスクで、実際に null へ変わることも確かめる
    // （rank は既定値 "a0" だと、今日に何もないときの到着位置キーと偶然一致するので、別の値にする）
    const scheduledTask = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-02-01",
      rank: rankAfter("a0"),
    });
    replica.replaceConfirmed([{ kind: "task", row: scheduledTask }]);

    actions.setDeadline([scheduledTask.id], day.today);

    expect(performed).toHaveLength(1);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: scheduledTask.id,
      changes: {
        deadlineOn: day.today,
        bucket: "today",
        scheduledOn: null,
        arrivedOn: day.today,
      },
    });
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    expect(typeof changes?.rank).toBe("string");
  });

  it("過去の締切でも今日に入る", () => {
    const { replica, actions, performed } = setup();
    const scheduledTask = makeTask({ bucket: "scheduled", scheduledOn: "2026-03-01" });
    replica.replaceConfirmed([{ kind: "task", row: scheduledTask }]);

    actions.setDeadline([scheduledTask.id], "2026-01-01");

    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { bucket: "today", scheduledOn: null, deadlineOn: "2026-01-01" },
    });
  });

  it("到着の位置は、今日来たタスクの後ろ・それ以外の今日のタスクの前", () => {
    const { replica, actions, performed, day } = setup();
    const r1 = rankAfter(null);
    const r2 = rankAfter(r1);
    const arrivedEarlier = makeTask({ bucket: "today", rank: r1, arrivedOn: day.today });
    const normalToday = makeTask({ bucket: "today", rank: r2, arrivedOn: null });
    const target = makeTask({ bucket: "later" });
    replica.replaceConfirmed(
      [arrivedEarlier, normalToday, target].map((row) => ({ kind: "task" as const, row })),
    );

    actions.setDeadline([target.id], day.today);

    const mutation = performed[0]?.mutations[0];
    const rank = mutation?.type === "task.update" ? (mutation.changes.rank as string) : undefined;
    expect(rank !== undefined && rank > r1 && rank < r2).toBe(true);
  });

  it("受信箱・今日・完了済みのタスクは動かさず、deadlineOn だけを送る", () => {
    const { replica, actions, performed, day } = setup();
    const inbox = makeTask({ bucket: "inbox" });
    const today = makeTask({ bucket: "today" });
    const completed = makeTask({ bucket: "later", completedAt: "2026-01-14T00:00:00.000Z" });
    replica.replaceConfirmed(
      [inbox, today, completed].map((row) => ({ kind: "task" as const, row })),
    );

    actions.setDeadline([inbox.id, today.id, completed.id], day.today);

    expect(performed).toHaveLength(1);
    const mutations = performed[0]?.mutations ?? [];
    expect(mutations).toHaveLength(3);
    for (const mutation of mutations) {
      expect(mutation).toMatchObject({ type: "task.update", changes: { deadlineOn: day.today } });
      const changes = mutation.type === "task.update" ? mutation.changes : undefined;
      expect(Object.keys(changes ?? {})).toEqual(["deadlineOn"]);
    }
  });

  it("未来の締切では deadlineOn だけを送る", () => {
    const { replica, actions, performed } = setup();
    const laterTask = makeTask({ bucket: "later" });
    replica.replaceConfirmed([{ kind: "task", row: laterTask }]);

    actions.setDeadline([laterTask.id], "2026-06-01");

    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({ type: "task.update", changes: { deadlineOn: "2026-06-01" } });
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    expect(Object.keys(changes ?? {})).toEqual(["deadlineOn"]);
  });

  it("締切を外す（null）でも deadlineOn だけを送る", () => {
    const { replica, actions, performed } = setup();
    const laterTask = makeTask({ bucket: "later", deadlineOn: "2026-01-01" });
    replica.replaceConfirmed([{ kind: "task", row: laterTask }]);

    actions.setDeadline([laterTask.id], null);

    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({ type: "task.update", changes: { deadlineOn: null } });
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    expect(Object.keys(changes ?? {})).toEqual(["deadlineOn"]);
  });

  it("締切が過去のタスクを moveTasks であとでへ移しても、今日へ引き戻されない", () => {
    const { replica, actions, performed } = setup();
    const task = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-03-01",
      deadlineOn: "2026-01-01",
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    actions.moveTasks([task.id], { bucket: "later" });

    const mutation = performed[0]?.mutations[0];
    expect(mutation?.type === "task.update" && mutation.changes.bucket).toBe("later");
  });
});

describe("normalizeTaskChanges（bucket と scheduledOn の対応、noop の検出）", () => {
  it("空白だけのタイトルは null（invalid）", () => {
    const task = makeTask({ title: "元" });
    expect(normalizeTaskChanges(task, { title: "   " })).toBeNull();
  });

  it("変えるものがなければ空の changes（noop）", () => {
    const task = makeTask({ title: "同じ" });
    expect(normalizeTaskChanges(task, { title: "同じ" })).toEqual({});
  });

  it("scheduled にするとき scheduledOn がなければ invalid", () => {
    const task = makeTask({ bucket: "inbox" });
    expect(normalizeTaskChanges(task, { bucket: "scheduled" })).toBeNull();
  });

  it("scheduled から外すと scheduledOn: null が自動で足される", () => {
    const task = makeTask({ bucket: "scheduled", scheduledOn: "2026-01-01" });
    expect(normalizeTaskChanges(task, { bucket: "today" })).toEqual({
      bucket: "today",
      scheduledOn: null,
    });
  });
});

describe("updateTasks：変えるものがなければ noop で何も送らない", () => {
  it("同じ内容の更新は noop", () => {
    const { replica, actions, performed } = setup();
    const task = makeTask({ title: "同じ" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const result = actions.updateTask(task.id, { title: "同じ" });
    expect(result).toEqual({ ok: false, reason: "noop" });
    expect(performed).toHaveLength(0);
  });
});

describe("createProject / updateProject", () => {
  it("空白だけの名前は invalid", () => {
    const { actions, performed } = setup();
    expect(actions.createProject("   ")).toEqual({ ok: false, reason: "invalid" });
    expect(performed).toHaveLength(0);
  });

  it("未完了のタスクが残っているプロジェクトはアーカイブできない", () => {
    const { replica, actions } = setup();
    const project = {
      id: "proj-1",
      name: "P",
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      seq: 1,
    };
    const openTask = makeTask({ bucket: "today", projectId: "proj-1" });
    replica.replaceConfirmed([
      { kind: "project", row: project },
      { kind: "task", row: openTask },
    ]);
    const result = actions.updateProject("proj-1", { archivedAt: "2026-01-05T00:00:00.000Z" });
    expect(result).toEqual({ ok: false, reason: "has-open-tasks" });
  });
});

describe("setProject", () => {
  it("アーカイブ済み・削除済み・存在しないプロジェクトは invalid（何も送らない）", () => {
    const { replica, actions, performed } = setup();
    const archived = makeProject({ id: "archived", archivedAt: "2026-01-01T00:00:00.000Z" });
    const deleted = makeProject({ id: "deleted", deletedAt: "2026-01-01T00:00:00.000Z" });
    const task = makeTask({ bucket: "inbox" });
    replica.replaceConfirmed([
      { kind: "project", row: archived },
      { kind: "project", row: deleted },
      { kind: "task", row: task },
    ]);

    expect(actions.setProject([task.id], "archived")).toEqual({ ok: false, reason: "invalid" });
    expect(actions.setProject([task.id], "deleted")).toEqual({ ok: false, reason: "invalid" });
    expect(actions.setProject([task.id], "no-such-project")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(performed).toHaveLength(0);
  });

  it("生きているプロジェクトは付けられる。null で外せる", () => {
    const { replica, actions, performed } = setup();
    const project = makeProject({ id: "p1" });
    const unassigned = makeTask({ bucket: "inbox", projectId: null });
    const assigned = makeTask({ bucket: "inbox", projectId: "p1" });
    replica.replaceConfirmed([
      { kind: "project", row: project },
      { kind: "task", row: unassigned },
      { kind: "task", row: assigned },
    ]);

    expect(actions.setProject([unassigned.id], "p1").ok).toBe(true);
    expect(performed[0]?.mutations).toEqual([
      { type: "task.update", id: unassigned.id, changes: { projectId: "p1" } },
    ]);

    expect(actions.setProject([assigned.id], null).ok).toBe(true);
    expect(performed[1]?.mutations).toEqual([
      { type: "task.update", id: assigned.id, changes: { projectId: null } },
    ]);
  });
});
