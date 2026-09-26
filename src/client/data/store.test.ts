import { rankAfter } from "@shared/rank";
import { reaction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServer } from "../test/fake-server";
import { makeTask } from "../test/fixtures";
import { createMemoryLocalDb, openLocalDb } from "./local-db";
import type { Notice } from "./notices";
import { AppStore, DELETED_ROW_TTL_DAYS } from "./store";

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

let dbCount = 0;
function uniqueName(): string {
  dbCount += 1;
  return `store-test-${dbCount}`;
}

function makeStore(server: FakeServer, now?: () => Date) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
    now,
  });
  stores.push(store);
  return store;
}

describe("1. 重ねて見せる仕組み（Store 統合）", () => {
  it("操作はすぐ表示に出る", async () => {
    const server = new FakeServer();
    const store = makeStore(server);
    await store.start();
    store.actions.addTask({ title: "追加", bucket: "today" });
    expect(store.lists.today.map((t) => t.title)).toEqual(["追加"]);
  });

  it("失敗（400）で送信中の操作が捨てられて元に戻る", async () => {
    const server = new FakeServer();
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((n) => notices.push(n));
    server.fail("/api/mutate", 400);
    store.actions.addTask({ title: "追加", bucket: "today" });
    expect(store.lists.today).toHaveLength(1);
    await store.idle();
    expect(store.lists.today).toHaveLength(0);
    expect(notices[0]).toMatchObject({ type: "save-failed", reason: "rejected" });
  });

  it("再送しても駄目な通信エラーで送信中の操作が捨てられて元に戻る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const store = makeStore(server);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((n) => notices.push(n));
    server.fail("/api/mutate", "network", "network", "network");
    store.actions.addTask({ title: "追加", bucket: "today" });
    expect(store.lists.today).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);
    await store.idle();
    expect(store.lists.today).toHaveLength(0);
    expect(notices[0]).toMatchObject({ type: "save-failed", reason: "network" });
  });

  it("hold で送信を止めたまま、サーバー側で同じ行のほかの項目を変えて sync() しても、送信中の操作は消えずに重なる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "元", bucket: "today" }));
    const store = makeStore(server);
    await store.start();

    const release = server.hold("/api/mutate");
    store.actions.completeTasks([task.id]);
    expect(store.task(task.id)?.completedAt).not.toBeNull();

    server.putTask({ ...task, memo: "サーバー側で変更" });
    await store.sync();

    // 完了（送信中）は消えず、サーバー側の変更（memo）は反映される
    expect(store.task(task.id)?.completedAt).not.toBeNull();
    expect(store.task(task.id)?.memo).toBe("サーバー側で変更");

    release();
    await store.idle();
    expect(store.pendingCount).toBe(0);
    expect(store.task(task.id)?.completedAt).not.toBeNull();
  });

  it("確定の瞬間に表示がちらつかない（同じ行オブジェクト・同じ値）", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "元", bucket: "today" }));
    const store = makeStore(server);
    await store.start();

    const before = store.task(task.id);
    store.actions.updateTask(task.id, { title: "新" });
    expect(store.task(task.id)).toBe(before);
    await store.idle();
    expect(store.task(task.id)).toBe(before);
    expect(store.task(task.id)?.title).toBe("新");
  });
});

describe("2. seq による上書きの判定と削除の後始末（Store 統合）", () => {
  it("削除から30日たった行は起動時に IndexedDB（手元の控え）からは読み込まれない", async () => {
    // IndexedDB に「30日以上前に削除された行」がすでにある場合は、#start() の alive フィルタで
    // 読み込み時に除かれる（ここは実装済み）
    const now = () => new Date("2026-02-01T05:00:00.000Z");
    const server = new FakeServer();
    const old = makeTask({ deletedAt: "2025-12-01T00:00:00.000Z" });
    const recent = makeTask({ deletedAt: "2026-01-25T00:00:00.000Z" });
    const { openLocalDb } = await import("./local-db");
    const name = "store-purge-startup-test";
    const seedDb = await openLocalDb({ name });
    await seedDb.putRows([
      { kind: "task", row: old },
      { kind: "task", row: recent },
    ]);
    seedDb.close();

    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: () => openLocalDb({ name }),
      now,
    });
    stores.push(store);
    const release = server.hold("/api/sync");
    const started = store.start();
    // 同期がまだ終わっていない（IndexedDB からの読み込みだけの）段階で確認する
    await vi.waitFor(() => expect(store.loaded).toBe(true));
    expect(store.task(old.id)).toBeUndefined();
    expect(store.task(recent.id)).toBeDefined();
    release();
    await started;
  });

  // 修正済み：起動して最初の同期のあと（synced が false → true になったとき）にも #purgeExpired() を呼ぶ
  // ので、サーバーから初回同期で届いた（IndexedDB には未保存だった）30日超の削除済み行も、
  // 起動時点で手元から消える
  it("初回同期で届いた30日超の削除済み行も、起動時点で手元から消える", async () => {
    const now = () => new Date("2026-02-01T05:00:00.000Z");
    const server = new FakeServer();
    const old = server.putTask(makeTask({ deletedAt: "2025-12-01T00:00:00.000Z" }));
    const store = makeStore(server, now);
    await store.start();
    expect(store.task(old.id)).toBeUndefined();
  });

  it("日付が変わったときにも 30 日たった行を手元から消す", async () => {
    let current = new Date("2026-01-01T00:00:00.000Z");
    const now = () => current;
    const server = new FakeServer();
    const task = server.putTask(makeTask({ deletedAt: "2026-01-01T00:00:00.000Z" }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(current);
    const store = makeStore(server, now);
    await store.start();
    expect(store.task(task.id)).toBeDefined();

    // DELETED_ROW_TTL_DAYS + 1 日進める
    current = new Date(current.getTime() + (DELETED_ROW_TTL_DAYS + 1) * 24 * 60 * 60 * 1000);
    vi.setSystemTime(current);
    await vi.runOnlyPendingTimersAsync();
    expect(store.task(task.id)).toBeUndefined();
  });
});

describe("5. 日付の切り替わりの前後（現在時刻を差し替えて）", () => {
  it("午前4時ちょうどにタイマーで today が変わり、差分を1回取る", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    // 2026-01-14 03:59:00 JST = 2026-01-13T18:59:00Z
    let current = new Date("2026-01-13T18:59:00.000Z");
    vi.setSystemTime(current);
    const server = new FakeServer();
    const store = makeStore(server, () => current);
    await store.start();
    expect(store.today).toBe("2026-01-13");
    const syncCountBefore = server.requestsTo("/api/sync").length;

    // 3:59:59（1分未満前）ではまだ変わらない
    current = new Date("2026-01-13T18:59:59.000Z");
    vi.setSystemTime(current);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(store.today).toBe("2026-01-13");

    // 4:00:00 ちょうど
    current = new Date("2026-01-13T19:00:00.000Z");
    vi.setSystemTime(current);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.today).toBe("2026-01-14");
    expect(server.requestsTo("/api/sync").length).toBeGreaterThan(syncCountBefore);
  });

  it("completedToday は午前4時をまたぐと切り替わる。到着の印（isArrivedToday）も同様", async () => {
    // 論理日付 2026-01-14 のあいだに完了・到着したタスク
    const server = new FakeServer();
    server.putTask(makeTask({ bucket: "later", completedAt: "2026-01-14T10:00:00.000Z" }));
    const arrived = server.putTask(makeTask({ bucket: "today", arrivedOn: "2026-01-14" }));
    const store = makeStore(server, () => new Date("2026-01-14T15:00:00.000Z"));
    await store.start();
    expect(store.today).toBe("2026-01-14");
    expect(store.lists.completedTodayCount).toBe(1);
    const arrivedRow = store.lists.today.find((t) => t.id === arrived.id);
    expect(arrivedRow && store.lists.isArrivedToday(arrivedRow)).toBe(true);

    // 日付が変わった後のストアで見ると、もう「今日」ではない
    const storeNextDay = makeStore(server, () => new Date("2026-01-15T05:00:00.000Z"));
    await storeNextDay.start();
    expect(storeNextDay.lists.completedTodayCount).toBe(0);
    const arrivedRow2 = storeNextDay.lists.today.find((t) => t.id === arrived.id);
    expect(arrivedRow2 && storeNextDay.lists.isArrivedToday(arrivedRow2)).toBe(false);
  });
});

describe("8. オフライン", () => {
  it("つなぐ時点（#listen）で navigator.onLine を読み直す", async () => {
    const server = new FakeServer();
    const window = new EventTarget() as unknown as Window;
    Object.assign(window, { navigator: { onLine: true } });
    const document = new EventTarget() as unknown as Document;
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
      window,
      document,
    });
    stores.push(store);

    // コンストラクタのあと、start()（#listen）が呼ばれる前にオフラインになった
    (window as unknown as { navigator: { onLine: boolean } }).navigator.onLine = false;

    await store.start();

    expect(store.isOnline).toBe(false);
    const result = store.actions.addTask({ title: "x", bucket: "today" });
    expect(result).toEqual({ ok: false, reason: "offline" });
  });

  it("offline イベントで isOnline が false になり、操作の入口が offline を返し、何も送らず、知らせが届く", async () => {
    const server = new FakeServer();
    const window = new EventTarget() as unknown as Window;
    Object.assign(window, { navigator: { onLine: true } });
    const document = new EventTarget() as unknown as Document;
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
      window,
      document,
    });
    stores.push(store);
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((n) => notices.push(n));

    window.dispatchEvent(new Event("offline"));
    expect(store.isOnline).toBe(false);

    const before = store.lists.today.length;
    const result = store.actions.addTask({ title: "オフライン中", bucket: "today" });
    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(store.lists.today).toHaveLength(before);
    expect(server.requestsTo("/api/mutate")).toHaveLength(0);
    expect(notices[0]).toMatchObject({ type: "offline-blocked" });

    // online に戻ると差分を取る
    const syncCountBefore = server.requestsTo("/api/sync").length;
    window.dispatchEvent(new Event("online"));
    expect(store.isOnline).toBe(true);
    await store.sync();
    expect(server.requestsTo("/api/sync").length).toBeGreaterThan(syncCountBefore);
  });

  it("completeTasks・moveTasks・undo もオフラインでは offline を返す", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const window = new EventTarget() as unknown as Window;
    Object.assign(window, { navigator: { onLine: true } });
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
      window,
      document: new EventTarget() as unknown as Document,
    });
    stores.push(store);
    await store.start();
    window.dispatchEvent(new Event("offline"));

    expect(store.actions.completeTasks([task.id])).toEqual({ ok: false, reason: "offline" });
    expect(store.actions.moveTasks([task.id], { bucket: "later" })).toEqual({
      ok: false,
      reason: "offline",
    });
    expect(store.actions.undo()).toEqual({ ok: false, reason: "nothing-to-undo" });
  });
});

describe("9. 401 と 409", () => {
  it("同期で 401 になると stoppedBy が unauthorized になり、知らせが届く。以後は操作が stopped、同期もしない", async () => {
    const server = new FakeServer();
    server.authorized = false;
    const store = makeStore(server);
    const notices: Notice[] = [];
    store.subscribe((n) => notices.push(n));
    await store.start();
    expect(store.stoppedBy).toBe("unauthorized");
    expect(notices.some((n) => n.type === "unauthorized")).toBe(true);

    const result = store.actions.addTask({ title: "x", bucket: "today" });
    expect(result).toEqual({ ok: false, reason: "stopped" });

    const syncCountBefore = server.requestsTo("/api/sync").length;
    await store.sync();
    expect(server.requestsTo("/api/sync").length).toBe(syncCountBefore);
  });

  it("送信で 401 になっても stoppedBy が unauthorized になる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    server.authorized = false;
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.stoppedBy).toBe("unauthorized");
  });

  it("同期で 409 になると stoppedBy が version-mismatch になる", async () => {
    const server = new FakeServer();
    const store = makeStore(server);
    await store.start();
    server.apiVersion = 999;
    await store.sync();
    expect(store.stoppedBy).toBe("version-mismatch");
  });

  it("送信で 409 になると stoppedBy が version-mismatch になる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    server.apiVersion = 999;
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.stoppedBy).toBe("version-mismatch");
  });
});

describe("10. 元に戻す（Store 統合）", () => {
  it("まとめて完了した3件を undo 1回で3件とも戻し、逆向きのまとまりは1リクエスト", async () => {
    const server = new FakeServer();
    const tasks = [
      server.putTask(makeTask({ bucket: "today" })),
      server.putTask(makeTask({ bucket: "today" })),
      server.putTask(makeTask({ bucket: "today" })),
    ];
    const store = makeStore(server);
    await store.start();
    store.actions.completeTasks(tasks.map((t) => t.id));
    await store.idle();
    expect(store.lists.completedTodayCount).toBe(3);

    const mutateCountBefore = server.requestsTo("/api/mutate").length;
    const undo = store.actions.undo();
    expect(undo.ok).toBe(true);
    await store.idle();
    expect(store.lists.completedTodayCount).toBe(0);
    expect(store.lists.today.map((t) => t.id).sort()).toEqual(tasks.map((t) => t.id).sort());
    expect(server.requestsTo("/api/mutate").length).toBe(mutateCountBefore + 1);
    const lastRequest = server.requestsTo("/api/mutate").at(-1);
    expect((lastRequest?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(3);
  });

  it("受信箱から今日へ移したのを戻すと bucket と rank が元の値に戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "inbox", rank: "a0" }));
    const store = makeStore(server);
    await store.start();
    store.actions.moveTasks([task.id], { bucket: "today" });
    expect(store.task(task.id)?.bucket).toBe("today");
    store.actions.undo();
    expect(store.task(task.id)?.bucket).toBe("inbox");
    expect(store.task(task.id)?.rank).toBe("a0");
  });

  it("予定から移したのを戻すと scheduledOn も戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "scheduled", scheduledOn: "2026-03-01" }));
    const store = makeStore(server);
    await store.start();
    store.actions.moveTasks([task.id], { bucket: "later" });
    expect(store.task(task.id)?.scheduledOn).toBeNull();
    store.actions.undo();
    expect(store.task(task.id)?.bucket).toBe("scheduled");
    expect(store.task(task.id)?.scheduledOn).toBe("2026-03-01");
  });

  it("完了の直後に戻すと元の置き場・元の位置（rank は変わらない）", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "later", rank: "m0" }));
    const store = makeStore(server);
    await store.start();
    store.actions.completeTasks([task.id]);
    store.actions.undo();
    expect(store.task(task.id)?.bucket).toBe("later");
    expect(store.task(task.id)?.rank).toBe("m0");
    expect(store.task(task.id)?.completedAt).toBeNull();
    // 元に戻す操作そのものは、元に戻すの対象にならない
    expect(store.canUndo).toBe(false);
  });

  it("失敗して捨てられた操作は元に戻すの対象から外れる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    server.fail("/api/mutate", 400);
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.canUndo).toBe(false);
    expect(store.actions.undo()).toEqual({ ok: false, reason: "nothing-to-undo" });
  });

  it("undo の送信自体が 400 で失敗したときは、戻す対象に積み直さない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server);
    await store.start();
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.canUndo).toBe(true);

    server.fail("/api/mutate", 400);
    const undo = store.actions.undo();
    expect(undo.ok).toBe(true);
    expect(store.canUndo).toBe(false);
    await store.idle();

    // 400 なので再送はされず、そのまま「戻せない」ままになる（同じ操作がまた失敗するだけなので積み直さない）
    expect(store.canUndo).toBe(false);
    // undo の送信（完了を取り消す操作）自体が捨てられたので、表示は完了したままに戻る
    expect(store.task(task.id)?.completedAt).not.toBeNull();
  });

  it("undo の送信が再送しても通信エラーなら、戻す対象に積み直されもう一度 undo できる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today", rank: "m0" }));
    const store = makeStore(server);
    await store.start();
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.canUndo).toBe(true);

    server.fail("/api/mutate", "network", "network", "network");
    const undo = store.actions.undo();
    expect(undo.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);
    await store.idle();

    // 再送しても駄目だったので、undo は失敗して表示は undo 前（完了済み）に戻る
    expect(store.task(task.id)?.completedAt).not.toBeNull();
    // 通信エラーなので、もう一度 ⌘Z で戻せるように積み直されている
    expect(store.canUndo).toBe(true);

    const secondUndo = store.actions.undo();
    expect(secondUndo.ok).toBe(true);
    await store.idle();
    expect(store.task(task.id)?.completedAt).toBeNull();
    expect(store.task(task.id)?.rank).toBe("m0");
  });

  it("オフラインで undo を止めたとき、その操作は戻す対象に残る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ bucket: "today" }));
    const window = new EventTarget() as unknown as Window;
    Object.assign(window, { navigator: { onLine: true } });
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
      window,
      document: new EventTarget() as unknown as Document,
    });
    stores.push(store);
    await store.start();
    store.actions.completeTasks([task.id]);
    await store.idle();
    expect(store.canUndo).toBe(true);

    window.dispatchEvent(new Event("offline"));
    const result = store.actions.undo();
    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(store.canUndo).toBe(true);
  });
});

describe("完了ログの等値判定（ちらつき防止）", () => {
  it("関係ない変更では知らせず、関係する変更（昨日の完了を外す）だけ知らせる", async () => {
    const server = new FakeServer();
    const yesterdayCompleted = server.putTask(
      makeTask({ completedAt: "2026-01-14T05:00:00.000Z", bucket: "later" }),
    );
    const todayOpen = server.putTask(makeTask({ bucket: "today" }));
    const store = makeStore(server, () => new Date("2026-01-15T05:00:00.000Z"));
    await store.start();
    expect(store.lists.logbook.flatMap((d) => d.tasks.map((t) => t.id))).toContain(
      yesterdayCompleted.id,
    );

    const spy = vi.fn();
    const dispose = reaction(() => store.lists.logbook, spy);

    // 今日の未完了タスクのタイトル変更
    store.actions.updateTask(todayOpen.id, { title: "新しいタイトル" });
    await store.idle();
    expect(spy).not.toHaveBeenCalled();

    // 完了ログの行のタイトル変更
    store.actions.updateTask(yesterdayCompleted.id, { title: "別の名前" });
    await store.idle();
    expect(spy).not.toHaveBeenCalled();

    // 今日の分の完了（完了ログには入らない）
    store.actions.completeTasks([todayOpen.id]);
    await store.idle();
    expect(spy).not.toHaveBeenCalled();

    // 昨日の完了を外す（完了ログから抜ける）
    store.actions.uncompleteTasks([yesterdayCompleted.id]);
    expect(spy).toHaveBeenCalledTimes(1);

    dispose();
  });
});

describe("reset（AppStore を通して確かめる）", () => {
  it("取り直しのあいだに AppStore で確定した操作は、メモリにも IndexedDB にも残る。続く同期が失敗しても消えない", async () => {
    const server = new FakeServer();
    const t1 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));
    const name = uniqueName();

    // 手元の IndexedDB に、物理削除される前の状態を直接入れておく（cursor: 1）
    const seedDb = await openLocalDb({ name });
    await seedDb.putRows([{ kind: "task", row: t1 }], { from: 0, to: 1 });
    seedDb.close();

    // t1 を削除して物理削除する（baseCursor(1) がこれより古くなるので reset が起きる）
    server.putTask({ ...t1, deletedAt: "2020-01-01T00:00:00.000Z" });
    server.purgeDeleted("2025-01-01T00:00:00.000Z");

    // reset の応答（1回目）のあとの、取り直しの本番のページ（2回目の /api/sync）だけを hold する
    let syncCallCount = 0;
    let release: (() => void) | undefined;
    const originalFetch = server.fetch;
    const wrapped: typeof fetch = (input, init) => {
      const path = typeof input === "string" ? input : input.toString();
      if (path.includes("/api/sync")) {
        syncCallCount++;
        if (syncCallCount === 2) release = server.hold("/api/sync");
      }
      return originalFetch(input, init);
    };

    const store = new AppStore({ fetch: wrapped, openLocalDb: () => openLocalDb({ name }) });
    stores.push(store);
    const started = store.start();
    await vi.waitFor(() => expect(release).toBeDefined());

    // 取り直しの本番のページを待っているあいだに、addTask を送って確定させる（/api/mutate は通す）
    const added = store.actions.addTask({ title: "確定済み", bucket: "today" });
    expect(added.ok).toBe(true);
    await store.idle();
    const newId = added.ok ? added.ids[0] : "";
    expect(newId).toBeTruthy();
    // ここでサーバー側から該当行を消す。「取り直しの応答が、この確定より古い時点のもの」を模す
    // （このテストの偽サーバーは応答を実行時に計算するため、直接この操作で再現する）
    server.tasks.delete(newId ?? "");

    release?.();
    await started;

    // 取り直しの結果（この行を含まない）で置き換わったあとも、確定した行は重ね直されて消えない
    expect(store.task(newId ?? "")?.title).toBe("確定済み");
    expect(store.lists.today.some((t) => t.id === newId)).toBe(true);

    // IndexedDB にも残っている
    const check = await openLocalDb({ name });
    const snapshot = await check.load();
    expect(snapshot.tasks.find((t) => t.id === newId)?.title).toBe("確定済み");
    check.close();

    // 続く同期が失敗しても（通信エラー）消えたままにならない
    server.fail("/api/sync", "network");
    await store.sync();
    expect(store.task(newId ?? "")?.title).toBe("確定済み");
  });
});

describe("複数のタブの競合（カーソルの飛び越え防止）", () => {
  it("ほかのタブが置き換えでカーソルを下げたあとは、飛び越えて進まない。最終的には新しいタブがサーバーの全行を持つ", async () => {
    const server = new FakeServer();
    const t1 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));
    const t2 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002", title: "B" }));
    const name = uniqueName();

    const tabA = new AppStore({ fetch: server.fetch, openLocalDb: () => openLocalDb({ name }) });
    stores.push(tabA);
    await tabA.start();
    expect(tabA.task(t2.id)?.title).toBe("B");

    // タブ B が（reset などで）全件を古い状態で置き換え、カーソルを下げた
    const dbB = await openLocalDb({ name });
    await dbB.replaceAll([{ kind: "task", row: t1 }], 1);
    dbB.close();

    // タブ A は自分のメモリのカーソル（2）のまま、普通の同期を続ける
    server.putTask({ ...t2, title: "B2" });
    await tabA.sync();
    // A 自身のメモリは進む
    expect(tabA.task(t2.id)?.title).toBe("B2");

    // だが IndexedDB のカーソルは飛び越えて進んでいない（保存済み 1 のまま）
    const check = await openLocalDb({ name });
    const snapshot = await check.load();
    expect(snapshot.cursor).toBe(1);
    check.close();

    // 新しいタブ（この IndexedDB を開く）が同期を終えると、サーバーの全行（t2 も）を持つ
    const tabC = new AppStore({ fetch: server.fetch, openLocalDb: () => openLocalDb({ name }) });
    stores.push(tabC);
    await tabC.start();
    expect(tabC.task(t2.id)?.title).toBe("B2");
  });
});

describe("手元の控えを読み損ねたあとの起動", () => {
  it("サーバーで物理削除された行は、読み込み失敗のあとも手元に残らない", async () => {
    const server = new FakeServer();
    const oldTask = server.putTask(
      makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "古い生きてる版" }),
    );
    const name = uniqueName();

    // IndexedDB に古い行とカーソルを直接入れておく
    const seedDb = await openLocalDb({ name });
    await seedDb.putRows([{ kind: "task", row: oldTask }], { from: 0, to: 1 });
    seedDb.close();

    // サーバー側で削除して物理削除する（IndexedDB にはまだ残っている）
    server.putTask({ ...oldTask, deletedAt: "2020-01-01T00:00:00.000Z" });
    server.purgeDeleted("2025-01-01T00:00:00.000Z");

    // load() を1回だけ失敗させる
    let failNextLoad = true;
    const wrappedOpen = async () => {
      const db = await openLocalDb({ name });
      return {
        load: async () => {
          if (failNextLoad) {
            failNextLoad = false;
            throw new Error("読み込み失敗（テスト）");
          }
          return db.load();
        },
        putRows: db.putRows.bind(db),
        replaceAll: db.replaceAll.bind(db),
        purgeDeleted: db.purgeDeleted.bind(db),
        close: db.close.bind(db),
      };
    };

    const store1 = new AppStore({ fetch: server.fetch, openLocalDb: wrappedOpen });
    stores.push(store1);
    await store1.start();
    // 読み込みに失敗したので cursor 0 から全件取得。物理削除済みなので届かない
    expect(store1.task(oldTask.id)).toBeUndefined();

    // 新しいストアで同じ IndexedDB を普通に開き、同期の前（hold 中）を確認する
    const release = server.hold("/api/sync");
    const store2 = new AppStore({ fetch: server.fetch, openLocalDb: () => openLocalDb({ name }) });
    stores.push(store2);
    const started = store2.start();
    await vi.waitFor(() => expect(store2.loaded).toBe(true));
    // 控えからすでに消えている（全件置き換えで正しく上書きされたので）
    expect(store2.task(oldTask.id)).toBeUndefined();
    release();
    await started;
  });
});

describe("7. 送信の列：500 まで", () => {
  it("501 件の completeTasks は too-many で、何も送らず、表示も変わらない", async () => {
    const server = new FakeServer();
    const tasks = Array.from({ length: 501 }, () => server.putTask(makeTask({ bucket: "today" })));
    const store = makeStore(server);
    await store.start();
    const before = store.lists.today.length;

    const result = store.actions.completeTasks(tasks.map((t) => t.id));
    expect(result).toEqual({ ok: false, reason: "too-many" });
    expect(store.lists.today).toHaveLength(before);
    expect(server.requestsTo("/api/mutate")).toHaveLength(0);
  });

  it("500 件はちょうど1リクエスト（mutations が500件）で通る", async () => {
    const server = new FakeServer();
    const tasks = Array.from({ length: 500 }, () => server.putTask(makeTask({ bucket: "today" })));
    const store = makeStore(server);
    await store.start();

    const result = store.actions.completeTasks(tasks.map((t) => t.id));
    expect(result.ok).toBe(true);
    await store.idle();
    expect(store.lists.completedTodayCount).toBe(500);
    const requests = server.requestsTo("/api/mutate");
    expect(requests).toHaveLength(1);
    expect((requests[0]?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(
      500,
    );
  });
});

describe("11. setDeadline（Store 統合：元に戻す）", () => {
  it("元に戻すで bucket・rank・scheduledOn・arrivedOn・deadlineOn がすべて元に戻る", async () => {
    const server = new FakeServer();
    const originalRank = rankAfter(null);
    const task = server.putTask(
      makeTask({ bucket: "later", rank: originalRank, deadlineOn: null, arrivedOn: null }),
    );
    const store = makeStore(server);
    await store.start();

    store.actions.setDeadline([task.id], store.today);
    expect(store.task(task.id)?.bucket).toBe("today");
    expect(store.task(task.id)?.deadlineOn).toBe(store.today);
    expect(store.task(task.id)?.arrivedOn).toBe(store.today);

    store.actions.undo();
    expect(store.task(task.id)?.bucket).toBe("later");
    expect(store.task(task.id)?.rank).toBe(originalRank);
    expect(store.task(task.id)?.scheduledOn).toBeNull();
    expect(store.task(task.id)?.arrivedOn).toBeNull();
    expect(store.task(task.id)?.deadlineOn).toBeNull();
  });
});
