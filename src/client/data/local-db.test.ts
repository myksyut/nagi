import { when } from "mobx";
import { afterEach, describe, expect, it } from "vitest";
import { FakeServer } from "../test/fake-server";
import { makeTask } from "../test/fixtures";
import { LOCAL_DB_VERSION, openLocalDb } from "./local-db";
import { AppStore } from "./store";

/** 6. IndexedDB */

let dbCount = 0;
function uniqueName(): string {
  dbCount += 1;
  return `local-db-test-${dbCount}`;
}

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

function makeStore(server: FakeServer, name: string) {
  const store = new AppStore({ fetch: server.fetch, openLocalDb: () => openLocalDb({ name }) });
  stores.push(store);
  return store;
}

describe("IndexedDB：同期した行とカーソルの保存", () => {
  it("別のストア（別タブ）が同じ名前で開くと、同期の前に描ける", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A", bucket: "today" }),
    );
    const name = uniqueName();

    const first = makeStore(server, name);
    await first.start();
    expect(first.lists.today.map((t) => t.title)).toEqual(["A"]);

    // 2つ目のタブ：同期の応答を止めた状態で開く
    const release = server.hold("/api/sync");
    const second = makeStore(server, name);
    const started = second.start();
    await when(() => second.loaded);

    // loaded は true、同期はまだ（hold 中）でも、IndexedDB から描ける
    expect(second.synced).toBe(false);
    expect(second.lists.today.map((t) => t.title)).toEqual(["A"]);

    release();
    await started;
    expect(second.synced).toBe(true);
  });
});

describe("IndexedDB：保存形式の版の切り替え", () => {
  it("version を上げて開くと中身が空・カーソル 0 になり、{0,0} から取り直す", async () => {
    const name = uniqueName();
    const server = new FakeServer();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));

    const v1Store = new AppStore({
      fetch: server.fetch,
      openLocalDb: () => openLocalDb({ name, version: 1 }),
    });
    stores.push(v1Store);
    await v1Store.start();
    expect(v1Store.task("0199a000-0000-7000-8000-000000000001")?.title).toBe("A");

    const v2Store = new AppStore({
      fetch: server.fetch,
      openLocalDb: () => openLocalDb({ name, version: 2 }),
    });
    stores.push(v2Store);
    // 版が変わったので中身は捨てられる。手元は空 → cursor 0 から取り直す
    await v2Store.start();
    expect(v2Store.synced).toBe(true);
    const requests = server.requestsTo("/api/sync");
    expect(requests[0]?.body).toEqual({ cursor: 0, baseCursor: 0 });
    // 取り直した結果、最終的にはデータが見える
    expect(v2Store.task("0199a000-0000-7000-8000-000000000001")?.title).toBe("A");
  });

  it("LOCAL_DB_VERSION は現在 3 である（回帰の目印。2 で startedAt と color、3 で priority と points を足した）", () => {
    expect(LOCAL_DB_VERSION).toBe(3);
  });
});

describe("IndexedDB：カーソルの進め方（CursorAdvance）", () => {
  it("保存済みが 10 で { from: 5, to: 12 } なら 12 になる", async () => {
    const name = uniqueName();
    const db = await openLocalDb({ name });
    await db.putRows([], { from: 0, to: 10 });
    await db.putRows([], { from: 5, to: 12 });
    const snapshot = await db.load();
    expect(snapshot.cursor).toBe(12);
    db.close();
  });

  it("保存済みが 3（ほかのタブが置き換えで下げた）で { from: 5, to: 12 } なら 3 のまま（行は書かれる）", async () => {
    const name = uniqueName();
    const db = await openLocalDb({ name });
    // ほかのタブが全件の置き換えでカーソルを 3 に下げた、とする
    await db.replaceAll([], 3);
    const row = makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "X" });
    await db.putRows([{ kind: "task", row }], { from: 5, to: 12 });
    const snapshot = await db.load();
    // 控えに from(5) までの欠けがある（保存済みは 3）ので、カーソルは進めない
    expect(snapshot.cursor).toBe(3);
    // 行そのものは書かれる
    expect(snapshot.tasks.find((t) => t.id === row.id)?.title).toBe("X");
    db.close();
  });
});

describe("IndexedDB：複数のタブの書き込み", () => {
  it("古い seq の行で新しい行を上書きしない", async () => {
    const name = uniqueName();
    const db1 = await openLocalDb({ name: `${name}-shared`, version: 1 });
    try {
      const id = "0199a000-0000-7000-8000-000000000001";
      const newer = makeTask({ id, title: "新しい", seq: 5 });
      await db1.putRows([{ kind: "task", row: newer }]);

      const older = makeTask({ id, title: "古い", seq: 3 });
      await db1.putRows([{ kind: "task", row: older }]);

      const snapshot = await db1.load();
      expect(snapshot.tasks.find((t) => t.id === id)?.title).toBe("新しい");
    } finally {
      db1.close();
    }
  });

  it("2つのタブが同じ DB に書くとき、片方が古いタブでも新しい行を巻き戻さない", async () => {
    const name = `${uniqueName()}-tab-shared`;
    const db1 = await openLocalDb({ name, version: 1 });
    const db2 = await openLocalDb({ name, version: 1 });
    try {
      const id = "0199a000-0000-7000-8000-000000000002";
      await db1.putRows([{ kind: "task", row: makeTask({ id, title: "tab1", seq: 10 }) }]);
      // 2つ目のタブは古い版の行を書こうとする
      await db2.putRows([{ kind: "task", row: makeTask({ id, title: "tab2 古い", seq: 4 }) }]);

      const snapshot = await db1.load();
      expect(snapshot.tasks.find((t) => t.id === id)?.title).toBe("tab1");
    } finally {
      db1.close();
      db2.close();
    }
  });
});
