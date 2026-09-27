import { MAX_MUTATIONS_PER_BATCH, type Mutation } from "@shared/mutations";
import { rankAfter } from "@shared/rank";
import { describe, expect, it } from "vitest";
import { makeProject, makeTask } from "../test/fixtures";
import { normalizeTaskChanges, type OperationResult, TaskActions } from "./actions";
import { addDays, LogicalDay } from "./logical-day";
import type { OperationKind, PendingBatch } from "./replica";
import { Replica } from "./replica";
import { buildInverse, UndoStack } from "./undo";

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

/**
 * shiftTaskDates（14：タイムライン）用に、perform を実際に replica へ重ね、元に戻す（undo）の控えも積む setup
 * （AppStore.#perform と同じ契約：mutations を重ねて undoStack に逆向きを積む。500 件を超えたら too-many）。
 * moveTasks → setDeadline と続けてかけた結果と、shiftTaskDates 1回の結果を比べたり、⌘Z 相当を確かめるのに使う
 */
function setupLive(now: () => Date = () => new Date("2026-01-15T05:00:00.000Z")) {
  const replica = new Replica();
  const day = new LogicalDay({ now, timeZone: "Asia/Tokyo" });
  const undoStack = new UndoStack();
  let nextId = 0;
  const actions = new TaskActions({
    replica,
    day,
    undoStack,
    now,
    newId: () => `new-id-${++nextId}`,
    perform: (kind, mutations, options): OperationResult => {
      if (mutations.length === 0) return { ok: false, reason: "noop" };
      if (mutations.length > MAX_MUTATIONS_PER_BATCH) return { ok: false, reason: "too-many" };
      const id = `batch-${++nextId}`;
      const inverse =
        options?.undoable === false
          ? null
          : buildInverse(mutations, {
              task: (taskId) => replica.task(taskId)?.peek(),
              project: (projectId) => replica.project(projectId)?.peek(),
            });
      const batch: PendingBatch = { id, mutations, at: now().toISOString(), operationId: id, kind };
      replica.addPending([batch]);
      if (inverse) undoStack.push({ operationId: id, kind, inverse });
      return { ok: true, operationId: id, ids: [...new Set(mutations.map(targetIdOf))] };
    },
  });
  return { replica, day, actions };
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

describe("startTasks（10：進行中にする）", () => {
  it("今日以外にあるタスクは、今日の一番上へ移り、渡した順で上から並ぶ。すでに今日にあるタスクは位置を変えない", () => {
    const { replica, actions, performed } = setup();
    const inToday = makeTask({ bucket: "today", rank: "a1" });
    const fromLater = makeTask({ bucket: "later", rank: "a0" });
    const fromInbox = makeTask({ bucket: "inbox", rank: "a2" });
    replica.replaceConfirmed(
      [inToday, fromLater, fromInbox].map((row) => ({ kind: "task" as const, row })),
    );

    const result = actions.startTasks([inToday.id, fromLater.id, fromInbox.id]);

    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    const mutations = performed[0]?.mutations ?? [];
    expect(mutations).toHaveLength(3);

    const byId = new Map(mutations.map((m) => [m.type === "task.update" ? m.id : "", m]));
    const inTodayChange = byId.get(inToday.id);
    expect(inTodayChange).toMatchObject({
      type: "task.update",
      changes: { startedAt: expect.any(String) },
    });
    // 今日にあったタスクは bucket・rank を送らない（位置を変えない）
    const inTodayChanges =
      inTodayChange?.type === "task.update" ? Object.keys(inTodayChange.changes) : [];
    expect(inTodayChanges).toEqual(["startedAt"]);

    const laterChange = byId.get(fromLater.id);
    const inboxChange = byId.get(fromInbox.id);
    expect(laterChange).toMatchObject({ type: "task.update", changes: { bucket: "today" } });
    expect(inboxChange).toMatchObject({ type: "task.update", changes: { bucket: "today" } });
    const laterRank =
      laterChange?.type === "task.update" ? (laterChange.changes.rank as string) : undefined;
    const inboxRank =
      inboxChange?.type === "task.update" ? (inboxChange.changes.rank as string) : undefined;
    // どちらも既存の今日のタスク（m0）より前（一番上へ）。渡した順（later → inbox）で上から並ぶ
    expect(laterRank !== undefined && laterRank < inToday.rank).toBe(true);
    expect(inboxRank !== undefined && inboxRank < inToday.rank).toBe(true);
    expect(laterRank !== undefined && inboxRank !== undefined && laterRank < inboxRank).toBe(true);
  });

  it("予定にあったタスクを進行中にすると、同じ操作で scheduledOn が null になる", () => {
    const { replica, actions, performed } = setup();
    const scheduled = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01" });
    replica.replaceConfirmed([{ kind: "task", row: scheduled }]);

    actions.startTasks([scheduled.id]);

    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { bucket: "today", scheduledOn: null },
    });
  });

  it("完了済み・削除済み・すでに進行中のタスクは対象外。対象がなければ noop", () => {
    const { replica, actions, performed } = setup();
    const completed = makeTask({ bucket: "today", completedAt: "2026-01-01T00:00:00.000Z" });
    const deleted = makeTask({ bucket: "today", deletedAt: "2026-01-01T00:00:00.000Z" });
    const alreadyStarted = makeTask({ bucket: "today", startedAt: "2026-01-01T00:00:00.000Z" });
    replica.replaceConfirmed(
      [completed, deleted, alreadyStarted].map((row) => ({ kind: "task" as const, row })),
    );

    const result = actions.startTasks([completed.id, deleted.id, alreadyStarted.id]);

    expect(result).toEqual({ ok: false, reason: "noop" });
    expect(performed).toHaveLength(0);
  });
});

describe("stopTasks（10：未着手に戻す）", () => {
  it("進行中の未完了だけが対象。startedAt を消すだけで、bucket・rank は送らない", () => {
    const { replica, actions, performed } = setup();
    const started = makeTask({
      bucket: "today",
      rank: "a0",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    replica.replaceConfirmed([{ kind: "task", row: started }]);

    const result = actions.stopTasks([started.id]);

    expect(result.ok).toBe(true);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: started.id,
      changes: { startedAt: null },
    });
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    expect(Object.keys(changes ?? {})).toEqual(["startedAt"]);
  });

  it("未着手・完了済み・削除済みのタスクは対象外。対象がなければ noop", () => {
    const { replica, actions, performed } = setup();
    const notStarted = makeTask({ bucket: "today" });
    const completed = makeTask({
      bucket: "today",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    const deleted = makeTask({
      bucket: "today",
      startedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-01T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [notStarted, completed, deleted].map((row) => ({ kind: "task" as const, row })),
    );

    const result = actions.stopTasks([notStarted.id, completed.id, deleted.id]);

    expect(result).toEqual({ ok: false, reason: "noop" });
    expect(performed).toHaveLength(0);
  });
});

describe("moveTasks：進行中のタスクを今日から出す", () => {
  it("同じ操作で startedAt が null になる", () => {
    const { replica, actions, performed } = setup();
    const started = makeTask({ bucket: "today", startedAt: "2026-01-01T00:00:00.000Z" });
    replica.replaceConfirmed([{ kind: "task", row: started }]);

    actions.moveTasks([started.id], { bucket: "later" });

    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { bucket: "later", startedAt: null },
    });
  });

  it("進行中でないタスクを今日から出しても startedAt は送らない", () => {
    const { replica, actions, performed } = setup();
    const notStarted = makeTask({ bucket: "today" });
    replica.replaceConfirmed([{ kind: "task", row: notStarted }]);

    actions.moveTasks([notStarted.id], { bucket: "later" });

    const changes =
      performed[0]?.mutations[0]?.type === "task.update"
        ? performed[0].mutations[0].changes
        : undefined;
    expect(changes).not.toHaveProperty("startedAt");
  });
});

describe("completeTasks：進行中のまま完了しても startedAt は残す", () => {
  it("changes に startedAt を含めない（消さない）", () => {
    const { replica, actions, performed } = setup();
    const started = makeTask({ bucket: "today", startedAt: "2026-01-01T00:00:00.000Z" });
    replica.replaceConfirmed([{ kind: "task", row: started }]);

    actions.completeTasks([started.id]);

    const changes =
      performed[0]?.mutations[0]?.type === "task.update"
        ? performed[0].mutations[0].changes
        : undefined;
    expect(Object.keys(changes ?? {})).toEqual(["completedAt"]);
  });
});

describe("uncompleteTasks：進行中のまま完了していても、あとから外すと startedAt も消す", () => {
  it("completedAt と startedAt を両方 null にする", () => {
    const { replica, actions, performed } = setup();
    // 完了していたときの bucket は today のまま変わらないが、startedAt は消える
    const completedWhileStarted = makeTask({
      bucket: "today",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    replica.replaceConfirmed([{ kind: "task", row: completedWhileStarted }]);

    actions.uncompleteTasks([completedWhileStarted.id]);

    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      changes: { completedAt: null, startedAt: null },
    });
    // bucket はもともと today なので、changes には含まれない（変わらない項目は送らない）
    const changes = mutation?.type === "task.update" ? mutation.changes : undefined;
    expect(changes).not.toHaveProperty("bucket");
  });

  it("今日以外で完了していたタスクを外すと、bucket も today に変わり、startedAt も消える", () => {
    const { replica, actions, performed } = setup();
    const completedFromLater = makeTask({
      bucket: "later",
      startedAt: null,
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    replica.replaceConfirmed([{ kind: "task", row: completedFromLater }]);

    actions.uncompleteTasks([completedFromLater.id]);

    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      changes: { completedAt: null, bucket: "today" },
    });
  });
});

describe("normalizeTaskChanges（進行中と今日の対応）", () => {
  it("今日の外で明示的に startedAt を入れようとすると null（invalid）", () => {
    const task = makeTask({ bucket: "later" });
    expect(normalizeTaskChanges(task, { startedAt: "2026-01-01T00:00:00.000Z" })).toBeNull();
  });

  it("進行中のタスクの bucket を今日の外へ変えると、自動で startedAt: null が足される", () => {
    const task = makeTask({ bucket: "today", startedAt: "2026-01-01T00:00:00.000Z" });
    expect(normalizeTaskChanges(task, { bucket: "later" })).toEqual({
      bucket: "later",
      startedAt: null,
    });
  });

  it("bucket を今日の外へ変えるのと同時に startedAt: null を送るのは、そのまま通る", () => {
    const task = makeTask({ bucket: "today", startedAt: "2026-01-01T00:00:00.000Z" });
    expect(normalizeTaskChanges(task, { bucket: "later", startedAt: null })).toEqual({
      bucket: "later",
      startedAt: null,
    });
  });

  it("10-修正1：進行中のタスクに、今と同じ startedAt を明示して bucket を今日の外へ変えると invalid（黙って未着手への移動にしない）", () => {
    const startedAt = "2026-01-01T00:00:00.000Z";
    const task = makeTask({ bucket: "today", startedAt });
    expect(normalizeTaskChanges(task, { bucket: "later", startedAt })).toBeNull();
    // 予定へ移すときも同じ
    expect(
      normalizeTaskChanges(task, { bucket: "scheduled", scheduledOn: "2026-02-01", startedAt }),
    ).toBeNull();
    // 進行中を保つつもりで、別の時刻を明示しても invalid
    expect(
      normalizeTaskChanges(task, { bucket: "inbox", startedAt: "2026-01-02T00:00:00.000Z" }),
    ).toBeNull();
  });

  it("bucket が today のままなら startedAt をそのまま渡す", () => {
    const task = makeTask({ bucket: "today" });
    expect(normalizeTaskChanges(task, { startedAt: "2026-01-01T00:00:00.000Z" })).toEqual({
      startedAt: "2026-01-01T00:00:00.000Z",
    });
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

describe("reorderTasks（7：⌥↑↓・ドラッグ）", () => {
  it("動かした行の rank だけを書き換える（ほかの行の rank は送らない）", () => {
    const { replica, actions, performed } = setup();
    const a = makeTask({ title: "A", bucket: "today", rank: "a0" });
    const b = makeTask({ title: "B", bucket: "today", rank: "a1" });
    const c = makeTask({ title: "C", bucket: "today", rank: "a2" });
    replica.replaceConfirmed([a, b, c].map((row) => ({ kind: "task" as const, row })));

    // A を B の後ろへ（B, A, C の並びにする）
    const result = actions.reorderTasks([{ ids: [a.id], after: b.id, before: c.id }]);

    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    const mutations = performed[0]?.mutations ?? [];
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ type: "task.update", id: a.id });
    const changes = mutations[0]?.type === "task.update" ? mutations[0].changes : undefined;
    expect(Object.keys(changes ?? {})).toEqual(["rank"]);
    expect(typeof changes?.rank).toBe("string");
    expect(changes?.rank !== a.rank).toBe(true);
    // B・C の rank はそのまま（送っていない）
    expect(b.rank).toBe("a1");
    expect(c.rank).toBe("a2");
  });

  it("新しい rank は、見えていない完了済み・削除済みの行の rank とも重ならない", () => {
    const { replica, actions, performed } = setup();
    // 見えている並びは [A, B, C]（rank 順）。完了済みの行が A と B のあいだに隠れている
    const a = makeTask({ title: "A", bucket: "today", rank: "a0" });
    const completed = makeTask({
      title: "完了済み",
      bucket: "today",
      rank: "a1",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    const b = makeTask({ title: "B", bucket: "today", rank: "a2" });
    const c = makeTask({ title: "C", bucket: "today", rank: "a3" });
    const deleted = makeTask({
      title: "削除済み",
      bucket: "today",
      rank: "a4",
      deletedAt: "2026-01-01T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [a, completed, b, c, deleted].map((row) => ({ kind: "task" as const, row })),
    );

    // C を A のすぐ後ろ（見えている A と B のあいだ）へ動かす
    const result = actions.reorderTasks([{ ids: [c.id], after: a.id, before: b.id }]);

    expect(result.ok).toBe(true);
    const changes =
      performed[0]?.mutations[0]?.type === "task.update"
        ? performed[0].mutations[0].changes
        : undefined;
    const newRank = changes?.rank as string;
    // 隠れている完了済みの行（a1）と重ならず、その手前に収まる
    expect(newRank > a.rank && newRank < completed.rank).toBe(true);
    expect(newRank).not.toBe(deleted.rank);
  });

  it("同じ置き場でない行・完了済みの行が混ざっていたら invalid", () => {
    const { replica, actions, performed } = setup();
    const inToday = makeTask({ bucket: "today", rank: "a0" });
    const inLater = makeTask({ bucket: "later", rank: "a0" });
    const completed = makeTask({
      bucket: "today",
      rank: "a1",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [inToday, inLater, completed].map((row) => ({ kind: "task" as const, row })),
    );

    const acrossBuckets = actions.reorderTasks([
      { ids: [inToday.id, inLater.id], after: null, before: null },
    ]);
    expect(acrossBuckets).toEqual({ ok: false, reason: "invalid" });

    const includesCompleted = actions.reorderTasks([
      { ids: [inToday.id, completed.id], after: null, before: null },
    ]);
    expect(includesCompleted).toEqual({ ok: false, reason: "invalid" });

    expect(performed).toHaveLength(0);
  });

  it("両端が null（after も before も無い）の置き場は invalid", () => {
    const { replica, actions, performed } = setup();
    const a = makeTask({ bucket: "today", rank: "a0" });
    replica.replaceConfirmed([{ kind: "task", row: a }]);

    const result = actions.reorderTasks([{ ids: [a.id], after: null, before: null }]);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(performed).toHaveLength(0);
  });

  it("複数の置き場所を1回の操作でまとめて送る（1つの操作として戻せる）", () => {
    const { replica, actions, performed } = setup();
    const a = makeTask({ title: "A", bucket: "today", rank: "a0" });
    const b = makeTask({ title: "B", bucket: "today", rank: "a1" });
    const c = makeTask({ title: "C", bucket: "today", rank: "a2" });
    const d = makeTask({ title: "D", bucket: "today", rank: "a3" });
    replica.replaceConfirmed([a, b, c, d].map((row) => ({ kind: "task" as const, row })));

    const result = actions.reorderTasks([
      { ids: [b.id], after: null, before: a.id },
      { ids: [d.id], after: a.id, before: c.id },
    ]);

    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    expect(performed[0]?.mutations).toHaveLength(2);
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
      color: null,
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

  it("10-修正1：作るときに色を入れない（color は空。表示は作成順の色に任せる）", () => {
    const { replica, actions, performed } = setup();
    actions.createProject("1つ目");
    const archived = makeProject({ archivedAt: "2026-01-01T00:00:00.000Z" });
    replica.replaceConfirmed([{ kind: "project", row: archived }]);
    actions.createProject("2つ目");

    for (const { mutations } of performed) {
      const mutation = mutations[0];
      if (mutation?.type !== "project.create") throw new Error("project.create ではありません");
      expect(mutation.project.color ?? null).toBeNull();
    }
    expect(performed).toHaveLength(2);
  });

  it("updateProject で色を変えられる", () => {
    const { replica, actions, performed } = setup();
    const project = makeProject({ color: "violet" });
    replica.replaceConfirmed([{ kind: "project", row: project }]);

    const result = actions.updateProject(project.id, { color: "amber" });

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "project.update",
      id: project.id,
      changes: { color: "amber" },
    });
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

describe("shiftTaskDates（14：タイムラインの棒の真ん中のドラッグ）", () => {
  it("予定＋締切を未来へ：やる日・締切とも days ずれ、予定のまま", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({
      bucket: "scheduled",
      scheduledOn: addDays(day.today, 5),
      deadlineOn: addDays(day.today, 10),
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], 10);

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      id: task.id,
      // bucket はすでに scheduled なので送らない（変わらない項目は送らない決まり）
      changes: {
        scheduledOn: addDays(day.today, 15),
        deadlineOn: addDays(day.today, 20),
      },
    });
  });

  it("予定を今日以前へ：今日の一番下へ入る", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "scheduled", scheduledOn: addDays(day.today, 5), rank: "zz" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], -20);

    expect(result.ok).toBe(true);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { bucket: "today", scheduledOn: null },
    });
    const rank = mutation?.type === "task.update" ? mutation.changes.rank : undefined;
    expect(typeof rank).toBe("string");
  });

  it("今日のタスクを未来へ：予定へ移り、予定の一番下の rank が付く", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "today", rank: "a5" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], 7);

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { bucket: "scheduled", scheduledOn: addDays(day.today, 7) },
    });
  });

  it("今日のタスクを過去へ：今日のまま動かず、締切だけ動く", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({
      bucket: "today",
      rank: "a5",
      deadlineOn: addDays(day.today, 10),
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], -20);

    expect(result.ok).toBe(true);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { deadlineOn: addDays(day.today, -10) },
    });
    // bucket・scheduledOn・rank は送らない（今日のまま動かさない）
    const changes = mutation?.type === "task.update" ? Object.keys(mutation.changes) : [];
    expect(changes).toEqual(["deadlineOn"]);
  });

  it("進行中の今日のタスクを未来へ：予定へ出るので startedAt が消える", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "today", rank: "a5", startedAt: "2026-01-14T00:00:00.000Z" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], 3);

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { bucket: "scheduled", scheduledOn: addDays(day.today, 3), startedAt: null },
    });
  });

  it("あとで＋締切を今日以前へ：今日の到着の位置へ移り、arrivedOn が付く", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "later", rank: "a5", deadlineOn: addDays(day.today, 5) });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], -20);

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      id: task.id,
      // scheduledOn はもともと null（あとで）なので送らない（変わらない項目は送らない決まり）
      changes: {
        bucket: "today",
        deadlineOn: addDays(day.today, -15),
        arrivedOn: day.today,
      },
    });
  });

  it("受信箱＋締切を今日以前へ：受信箱のまま、締切だけ動く", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "inbox", rank: "a5", deadlineOn: addDays(day.today, 5) });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], -20);

    expect(result.ok).toBe(true);
    const mutation = performed[0]?.mutations[0];
    expect(mutation).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: { deadlineOn: addDays(day.today, -15) },
    });
    const changes = mutation?.type === "task.update" ? Object.keys(mutation.changes) : [];
    expect(changes).toEqual(["deadlineOn"]);
  });

  it("予定の日付が今日より後のまま、締切だけ今日以前になる：今日の到着の位置へ（予定は捨てる）", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({
      bucket: "scheduled",
      rank: "a5",
      scheduledOn: addDays(day.today, 20),
      deadlineOn: addDays(day.today, 5),
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const result = actions.shiftTaskDates([task.id], -10);

    expect(result.ok).toBe(true);
    expect(performed[0]?.mutations[0]).toMatchObject({
      type: "task.update",
      id: task.id,
      changes: {
        bucket: "today",
        scheduledOn: null,
        deadlineOn: addDays(day.today, -5),
        arrivedOn: day.today,
      },
    });
  });

  it("締切なしはやる日だけ動く（deadlineOn は送らない）", () => {
    const { replica, actions, performed, day } = setup();
    const task = makeTask({ bucket: "scheduled", scheduledOn: addDays(day.today, 5) });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    actions.shiftTaskDates([task.id], 3);

    const mutation = performed[0]?.mutations[0];
    const changes = mutation?.type === "task.update" ? Object.keys(mutation.changes) : [];
    expect(changes).not.toContain("deadlineOn");
  });

  it("やる日も締切もない・完了・削除のタスクは対象外で noop", () => {
    const { replica, actions, performed } = setup();
    const noDates = makeTask({ bucket: "inbox" });
    const completed = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-02-01",
      completedAt: "2026-01-14T00:00:00.000Z",
    });
    const deleted = makeTask({
      bucket: "scheduled",
      scheduledOn: "2026-02-01",
      deletedAt: "2026-01-14T00:00:00.000Z",
    });
    replica.replaceConfirmed(
      [noDates, completed, deleted].map((row) => ({ kind: "task" as const, row })),
    );

    const result = actions.shiftTaskDates([noDates.id, completed.id, deleted.id], 5);

    expect(result).toEqual({ ok: false, reason: "noop" });
    expect(performed).toHaveLength(0);
  });

  it("days が 0 は noop、整数でなければ invalid（対象を読む前に断る）", () => {
    const { replica, actions, performed } = setup();
    const task = makeTask({ bucket: "today" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    expect(actions.shiftTaskDates([task.id], 0)).toEqual({ ok: false, reason: "noop" });
    expect(actions.shiftTaskDates([task.id], 1.5)).toEqual({ ok: false, reason: "invalid" });
    expect(actions.shiftTaskDates([task.id], Number.NaN)).toEqual({ ok: false, reason: "invalid" });
    expect(performed).toHaveLength(0);
  });

  it("複数の id をまとめて渡しても1つの操作（1回の perform）", () => {
    const { replica, actions, performed, day } = setup();
    const a = makeTask({ bucket: "today", rank: "a1" });
    const b = makeTask({ bucket: "scheduled", scheduledOn: addDays(day.today, 3), rank: "a2" });
    replica.replaceConfirmed([a, b].map((row) => ({ kind: "task" as const, row })));

    const result = actions.shiftTaskDates([a.id, b.id], 2);

    expect(result.ok).toBe(true);
    expect(performed).toHaveLength(1);
    expect(performed[0]?.mutations).toHaveLength(2);
  });

  it("501 件は too-many で、何も送らない（AppStore と同じ 500 件の上限）", () => {
    const { replica, actions } = setupLive();
    const tasks = Array.from({ length: 501 }, () => makeTask({ bucket: "today", rank: "a0" }));
    replica.replaceConfirmed(tasks.map((row) => ({ kind: "task" as const, row })));

    const result = actions.shiftTaskDates(
      tasks.map((t) => t.id),
      5,
    );

    expect(result).toEqual({ ok: false, reason: "too-many" });
    expect(replica.pending).toHaveLength(0);
  });

  it("⌘Z 相当：actions.undo() 1回で、やる日・締切がともに元へ戻る", () => {
    const { replica, actions, day } = setupLive();
    const task = makeTask({
      bucket: "scheduled",
      scheduledOn: addDays(day.today, 5),
      deadlineOn: addDays(day.today, 10),
    });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    actions.shiftTaskDates([task.id], 10);
    expect(replica.task(task.id)?.peek().scheduledOn).toBe(addDays(day.today, 15));
    expect(replica.task(task.id)?.peek().deadlineOn).toBe(addDays(day.today, 20));

    const undoResult = actions.undo();

    expect(undoResult.ok).toBe(true);
    expect(replica.task(task.id)?.peek().scheduledOn).toBe(addDays(day.today, 5));
    expect(replica.task(task.id)?.peek().deadlineOn).toBe(addDays(day.today, 10));
  });

  describe("d（moveTasks）と ⇧D（setDeadline）を続けてかけたときと同じ結果になる", () => {
    it("予定＋締切を未来へ", () => {
      const days = 12;
      const initial = {
        bucket: "scheduled" as const,
        scheduledOn: "2026-01-20",
        deadlineOn: "2026-01-25",
      };

      const shifted = setupLive();
      const shiftedTask = makeTask(initial);
      shifted.replica.replaceConfirmed([{ kind: "task", row: shiftedTask }]);
      shifted.actions.shiftTaskDates([shiftedTask.id], days);

      const sequential = setupLive();
      const sequentialTask = makeTask(initial);
      sequential.replica.replaceConfirmed([{ kind: "task", row: sequentialTask }]);
      sequential.actions.moveTasks([sequentialTask.id], {
        bucket: "scheduled",
        on: addDays(initial.scheduledOn, days),
      });
      sequential.actions.setDeadline([sequentialTask.id], addDays(initial.deadlineOn, days));

      expect(withoutId(shifted.replica.task(shiftedTask.id)?.peek())).toEqual(
        withoutId(sequential.replica.task(sequentialTask.id)?.peek()),
      );
    });

    it("予定の日付が今日より後のまま、締切だけ今日以前になる（到着）", () => {
      const days = -10;
      const initial = {
        bucket: "scheduled" as const,
        scheduledOn: "2026-02-01",
        deadlineOn: "2026-01-20",
      };

      const shifted = setupLive();
      const shiftedTask = makeTask(initial);
      shifted.replica.replaceConfirmed([{ kind: "task", row: shiftedTask }]);
      shifted.actions.shiftTaskDates([shiftedTask.id], days);

      const sequential = setupLive();
      const sequentialTask = makeTask(initial);
      sequential.replica.replaceConfirmed([{ kind: "task", row: sequentialTask }]);
      sequential.actions.moveTasks([sequentialTask.id], {
        bucket: "scheduled",
        on: addDays(initial.scheduledOn, days),
      });
      sequential.actions.setDeadline([sequentialTask.id], addDays(initial.deadlineOn, days));

      expect(withoutId(shifted.replica.task(shiftedTask.id)?.peek())).toEqual(
        withoutId(sequential.replica.task(sequentialTask.id)?.peek()),
      );
    });

    it("あとで＋締切を今日以前へ（d は効かず、⇧D だけと同じ）", () => {
      const days = -20;
      const initial = { bucket: "later" as const, deadlineOn: "2026-01-20" };

      const shifted = setupLive();
      const shiftedTask = makeTask(initial);
      shifted.replica.replaceConfirmed([{ kind: "task", row: shiftedTask }]);
      shifted.actions.shiftTaskDates([shiftedTask.id], days);

      const sequential = setupLive();
      const sequentialTask = makeTask(initial);
      sequential.replica.replaceConfirmed([{ kind: "task", row: sequentialTask }]);
      sequential.actions.setDeadline([sequentialTask.id], addDays(initial.deadlineOn, days));

      expect(withoutId(shifted.replica.task(shiftedTask.id)?.peek())).toEqual(
        withoutId(sequential.replica.task(sequentialTask.id)?.peek()),
      );
    });
  });
});

/** 比べるときに邪魔な id（別の makeTask から作った行なので当然違う）を外す */
function withoutId(task: { id: string } | undefined): unknown {
  if (!task) return task;
  const { id: _id, ...rest } = task;
  return rest;
}
