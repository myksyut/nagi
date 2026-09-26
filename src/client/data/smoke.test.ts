import { when } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServer } from "../test/fake-server";
import { createMemoryLocalDb, openLocalDb } from "./local-db";
import type { Notice } from "./notices";
import { AppStore } from "./store";

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

let dbCount = 0;
function makeStore(server: FakeServer, options: { memory?: boolean; dbName?: string } = {}) {
  const name = options.dbName ?? `smoke-${++dbCount}`;
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: options.memory ? async () => createMemoryLocalDb() : () => openLocalDb({ name }),
  });
  stores.push(store);
  return { store, name };
}

describe("smoke", () => {
  it("起動・差分・追加・完了・IndexedDB", async () => {
    const server = new FakeServer();
    server.putTask({
      id: "0199a000-0000-7000-8000-000000000001",
      title: "A",
      bucket: "today",
      rank: "a1",
    });
    server.putTask({
      id: "0199a000-0000-7000-8000-000000000002",
      title: "B",
      bucket: "today",
      rank: "a0",
    });
    const { store, name } = makeStore(server);
    await store.start();
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "A"]);

    const added = store.actions.addTask({ title: "C", bucket: "today" });
    expect(added.ok).toBe(true);
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "A", "C"]);
    await store.idle();
    const id = added.ok ? added.ids[0] : "";
    expect(store.task(id ?? "")?.seq).toBeGreaterThan(0);

    store.actions.completeTasks(["0199a000-0000-7000-8000-000000000001"]);
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "C"]);
    expect(store.lists.completedTodayCount).toBe(1);
    await store.idle();

    const undo = store.actions.undo();
    expect(undo.ok).toBe(true);
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "A", "C"]);
    await store.idle();
    expect(server.tasks.get("0199a000-0000-7000-8000-000000000001")?.completedAt).toBeNull();

    // 別のストア（別のタブ）で同じ IndexedDB を開くと、同期の前に描ける
    await store.sync();
    const other = makeStore(server, { dbName: name }).store;
    const release = server.hold("/api/sync");
    const started = other.start();
    await when(() => other.loaded);
    expect(other.lists.today.map((t) => t.title)).toEqual(["B", "A", "C"]);
    expect(other.synced).toBe(false);
    release();
    await started;
    expect(other.synced).toBe(true);
    const syncs = server.requestsTo("/api/sync");
    expect(syncs.at(-1)?.body).toEqual({ cursor: server.seq, baseCursor: server.seq });
  });

  it("送信中の操作は差分が届いても消えない", async () => {
    const server = new FakeServer();
    server.putTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A", bucket: "today" });
    const { store } = makeStore(server, { memory: true });
    await store.start();
    const release = server.hold("/api/mutate");
    store.actions.completeTasks(["0199a000-0000-7000-8000-000000000001"]);
    server.putTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A2" });
    await store.sync();
    const task = store.task("0199a000-0000-7000-8000-000000000001");
    expect(task?.title).toBe("A2");
    expect(task?.completedAt).not.toBeNull();
    release();
    await store.idle();
    expect(store.task("0199a000-0000-7000-8000-000000000001")?.completedAt).not.toBeNull();
    expect(store.pendingCount).toBe(0);
  });

  it("再送して駄目なら戻して知らせる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    server.putTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A", bucket: "today" });
    const { store } = makeStore(server, { memory: true });
    await store.start();
    const notices: Notice[] = [];
    store.subscribe((n) => notices.push(n));
    server.fail("/api/mutate", "network", 503, "network");
    store.actions.addTask({ title: "新しい", bucket: "today" });
    expect(store.lists.today).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);
    await store.idle();
    expect(server.requestsTo("/api/mutate")).toHaveLength(3);
    const ids = new Set(server.requestsTo("/api/mutate").map((r) => (r.body as { id: string }).id));
    expect(ids.size).toBe(1);
    expect(store.lists.today).toHaveLength(1);
    expect(notices[0]).toMatchObject({ type: "save-failed", reason: "network" });
    expect(notices[0]?.type === "save-failed" && notices[0].failedCreates[0]?.title).toBe("新しい");
  });

  it("401 で止まる", async () => {
    const server = new FakeServer();
    server.authorized = false;
    const { store } = makeStore(server, { memory: true });
    await store.start();
    expect(store.stoppedBy).toBe("unauthorized");
  });
});
