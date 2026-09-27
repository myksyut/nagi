import type { Task } from "@shared/model";
import { POINTS, type Points, PRIORITIES, type Priority } from "@shared/priority-points";
import { rankAfter } from "@shared/rank";
import { autorun, computed, reaction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServer } from "../test/fake-server";
import { makeProject, makeTask } from "../test/fixtures";
import { sumPoints, TaskLists } from "./lists";
import { createMemoryLocalDb } from "./local-db";
import { LogicalDay } from "./logical-day";
import type { Notice } from "./notices";
import { Replica } from "./replica";
import { TaskRow } from "./rows";
import { sortTasks, TASK_SORTS, type TaskSort } from "./sort";
import { AppStore } from "./store";

/** 15：優先度と工数（データ層の操作と ⌘Z、並べ替えの関数、工数の合計と観測） */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function makeStore(server: FakeServer) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  return store;
}

function setupLists(now: () => Date = () => new Date("2026-01-15T05:00:00.000Z")) {
  const replica = new Replica();
  const day = new LogicalDay({ now, timeZone: "Asia/Tokyo" });
  const lists = new TaskLists(replica, day);
  return { replica, day, lists };
}

let seqCounter = 1000;
function nextSeq(): number {
  seqCounter += 1;
  return seqCounter;
}

/** 行を差し替える（確定データとして届いた、とする） */
function put(replica: Replica, task: Task, changes: Partial<Task>): Task {
  const next = { ...task, ...changes, seq: nextSeq() };
  replica.mergeConfirmed([{ kind: "task", row: next }]);
  return next;
}

describe("setPriority・setPoints（Store 統合）", () => {
  it("付けるとすぐ表示に出て、サーバーに保存される。置き場・並び順キー・ほかの項目は変えない", async () => {
    const server = new FakeServer();
    const rank = rankAfter(null);
    const task = server.putTask(makeTask({ title: "A", bucket: "later", rank }));
    const store = makeStore(server);
    await store.start();

    expect(store.actions.setPriority([task.id], "high").ok).toBe(true);
    expect(store.actions.setPoints([task.id], 8).ok).toBe(true);
    expect(store.task(task.id)?.priority).toBe("high");
    expect(store.task(task.id)?.points).toBe(8);
    await store.idle();

    expect(server.tasks.get(task.id)).toMatchObject({
      priority: "high",
      points: 8,
      title: "A",
      bucket: "later",
      rank,
    });
    // 送った changes は優先度・工数だけ
    const bodies = server
      .requestsTo("/api/mutate")
      .map((request) => (request.body as { mutations: { changes: object }[] }).mutations);
    expect(bodies.map((mutations) => mutations.map((m) => m.changes))).toEqual([
      [{ priority: "high" }],
      [{ points: 8 }],
    ]);
  });

  it("★ まとめて付けても1つの操作（1リクエスト）で、⌘Z 1回でそれぞれ前の値に戻る。null で外したのも ⌘Z で戻る", async () => {
    const server = new FakeServer();
    const a = server.putTask(makeTask({ bucket: "today", priority: "low", points: 2 }));
    const b = server.putTask(makeTask({ bucket: "today" }));
    const c = server.putTask(makeTask({ bucket: "inbox", priority: "medium", points: 13 }));
    const store = makeStore(server);
    await store.start();

    store.actions.setPriority([a.id, b.id, c.id], "high");
    store.actions.setPoints([a.id, b.id, c.id], 5);
    await store.idle();
    expect(server.requestsTo("/api/mutate")).toHaveLength(2);
    for (const id of [a.id, b.id, c.id]) {
      expect(server.tasks.get(id)).toMatchObject({ priority: "high", points: 5 });
    }

    // 後の操作（工数）から順に戻る
    expect(store.actions.undo().ok).toBe(true);
    expect([a.id, b.id, c.id].map((id) => store.task(id)?.points)).toEqual([2, null, 13]);
    expect([a.id, b.id, c.id].map((id) => store.task(id)?.priority)).toEqual([
      "high",
      "high",
      "high",
    ]);
    expect(store.actions.undo().ok).toBe(true);
    expect([a.id, b.id, c.id].map((id) => store.task(id)?.priority)).toEqual([
      "low",
      null,
      "medium",
    ]);
    await store.idle();
    expect(server.tasks.get(a.id)).toMatchObject({ priority: "low", points: 2 });
    expect(server.tasks.get(b.id)).toMatchObject({ priority: null, points: null });
    expect(server.tasks.get(c.id)).toMatchObject({ priority: "medium", points: 13 });

    // 外す（null）→ ⌘Z で戻る
    store.actions.setPriority([a.id, c.id], null);
    store.actions.setPoints([a.id, c.id], null);
    expect(store.task(a.id)?.priority).toBeNull();
    expect(store.task(c.id)?.points).toBeNull();
    store.actions.undo();
    store.actions.undo();
    await store.idle();
    expect(server.tasks.get(a.id)).toMatchObject({ priority: "low", points: 2 });
    expect(server.tasks.get(c.id)).toMatchObject({ priority: "medium", points: 13 });
  });

  it("完了済みのタスクにも付けられる（完了は外れない）。削除済みは対象外", async () => {
    const server = new FakeServer();
    const completed = server.putTask(
      makeTask({ bucket: "today", completedAt: new Date().toISOString() }),
    );
    const deleted = server.putTask(
      makeTask({ bucket: "today", deletedAt: new Date().toISOString() }),
    );
    const store = makeStore(server);
    await store.start();

    expect(store.actions.setPriority([deleted.id], "high")).toEqual({
      ok: false,
      reason: "noop",
    });
    const result = store.actions.setPoints([completed.id, deleted.id], 3);
    expect(result.ok && result.ids).toEqual([completed.id]);
    expect(store.actions.setPriority([completed.id], "medium").ok).toBe(true);
    await store.idle();
    expect(server.tasks.get(completed.id)).toMatchObject({ priority: "medium", points: 3 });
    expect(server.tasks.get(completed.id)?.completedAt).not.toBeNull();
    expect(server.tasks.get(deleted.id)).toMatchObject({ priority: null, points: null });
  });

  it("すでにその値のタスクは送らない。全部そうなら noop で、元に戻すの対象も増えない", async () => {
    const server = new FakeServer();
    const a = server.putTask(makeTask({ bucket: "today", priority: "high", points: 1 }));
    const b = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();

    expect(store.actions.setPriority([a.id], "high")).toEqual({ ok: false, reason: "noop" });
    expect(store.actions.setPoints([a.id], 1)).toEqual({ ok: false, reason: "noop" });
    expect(store.actions.setPriority([b.id], null)).toEqual({ ok: false, reason: "noop" });
    expect(store.canUndo).toBe(false);

    const result = store.actions.setPriority([a.id, b.id], "high");
    expect(result.ok && result.ids).toEqual([b.id]);
  });

  it("決まった値でないものは invalid で、何も送らない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();

    for (const value of ["urgent", "", "HIGH"]) {
      expect(store.actions.setPriority([task.id], value as Priority)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    for (const value of [0, 4, 21, 2.5, Number.NaN]) {
      expect(store.actions.setPoints([task.id], value as Points)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(store.task(task.id)).toMatchObject({ priority: null, points: null });
    expect(server.requestsTo("/api/mutate")).toHaveLength(0);
  });

  it("★ 501 件は too-many で、何も送らず、表示も変わらない。500 件はちょうど1リクエストで通る", async () => {
    const server = new FakeServer();
    const tasks = Array.from({ length: 501 }, () => server.putTask(makeTask({ bucket: "today" })));
    const store = makeStore(server);
    await store.start();

    const ids = tasks.map((task) => task.id);
    expect(store.actions.setPriority(ids, "high")).toEqual({ ok: false, reason: "too-many" });
    expect(store.actions.setPoints(ids, 3)).toEqual({ ok: false, reason: "too-many" });
    expect(tasks.every((task) => store.task(task.id)?.priority === null)).toBe(true);
    expect(server.requestsTo("/api/mutate")).toHaveLength(0);

    expect(store.actions.setPoints(ids.slice(0, 500), 3).ok).toBe(true);
    await store.idle();
    const requests = server.requestsTo("/api/mutate");
    expect(requests).toHaveLength(1);
    expect((requests[0]?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(
      500,
    );
  });

  it("オフラインなら受け付けずに止め、offline-blocked を知らせる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((notice) => notices.push(notice));
    window.dispatchEvent(new Event("offline"));

    expect(store.actions.setPriority([task.id], "high")).toEqual({ ok: false, reason: "offline" });
    expect(store.actions.setPoints([task.id], 2)).toEqual({ ok: false, reason: "offline" });
    expect(notices).toEqual([
      { type: "offline-blocked", operation: "task.priority", autosave: false },
      { type: "offline-blocked", operation: "task.points", autosave: false },
    ]);
    window.dispatchEvent(new Event("online"));
  });

  it("サーバーの版が違う（409）と、送った変更は捨てられ、version-mismatch を知らせる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((notice) => notices.push(notice));

    server.apiVersion = 2;
    store.actions.setPriority([task.id], "high");
    await store.idle();

    expect(store.task(task.id)?.priority).toBeNull();
    expect(store.stoppedBy).toBe("version-mismatch");
    expect(notices[0]).toMatchObject({ type: "version-mismatch" });
    expect(server.tasks.get(task.id)?.priority).toBeNull();
  });

  it("ほかのタブの優先度・工数の変更は、差分の取得で届く（後勝ち）", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();

    store.actions.setPriority([task.id], "low");
    await store.idle();
    server.putTask({ id: task.id, priority: "high", points: 13 });
    await store.sync();
    expect(store.task(task.id)).toMatchObject({ priority: "high", points: 13 });
  });

  it("追加（task.create）は優先度・工数を送らず、空で作られる", async () => {
    const server = new FakeServer();
    const store = makeStore(server);
    await store.start();

    const result = store.actions.addTask({ title: "新しい", bucket: "today" });
    const id = result.ok ? result.ids[0] : undefined;
    expect(store.task(id ?? "")).toMatchObject({ priority: null, points: null });
    await store.idle();
    expect(server.tasks.get(id ?? "")).toMatchObject({ priority: null, points: null });
  });
});

describe("sortTasks（並べ替えの純粋な関数）", () => {
  type Row = { id: string; priority: Priority | null; points: Points | null };
  const row = (id: string, priority: Priority | null, points: Points | null): Row => ({
    id,
    priority,
    points,
  });
  // 手動の並び（rank の順）で渡す
  const rows: Row[] = [
    row("a", null, 3),
    row("b", "low", null),
    row("c", "high", 8),
    row("d", "medium", 1),
    row("e", null, null),
    row("f", "high", 3),
    row("g", "low", 13),
    row("h", "medium", null),
  ];
  const ids = (sorted: readonly Row[]) => sorted.map((r) => r.id);

  it("manual は渡した並びのまま（同じ配列を返す）", () => {
    expect(sortTasks(rows, "manual")).toBe(rows);
  });

  it("★ priority は高・中・低・なしの順。同じ優先度の中は渡した並びの順", () => {
    expect(ids(sortTasks(rows, "priority"))).toEqual(["c", "f", "d", "h", "b", "g", "a", "e"]);
  });

  it("★ points-asc は工数の少ない順。工数のないタスクは最後。同じ工数の中は渡した並びの順", () => {
    expect(ids(sortTasks(rows, "points-asc"))).toEqual(["d", "a", "f", "c", "g", "b", "e", "h"]);
  });

  it("★ points-desc は工数の多い順。工数のないタスクはこちらでも最後。同じ工数の中は渡した並びの順", () => {
    expect(ids(sortTasks(rows, "points-desc"))).toEqual(["g", "c", "a", "f", "d", "b", "e", "h"]);
  });

  it("渡した配列は変えない。空・1件でも動く", () => {
    const copy = [...rows];
    for (const sort of TASK_SORTS) sortTasks(rows, sort);
    expect(rows).toEqual(copy);
    for (const sort of TASK_SORTS) {
      expect(sortTasks([], sort)).toEqual([]);
      expect(ids(sortTasks([row("x", null, null)], sort))).toEqual(["x"]);
    }
  });

  it("すべての値が決まりどおりの順（優先度は PRIORITIES の順、工数は POINTS の順）", () => {
    const all = [...PRIORITIES].reverse().map((priority, i) => row(`p${i}`, priority, null));
    expect(sortTasks(all, "priority").map((r) => r.priority)).toEqual([...PRIORITIES]);
    const byPoints = [...POINTS].reverse().map((points, i) => row(`n${i}`, null, points));
    expect(sortTasks(byPoints, "points-asc").map((r) => r.points)).toEqual([...POINTS]);
    expect(sortTasks(byPoints, "points-desc").map((r) => r.points)).toEqual([...POINTS].reverse());
  });

  it("★ 今日のリストを並べ替える計算は、タイトルやメモの変更では計算し直さず、優先度・工数・並び（rank）の変更で計算し直す", () => {
    const { replica, lists } = setupLists();
    let a = makeTask({ bucket: "today", rank: "a1", priority: "low", seq: nextSeq() });
    let b = makeTask({ bucket: "today", rank: "a2", priority: null, points: 2, seq: nextSeq() });
    let c = makeTask({ bucket: "today", rank: "a3", priority: "high", points: 5, seq: nextSeq() });
    replica.replaceConfirmed([a, b, c].map((row) => ({ kind: "task" as const, row })));

    let runs = 0;
    const sorted = computed(() => {
      runs++;
      return sortTasks(lists.today, "priority").map((r) => r.id);
    });
    const seen: string[][] = [];
    const dispose = autorun(() => {
      seen.push(sorted.get());
    });
    expect(seen).toEqual([[c.id, a.id, b.id]]);
    expect(runs).toBe(1);

    a = put(replica, a, { title: "新しいタイトル", memo: "メモ" });
    b = put(replica, b, { checklist: [{ id: "x", title: "項目", done: false }] });
    expect(runs).toBe(1);

    // 優先度で並べているときは、工数が変わっても計算し直さない
    b = put(replica, b, { points: 8 });
    expect(runs).toBe(1);
    expect(seen).toHaveLength(1);

    a = put(replica, a, { priority: "high" });
    expect(seen.at(-1)).toEqual([a.id, c.id, b.id]);

    // rank を入れ替えると、同じ優先度の中の順が変わる
    c = put(replica, c, { rank: "a0" });
    expect(seen.at(-1)).toEqual([c.id, a.id, b.id]);
    dispose();
  });
});

describe("工数の合計", () => {
  it("sumPoints：工数のないタスクは数えない", () => {
    expect(sumPoints([])).toBe(0);
    expect(sumPoints([{ points: null }, { points: 3 }, { points: 13 }, { points: null }])).toBe(16);
  });

  it("★ 今日（未完了）・プロジェクト（未完了）・今日のボード・プロジェクトのボードの各列の合計", () => {
    const { replica, lists, day } = setupLists();
    const project = makeProject({ seq: nextSeq() });
    const other = makeProject({ seq: nextSeq() });
    const completedAt = new Date("2026-01-15T04:00:00.000Z").toISOString();
    const startedAt = completedAt;
    const tasks = [
      // 今日：未着手 3 + なし、進行中 5、完了 8
      makeTask({ bucket: "today", rank: "a1", points: 3, projectId: project.id, seq: nextSeq() }),
      makeTask({ bucket: "today", rank: "a2", points: null, seq: nextSeq() }),
      makeTask({ bucket: "today", rank: "a3", points: 5, startedAt, seq: nextSeq() }),
      makeTask({ bucket: "today", rank: "a4", points: 8, completedAt, seq: nextSeq() }),
      // 今日の外（今日の合計には入らない）
      makeTask({ bucket: "later", points: 13, projectId: project.id, seq: nextSeq() }),
      makeTask({
        bucket: "scheduled",
        scheduledOn: "2026-02-01",
        points: 2,
        projectId: project.id,
        seq: nextSeq(),
      }),
      makeTask({ bucket: "inbox", points: 1, projectId: project.id, seq: nextSeq() }),
      // プロジェクトの完了（直近）と、削除済み（どこにも入らない）
      makeTask({ bucket: "later", points: 5, projectId: project.id, completedAt, seq: nextSeq() }),
      makeTask({
        bucket: "today",
        points: 13,
        projectId: project.id,
        deletedAt: completedAt,
        seq: nextSeq(),
      }),
      // ほかのプロジェクト
      makeTask({ bucket: "later", points: 8, projectId: other.id, seq: nextSeq() }),
    ];
    replica.replaceConfirmed([
      { kind: "project", row: project },
      { kind: "project", row: other },
      ...tasks.map((row) => ({ kind: "task" as const, row })),
    ]);
    expect(day.today).toBe("2026-01-15");

    expect(lists.todayPoints).toBe(3 + 5);
    // 今日のボードの完了の列は「今日完了したもの」なので、今日以外で完了したプロジェクトのタスク（5）も入る
    expect(lists.todayBoardPoints).toEqual({ notStarted: 3, inProgress: 5, completed: 8 + 5 });
    expect(lists.projectPoints(project.id)).toBe(3 + 13 + 2 + 1);
    expect(lists.projectBoardPoints(project.id)).toEqual({
      notStarted: 3 + 13 + 2 + 1,
      inProgress: 0,
      completed: 5,
    });
    expect(lists.projectPoints(other.id)).toBe(8);
    expect(lists.projectPoints("no-such-project")).toBe(0);
  });

  it("★ 合計はタイトル・メモ・優先度の変更では計算し直さず、工数の変更と行の出入りで計算し直す", () => {
    const { replica, lists } = setupLists();
    const project = makeProject({ seq: nextSeq() });
    let a = makeTask({ bucket: "today", rank: "a1", points: 3, projectId: project.id });
    let b = makeTask({ bucket: "today", rank: "a2", points: null, projectId: project.id });
    replica.replaceConfirmed([
      { kind: "project", row: project },
      { kind: "task", row: { ...a, seq: nextSeq() } },
      { kind: "task", row: { ...b, seq: nextSeq() } },
    ]);

    let runs = 0;
    const totals = computed(() => {
      runs++;
      return [
        lists.todayPoints,
        lists.todayBoardPoints.notStarted,
        lists.projectPoints(project.id),
        lists.projectBoardPoints(project.id).notStarted,
      ];
    });
    const seen: number[][] = [];
    const dispose = reaction(
      () => totals.get(),
      (value) => seen.push(value),
      { fireImmediately: true },
    );
    expect(seen).toEqual([[3, 3, 3, 3]]);
    expect(runs).toBe(1);

    a = put(replica, a, { title: "新しいタイトル", memo: "メモ", priority: "high" });
    b = put(replica, b, { title: "別のタイトル" });
    expect(runs).toBe(1);

    b = put(replica, b, { points: 5 });
    expect(seen.at(-1)).toEqual([8, 8, 8, 8]);

    // 進行中にすると、今日のボードの未着手の列から抜ける（今日の合計はそのまま）
    a = put(replica, a, { startedAt: "2026-01-15T03:00:00.000Z" });
    expect(seen.at(-1)).toEqual([8, 5, 8, 5]);
    expect(lists.todayBoardPoints).toEqual({ notStarted: 5, inProgress: 3, completed: 0 });

    // 完了すると未完了の合計から抜ける
    b = put(replica, b, { completedAt: "2026-01-15T04:00:00.000Z" });
    expect(seen.at(-1)).toEqual([3, 0, 3, 0]);
    expect(lists.todayBoardPoints).toEqual({ notStarted: 0, inProgress: 3, completed: 5 });
    expect(lists.projectBoardPoints(project.id)).toEqual({
      notStarted: 0,
      inProgress: 3,
      completed: 5,
    });
    dispose();
  });

  it("TaskRow：priority・points は項目ごとに観測する（タイトル変更では動かず、その項目の変化で動く）", () => {
    const { replica } = setupLists();
    let task = makeTask({ bucket: "today", seq: nextSeq() });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const row = replica.task(task.id);
    if (!row) throw new Error("row が見つかりません");

    const priorities: (Priority | null)[] = [];
    const points: (Points | null)[] = [];
    const disposePriority = autorun(() => {
      priorities.push(row.priority);
    });
    const disposePoints = autorun(() => {
      points.push(row.points);
    });

    task = put(replica, task, { title: "新しいタイトル" });
    expect(priorities).toEqual([null]);
    expect(points).toEqual([null]);

    task = put(replica, task, { priority: "medium" });
    expect(priorities).toEqual([null, "medium"]);
    expect(points).toEqual([null]);

    task = put(replica, task, { points: 13 });
    expect(priorities).toEqual([null, "medium"]);
    expect(points).toEqual([null, 13]);

    disposePriority();
    disposePoints();
  });
});

/** /api/mutate に送った各まとまりの changes（送った順） */
function sentChanges(server: FakeServer): object[][] {
  return server
    .requestsTo("/api/mutate")
    .map((request) =>
      (request.body as { mutations: { changes?: object }[] }).mutations.map((m) => m.changes ?? {}),
    );
}

describe("⌘Z とほかのタブ・送信中の重ね合わせ（テストの見直しで追加）", () => {
  it("★ 優先度の ⌘Z は優先度だけを戻す。そのあいだにほかのタブが変えたタイトル・メモ・工数は消さない", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "元", bucket: "today", priority: "low", points: 2 }),
    );
    const store = makeStore(server);
    await store.start();

    store.actions.setPriority([task.id], "high");
    await store.idle();

    // ほかのタブ：同じタスクのタイトル・メモ・工数を変えた
    server.putTask({ id: task.id, title: "ほかのタブ", memo: "ほかのメモ", points: 13 });
    await store.sync();

    expect(store.actions.undo().ok).toBe(true);
    await store.idle();
    const expected = { title: "ほかのタブ", memo: "ほかのメモ", priority: "low", points: 13 };
    expect(server.tasks.get(task.id)).toMatchObject(expected);
    expect(store.task(task.id)?.peek()).toMatchObject(expected);
    // ⌘Z で送ったのは優先度だけ
    expect(sentChanges(server).at(-1)).toEqual([{ priority: "low" }]);
  });

  it("★ 工数の ⌘Z は工数だけを戻す。そのあいだにほかのタブが変えたタイトル・優先度は消さない", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "元", bucket: "later", priority: "low", points: 2 }),
    );
    const store = makeStore(server);
    await store.start();

    store.actions.setPoints([task.id], 8);
    await store.idle();

    server.putTask({ id: task.id, title: "ほかのタブ", priority: "high" });
    await store.sync();

    expect(store.actions.undo().ok).toBe(true);
    await store.idle();
    const expected = { title: "ほかのタブ", priority: "high", points: 2, bucket: "later" };
    expect(server.tasks.get(task.id)).toMatchObject(expected);
    expect(store.task(task.id)?.peek()).toMatchObject(expected);
    expect(sentChanges(server).at(-1)).toEqual([{ points: 2 }]);
  });

  it("★ ほかのタブが同じ項目を変えていても、⌘Z は後勝ちで前の値に戻す（ぶつかりとしては扱わず、知らせも出さない）", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((notice) => notices.push(notice));

    store.actions.setPriority([task.id], "high");
    store.actions.setPoints([task.id], 3);
    await store.idle();

    // ほかのタブ：同じ項目を別の値にした
    server.putTask({ id: task.id, priority: "medium", points: 13 });
    await store.sync();
    expect(store.task(task.id)).toMatchObject({ priority: "medium", points: 13 });

    expect(store.actions.undo().ok).toBe(true);
    expect(store.actions.undo().ok).toBe(true);
    await store.idle();
    expect(server.tasks.get(task.id)).toMatchObject({ priority: null, points: null });
    expect(store.task(task.id)).toMatchObject({ priority: null, points: null });
    expect(sentChanges(server).slice(-2)).toEqual([[{ points: null }], [{ priority: null }]]);
    expect(notices).toEqual([]);
    expect(store.canUndo).toBe(false);
  });

  it("★ 送信中の優先度・工数は、同期で届いたその行の古い値に上書きされない（ほかの項目の変更は見え、並べ替えと合計も送信中の値で計算する）", async () => {
    const server = new FakeServer();
    const other = server.putTask(makeTask({ bucket: "today", rank: "a0", priority: "medium" }));
    const task = server.putTask(
      makeTask({ title: "元", bucket: "today", rank: "a1", priority: "low", points: 1 }),
    );
    const store = makeStore(server);
    await store.start();
    expect(sortTasks(store.lists.today, "priority").map((row) => row.id)).toEqual([
      other.id,
      task.id,
    ]);

    const release = server.hold("/api/mutate");
    store.actions.setPriority([task.id], "high");
    store.actions.setPoints([task.id], 8);

    // ほかのタブ：タイトルと、同じ項目（こちらが送信中の値とは違う値）を変えた
    server.putTask({ id: task.id, title: "ほかのタブ", priority: "medium", points: 13 });
    await store.sync();
    expect(store.task(task.id)?.peek().seq).toBe(server.tasks.get(task.id)?.seq);

    expect(store.task(task.id)).toMatchObject({ title: "ほかのタブ", priority: "high", points: 8 });
    expect(sortTasks(store.lists.today, "priority").map((row) => row.id)).toEqual([
      task.id,
      other.id,
    ]);
    expect(store.lists.todayPoints).toBe(8);

    release();
    await store.idle();
    expect(store.pendingCount).toBe(0);
    const expected = { title: "ほかのタブ", priority: "high", points: 8 };
    expect(store.task(task.id)).toMatchObject(expected);
    expect(server.tasks.get(task.id)).toMatchObject(expected);
  });

  it("送信中の変更が断られたら、表示は同期で届いた新しい行（ほかのタブの値）に戻る。送る前の値には戻らない", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "元", bucket: "today", priority: "low", points: 1 }),
    );
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((notice) => notices.push(notice));

    const release = server.hold("/api/mutate");
    store.actions.setPriority([task.id], "high");
    server.putTask({ id: task.id, title: "ほかのタブ", priority: "medium", points: 13 });
    await store.sync();
    expect(store.task(task.id)).toMatchObject({
      title: "ほかのタブ",
      priority: "high",
      points: 13,
    });

    server.fail("/api/mutate", 400);
    release();
    await store.idle();
    expect(store.pendingCount).toBe(0);
    expect(store.task(task.id)).toMatchObject({
      title: "ほかのタブ",
      priority: "medium",
      points: 13,
    });
    expect(notices[0]).toMatchObject({ type: "save-failed", reason: "rejected" });
    expect(store.canUndo).toBe(false);
  });
});

describe("工数の合計と並べ替えの観測の範囲（テストの見直しで追加）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 論理日付で今日（2026-01-15）の完了 */
  const completedAt = "2026-01-15T04:00:00.000Z";

  /**
   * プロジェクト P・Q と、プロジェクトのないタスクを置いた写し。
   * edit(key, changes) で、その行の新しい版が確定データとして届いた（ほかのタブの変更など）とする
   */
  function setupBoard() {
    const { replica, lists } = setupLists();
    const P = makeProject({ seq: nextSeq() });
    const Q = makeProject({ seq: nextSeq() });
    const initial = {
      pToday: makeTask({ bucket: "today", rank: "a1", points: 3, projectId: P.id }),
      pLater: makeTask({
        bucket: "later",
        rank: "a1",
        points: 5,
        priority: "low",
        projectId: P.id,
      }),
      pLater2: makeTask({ bucket: "later", rank: "a2", priority: "high", projectId: P.id }),
      pScheduled: makeTask({
        bucket: "scheduled",
        scheduledOn: "2026-02-01",
        points: 2,
        projectId: P.id,
      }),
      pInbox: makeTask({ bucket: "inbox", points: 1, projectId: P.id }),
      pDone: makeTask({ bucket: "today", rank: "a0", points: 8, projectId: P.id, completedAt }),
      // 7 日より前の完了（プロジェクトのボードの完了の列にも、今日の完了にも入らない）
      pOldDone: makeTask({
        bucket: "later",
        points: 3,
        projectId: P.id,
        completedAt: "2026-01-01T04:00:00.000Z",
      }),
      qToday: makeTask({ bucket: "today", rank: "a2", points: 13, projectId: Q.id }),
      qLater: makeTask({ bucket: "later", rank: "a3", points: 1, projectId: Q.id }),
      qDone: makeTask({ bucket: "later", points: 2, projectId: Q.id, completedAt }),
      loose: makeTask({ bucket: "later", rank: "a4", points: 2 }),
    };
    type Key = keyof typeof initial;
    const current = new Map<Key, Task>();
    for (const [key, row] of Object.entries(initial) as [Key, Task][]) {
      current.set(key, { ...row, seq: nextSeq() });
    }
    replica.replaceConfirmed([
      { kind: "project", row: P },
      { kind: "project", row: Q },
      ...Array.from(current.values(), (row) => ({ kind: "task" as const, row })),
    ]);
    const edit = (key: Key, changes: Partial<Task>) => {
      const task = current.get(key);
      if (!task) throw new Error(`${key} がありません`);
      current.set(key, put(replica, task, changes));
    };
    const id = (key: Key) => current.get(key)?.id ?? "";
    const totals = () => ({
      today: lists.todayPoints,
      todayBoard: lists.todayBoardPoints,
      p: lists.projectPoints(P.id),
      pBoard: lists.projectBoardPoints(P.id),
      q: lists.projectPoints(Q.id),
    });
    return { lists, P, Q, edit, id, totals };
  }

  /**
   * 合計を計算し直すと、対象の行の工数を読む。工数（field("points")）か行全体（value）を読んだ行の id を集める
   * （何も読まれなければ、どの合計も計算し直していない。行全体を観測する作りに変わっても、ここで分かる）
   */
  function spyPointsReads() {
    const rowPrototype = Object.getPrototypeOf(TaskRow.prototype) as TaskRow;
    const field = vi.spyOn(rowPrototype, "field");
    const value = vi.spyOn(rowPrototype, "value", "get");
    const idOf = (row: unknown) => (row as TaskRow).id;
    return () => [
      ...field.mock.calls.flatMap(([key], i) =>
        key === "points" ? [idOf(field.mock.contexts[i])] : [],
      ),
      ...value.mock.contexts.map(idOf),
    ];
  }

  it("前提：はじめの合計", () => {
    const { totals } = setupBoard();
    expect(totals()).toEqual({
      today: 3 + 13,
      todayBoard: { notStarted: 3 + 13, inProgress: 0, completed: 8 + 2 },
      p: 3 + 2 + 5 + 1,
      pBoard: { notStarted: 3 + 2 + 5 + 1, inProgress: 0, completed: 8 },
      q: 13 + 1,
    });
  });

  it("★ 合計は、タイトル・メモ・優先度・チェックリスト・締切の変更では、どの行の工数も読み直さない", () => {
    const { edit, id, totals } = setupBoard();
    const seen: ReturnType<typeof totals>[] = [];
    const dispose = autorun(() => {
      seen.push(totals());
    });
    const reads = spyPointsReads();

    for (const key of [
      "pToday",
      "pLater",
      "pDone",
      "pInbox",
      "qToday",
      "qDone",
      "loose",
    ] as const) {
      edit(key, { title: `新しい ${key}`, memo: "メモ" });
      edit(key, { priority: "medium" });
      edit(key, { checklist: [{ id: "c", title: "項目", done: false }] });
      edit(key, { deadlineOn: "2026-03-01" });
    }
    expect(reads()).toEqual([]);
    expect(seen).toHaveLength(1);

    // 対照：工数を変えると読み直す（読んだ行を数える仕掛けが効いている）
    edit("pToday", { points: 5 });
    expect(reads()).toContain(id("pToday"));
    expect(seen).toHaveLength(2);
    dispose();
  });

  it("★ プロジェクトの合計は、ほかのプロジェクト・プロジェクトのないタスクの変更（工数・移動・進行中・完了・削除）と、7 日より前の完了の変更では読み直さない", () => {
    const { lists, P, edit, id } = setupBoard();
    const seen: unknown[] = [];
    const dispose = autorun(() => {
      seen.push([lists.projectPoints(P.id), lists.projectBoardPoints(P.id)]);
    });
    const reads = spyPointsReads();

    edit("qLater", { points: 8 });
    edit("qLater", { bucket: "inbox" });
    edit("qToday", { points: 5 });
    edit("qToday", { startedAt: completedAt });
    edit("qToday", { completedAt });
    edit("qDone", { points: 13 });
    edit("qLater", { deletedAt: completedAt });
    edit("loose", { points: 13 });
    edit("loose", { bucket: "today", rank: "a5" });
    edit("pOldDone", { points: 13 });
    expect(reads()).toEqual([]);
    expect(seen).toHaveLength(1);

    // 対照：P のタスクの工数を変えると読み直す
    edit("pInbox", { points: 5 });
    expect(reads()).toContain(id("pInbox"));
    expect(seen).toHaveLength(2);
    dispose();
  });

  it("★ 今日の合計は、今日の外の未完了のタスクの変更（工数・予定の日付・置き場の移動・削除）と、今日より前の完了の変更では読み直さない", () => {
    const { lists, edit, id } = setupBoard();
    const seen: unknown[] = [];
    const dispose = autorun(() => {
      seen.push([lists.todayPoints, lists.todayBoardPoints]);
    });
    const reads = spyPointsReads();

    edit("pLater", { points: 13 });
    edit("pScheduled", { points: 13, scheduledOn: "2026-02-02" });
    edit("pInbox", { points: 13 });
    edit("qLater", { bucket: "inbox" });
    edit("pOldDone", { points: 13 });
    edit("loose", { deletedAt: completedAt });
    expect(reads()).toEqual([]);
    expect(seen).toHaveLength(1);

    // 対照：今日のタスクの工数を変えると読み直す
    edit("qToday", { points: 5 });
    expect(reads()).toContain(id("qToday"));
    expect(seen).toHaveLength(2);
    dispose();
  });

  it("★ 合計は、工数の変更と行の出入り（移動・進行中・完了・削除・プロジェクトの付け替え）で計算し直し、見ている側に届く", () => {
    const { Q, edit, totals } = setupBoard();
    const seen: ReturnType<typeof totals>[] = [];
    const dispose = autorun(() => {
      seen.push(totals());
    });
    const last = () => seen.at(-1);

    // 工数を変える（今日・プロジェクト）
    edit("pToday", { points: 5 });
    expect(last()).toEqual({
      today: 18,
      todayBoard: { notStarted: 18, inProgress: 0, completed: 10 },
      p: 13,
      pBoard: { notStarted: 13, inProgress: 0, completed: 8 },
      q: 14,
    });
    // 今日完了したタスクの工数を変える（完了の列だけ）
    edit("pDone", { points: 1 });
    expect(last()).toMatchObject({
      todayBoard: { notStarted: 18, inProgress: 0, completed: 3 },
      pBoard: { notStarted: 13, inProgress: 0, completed: 1 },
    });
    // あとで → 今日（今日の合計に入る。プロジェクトの合計は変わらない）
    edit("pLater", { bucket: "today", rank: "a3" });
    expect(last()).toMatchObject({ today: 23, p: 13 });
    // 進行中にする（未着手の列 → 進行中の列）
    edit("pLater", { startedAt: completedAt });
    expect(last()).toMatchObject({
      today: 23,
      todayBoard: { notStarted: 18, inProgress: 5, completed: 3 },
      pBoard: { notStarted: 8, inProgress: 5, completed: 1 },
    });
    // 完了する（未完了の合計から抜け、完了の列に入る）
    edit("pToday", { completedAt });
    expect(last()).toEqual({
      today: 18,
      todayBoard: { notStarted: 13, inProgress: 5, completed: 8 },
      p: 8,
      pBoard: { notStarted: 3, inProgress: 5, completed: 6 },
      q: 14,
    });
    // 削除する
    edit("pScheduled", { deletedAt: completedAt });
    expect(last()).toMatchObject({ p: 6, pBoard: { notStarted: 1, inProgress: 5, completed: 6 } });
    // プロジェクトを付け替える（P から抜け、Q に入る）
    edit("pInbox", { projectId: Q.id });
    expect(last()).toMatchObject({ p: 5, pBoard: { notStarted: 0 }, q: 15 });
    // 工数のなかったタスクに工数を付ける
    edit("pLater2", { points: 8 });
    expect(last()).toMatchObject({ p: 13, pBoard: { notStarted: 8, inProgress: 5, completed: 6 } });
    // ほかのプロジェクトの今日のタスクの工数（今日の合計と Q の合計だけが変わる）
    edit("qToday", { points: 1 });
    expect(last()).toEqual({
      today: 6,
      todayBoard: { notStarted: 1, inProgress: 5, completed: 8 },
      p: 13,
      pBoard: { notStarted: 8, inProgress: 5, completed: 6 },
      q: 3,
    });
    dispose();
  });

  it("★ 並べ替えの計算は、使う項目・rank・行の出入りで計算し直し、タイトル・メモ・使わない項目・ほかのプロジェクトの変更では計算し直さない", () => {
    const { lists, P, Q, edit, id } = setupBoard();
    const watch = (rows: () => readonly TaskRow[]) => {
      let runs = 0;
      const value = computed(() => {
        runs++;
        return rows().map((row) => row.id);
      });
      const seen: (readonly string[])[] = [];
      const dispose = autorun(() => {
        seen.push(value.get());
      });
      return { runs: () => runs, last: () => seen.at(-1), dispose };
    };
    const today = watch(() => sortTasks(lists.today, "points-asc"));
    const later = watch(() => sortTasks(lists.project(P.id).later, "priority"));
    expect(today.last()).toEqual([id("pToday"), id("qToday")]);
    expect(later.last()).toEqual([id("pLater2"), id("pLater")]);

    // 計算し直さない
    edit("pToday", { title: "新しいタイトル", memo: "メモ" });
    edit("pToday", { priority: "high" });
    edit("qToday", { priority: "low", checklist: [{ id: "c", title: "項目", done: false }] });
    edit("pLater", { points: 13, title: "新しいタイトル" });
    edit("pLater2", { memo: "メモ", deadlineOn: "2026-03-01" });
    edit("qLater", { priority: "high", points: 13, title: "新しいタイトル" });
    edit("qLater", { bucket: "inbox" });
    edit("loose", { priority: "high" });
    edit("pScheduled", { priority: "high" });
    expect([today.runs(), later.runs()]).toEqual([1, 1]);

    // 計算し直す：使う項目
    edit("qToday", { points: 1 });
    expect(today.last()).toEqual([id("qToday"), id("pToday")]);
    edit("pLater", { priority: "high" });
    expect(later.last()).toEqual([id("pLater"), id("pLater2")]);
    // rank（同じ値の中の順）
    edit("qToday", { points: 3 });
    expect(today.last()).toEqual([id("pToday"), id("qToday")]);
    edit("qToday", { rank: "a0" });
    expect(today.last()).toEqual([id("qToday"), id("pToday")]);
    edit("pLater2", { rank: "a0" });
    expect(later.last()).toEqual([id("pLater2"), id("pLater")]);
    // 行の出入り：移動で入る・完了・削除・プロジェクトの付け替え
    edit("loose", { bucket: "today", rank: "a5" });
    expect(today.last()).toEqual([id("loose"), id("qToday"), id("pToday")]);
    edit("pToday", { completedAt });
    expect(today.last()).toEqual([id("loose"), id("qToday")]);
    edit("qToday", { deletedAt: completedAt });
    expect(today.last()).toEqual([id("loose")]);
    edit("pLater", { projectId: Q.id });
    expect(later.last()).toEqual([id("pLater2")]);
    edit("pInbox", { bucket: "later", rank: "a9" });
    expect(later.last()).toEqual([id("pLater2"), id("pInbox")]);
    edit("pLater2", { bucket: "today", rank: "a6" });
    expect(later.last()).toEqual([id("pInbox")]);
    expect(today.last()).toEqual([id("loose"), id("pLater2")]);

    today.dispose();
    later.dispose();
  });
});

describe("sortTasks：決まりから作った並びと突き合わせる（テストの見直しで追加）", () => {
  it("★ いろいろな組み合わせで、決まった値の順に「その値の行を受け取った順に」つないだ並びと同じになる", () => {
    // 決まった種から作る乱数（毎回同じ並びを試す）
    let seed = 20260927;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const pick = <T>(values: readonly T[]): T => {
      const value = values[Math.floor(random() * values.length)];
      if (value === undefined) throw new Error("値がありません");
      return value;
    };
    type Row = { id: string; priority: Priority | null; points: Points | null };
    const priorityOrder = [...PRIORITIES, null];
    const ascOrder = [...POINTS, null];
    const descOrder = [...[...POINTS].reverse(), null];

    for (let round = 0; round < 30; round++) {
      const rows: Row[] = Array.from({ length: 1 + Math.floor(random() * 40) }, (_, i) => ({
        id: `r${round}-${i}`,
        priority: pick(priorityOrder),
        points: pick(ascOrder),
      }));
      const byValue = <V>(order: readonly V[], get: (row: Row) => V) =>
        order.flatMap((value) => rows.filter((row) => get(row) === value));
      const expected: Record<TaskSort, Row[]> = {
        manual: rows,
        priority: byValue(priorityOrder, (row) => row.priority),
        "points-asc": byValue(ascOrder, (row) => row.points),
        "points-desc": byValue(descOrder, (row) => row.points),
      };
      for (const sort of TASK_SORTS) {
        expect(sortTasks(rows, sort), `${sort}（${round} 回目）`).toEqual(expected[sort]);
      }
    }
  });
});
