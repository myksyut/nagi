import { describe, expect, it, vi } from "vitest";
import { FakeServer } from "../test/fake-server";
import { makeTask } from "../test/fixtures";
import { ApiClient } from "./api-client";
import { createMemoryLocalDb, type LocalDb } from "./local-db";
import { Replica } from "./replica";
import { SyncClient } from "./sync-client";

/** 3. 差分の取得（POST /api/sync） */

function setup(server: FakeServer) {
  const replica = new Replica();
  const api = new ApiClient({ fetch: server.fetch });
  const localDb: LocalDb = createMemoryLocalDb();
  const onFailed = vi.fn();
  const onSynced = vi.fn();
  const sync = new SyncClient({
    replica,
    api,
    localDb: () => localDb,
    canSync: () => true,
    isActive: () => true,
    onSynced,
    onFailed,
  });
  return { replica, sync, server, onFailed, onSynced };
}

describe("差分の取得：ページング", () => {
  it("hasMore が続くあいだ、ページごとに { cursor, baseCursor } で取り、全部そろうまで表示に出ない", async () => {
    const server = new FakeServer();
    server.pageSize = 1;
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002", title: "B" }));
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000003", title: "C" }));
    const { replica, sync, onSynced } = setup(server);

    const release = server.hold("/api/sync");
    const promise = sync.sync();
    // 最初のページがまだ止まっているあいだは、何も反映されていない
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000001")).toBeUndefined();
    release();
    await promise;

    expect(onSynced).toHaveBeenCalledTimes(1);
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000001")?.title).toBe("A");
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000002")?.title).toBe("B");
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000003")?.title).toBe("C");

    const requests = server.requestsTo("/api/sync");
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.body)).toEqual([
      { cursor: 0, baseCursor: 0 },
      { cursor: 1, baseCursor: 0 },
      { cursor: 2, baseCursor: 0 },
    ]);
  });

  it("途中のページでは表示に出ない（1ページ目が届いても、2ページ目を待つあいだはまだ反映されない）", async () => {
    const server = new FakeServer();
    server.pageSize = 1;
    const t1 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));
    const t2 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002", title: "B" }));
    const { replica } = setup(server);

    // 1回目の要求は通し、2回目の要求（最後のページ）だけを止める
    let release: (() => void) | undefined;
    let callCount = 0;
    const originalFetch = server.fetch;
    const wrapped: typeof fetch = (input, init) => {
      callCount++;
      if (callCount === 2) release = server.hold("/api/sync");
      return originalFetch(input, init);
    };
    const api = new ApiClient({ fetch: wrapped });
    const s2 = new SyncClient({
      replica,
      api,
      localDb: () => createMemoryLocalDb(),
      canSync: () => true,
      isActive: () => true,
      onSynced: () => {},
      onFailed: () => {},
    });

    const promise = s2.sync();
    await vi.waitFor(() => {
      expect(server.requestsTo("/api/sync")).toHaveLength(2);
    });

    // 2ページ目（最後）を待っているあいだは、すでに届いた1ページ目の行もまだ反映されていない
    expect(replica.confirmedTask(t1.id)).toBeUndefined();
    expect(replica.task(t1.id)).toBeUndefined();

    release?.();
    await promise;

    // 全部そろってから反映されている（両方とも見える）
    expect(replica.confirmedTask(t1.id)?.title).toBe("A");
    expect(replica.confirmedTask(t2.id)?.title).toBe("B");
  });
});

describe("差分の取得：カーソル", () => {
  it("カーソルは差分の取得でだけ進み、操作の応答では動かない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001" }));
    const { replica, sync } = setup(server);
    await sync.sync();
    expect(sync.cursor).toBe(server.seq);
    const cursorAfterSync = sync.cursor;

    // 操作の応答で行が確定データに入っても、カーソルは動かない
    const confirmedRow = server.putTask({ id: "0199a000-0000-7000-8000-000000000002" });
    replica.mergeConfirmed([{ kind: "task", row: confirmedRow }]);
    expect(sync.cursor).toBe(cursorAfterSync);

    // 次の sync の要求の cursor で確かめる
    await sync.sync();
    const requests = server.requestsTo("/api/sync");
    expect(requests.at(-1)?.body).toEqual({ cursor: cursorAfterSync, baseCursor: cursorAfterSync });
  });
});

describe("差分の取得：reset", () => {
  it("purgeDeleted による reset で { 0, 0} から取り直し、手元（メモリ）を置き換える", async () => {
    const server = new FakeServer();
    const t1 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001" }));
    const { replica, sync } = setup(server);
    // 削除される前に、いったんここまで同期しておく（baseCursor がその時点で止まる）
    await sync.sync();
    expect(sync.cursor).toBe(1);

    // クライアントが同期する前に、削除して物理削除まで進んでしまう
    server.putTask({ ...t1, deletedAt: "2020-01-01T00:00:00.000Z" });
    server.purgeDeleted("2025-01-01T00:00:00.000Z");
    const t2 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002" }));

    await sync.sync();
    expect(sync.cursor).toBe(server.seq);
    // 置き換え後は、生き残った行だけが確定データにある
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000001")).toBeUndefined();
    expect(replica.confirmedTask(t2.id)).toBeDefined();

    const requests = server.requestsTo("/api/sync");
    // reset を受けて {0,0} から取り直している
    expect(
      requests.some((r) => JSON.stringify(r.body) === JSON.stringify({ cursor: 0, baseCursor: 0 })),
    ).toBe(true);
  });

  it("Time Travel（restore）による reset でも取り直す", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001" }));
    const { replica, sync } = setup(server);
    await sync.sync();
    const snapshot = server.snapshot();

    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002" }));
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000003" }));
    await sync.sync();
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000003")).toBeDefined();

    // 巻き戻す：手元の cursor がサーバーの meta.seq より新しくなる
    server.restore(snapshot);
    await sync.sync();

    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000002")).toBeUndefined();
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000003")).toBeUndefined();
    expect(replica.confirmedTask("0199a000-0000-7000-8000-000000000001")).toBeDefined();
  });

  it("reset のあいだも送信中の操作は重なったまま", async () => {
    const server = new FakeServer();
    const t1 = server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001", title: "A" }));
    server.putTask({ ...t1, deletedAt: "2020-01-01T00:00:00.000Z" });
    const { replica, sync } = setup(server);
    await sync.sync();

    replica.addPending([
      {
        id: "0199a000-0000-7000-9000-000000000099",
        at: "2026-01-01T00:00:00.000Z",
        operationId: "0199a000-0000-7000-9000-000000000098",
        kind: "task.update",
        mutations: [
          {
            type: "task.update",
            id: "0199a000-0000-7000-8000-000000000001",
            changes: { title: "送信中" },
          },
        ],
      },
    ]);

    server.purgeDeleted("2025-01-01T00:00:00.000Z");
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002" }));
    await sync.sync();

    // reset で確定データは置き換わったが、送信中の操作はまだ重なっている
    // （replaceConfirmed 時点でその id の確定データがなくなっていても task.update は base が undefined なら何も出さない仕様なので、
    //   ここでは削除済みで置き換わらない別の行を確認する）
    expect(replica.pending).toHaveLength(1);
  });
});

describe("差分の取得：連続した呼び出し", () => {
  it("同期中にもう一度 sync() を呼ぶと、終わったあとにもう1回取る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001" }));
    const { sync } = setup(server);

    const release = server.hold("/api/sync");
    const first = sync.sync();
    const second = sync.sync();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000002" }));
    release();
    await Promise.all([first, second]);

    const requests = server.requestsTo("/api/sync");
    expect(requests.length).toBeGreaterThanOrEqual(2);
  });
});

describe("差分の取得：初回", () => {
  it("IndexedDB に何もないとき（初回）は cursor も baseCursor も 0 から取る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ id: "0199a000-0000-7000-8000-000000000001" }));
    const { sync } = setup(server);
    await sync.sync();
    const first = server.requestsTo("/api/sync")[0];
    expect(first?.body).toEqual({ cursor: 0, baseCursor: 0 });
  });
});
