import { API_VERSION, API_VERSION_HEADER } from "@shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeServer } from "../test/fake-server";
import { makeBatch, makeTask } from "../test/fixtures";
import { ApiClient } from "./api-client";
import { Replica } from "./replica";
import { RETRY_DELAYS_MS, SendQueue } from "./send-queue";

/** 7. 送信の列 */

afterEach(() => {
  vi.useRealTimers();
});

function setup(server: FakeServer) {
  const replica = new Replica();
  const api = new ApiClient({ fetch: server.fetch });
  const persisted: unknown[] = [];
  const confirmed: unknown[] = [];
  const failed: { error: unknown; discarded: unknown }[] = [];
  const queue = new SendQueue({
    replica,
    api,
    persist: (rows) => persisted.push(rows),
    onConfirmed: (batch) => confirmed.push(batch),
    onFailed: (error, discarded) => failed.push({ error, discarded }),
  });
  return { replica, queue, persisted, confirmed, failed };
}

/** replica と（テスト用の）サーバーの両方に、同じタスクを用意する */
function seedTask(
  server: FakeServer,
  replica: Replica,
  overrides: Parameters<typeof makeTask>[0] = {},
) {
  const task = makeTask(overrides);
  server.putTask(task);
  replica.replaceConfirmed([{ kind: "task", row: task }]);
  return task;
}

describe("送信の列：基本", () => {
  it("1つの操作が1つのまとまり（1リクエスト）で送られる", async () => {
    const server = new FakeServer();
    const { replica, queue, confirmed } = setup(server);
    const task = seedTask(server, replica);
    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }] }),
    ]);
    queue.kick();
    await queue.idle();
    expect(server.requestsTo("/api/mutate")).toHaveLength(1);
    expect(confirmed).toHaveLength(1);
  });

  it("まとまりは積んだ順に1本ずつ送る（前の応答を待ってから次）", async () => {
    const server = new FakeServer();
    const { replica, queue } = setup(server);
    const task = seedTask(server, replica);
    const release = server.hold("/api/mutate");
    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "1" } }] }),
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "2" } }] }),
    ]);
    queue.kick();
    await Promise.resolve();
    await Promise.resolve();
    // 1本目が止まっているあいだは、2本目はまだ送られない
    expect(server.requestsTo("/api/mutate")).toHaveLength(1);
    release();
    await queue.idle();
    expect(server.requestsTo("/api/mutate")).toHaveLength(2);
  });

  it("すべての要求に X-Api-Version と Content-Type: application/json を付ける", async () => {
    const server = new FakeServer();
    const { replica, queue } = setup(server);
    const task = seedTask(server, replica);
    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }] }),
    ]);
    queue.kick();
    await queue.idle();
    const request = server.requestsTo("/api/mutate")[0];
    expect(request?.headers.get(API_VERSION_HEADER)).toBe(String(API_VERSION));
    expect(request?.headers.get("Content-Type")).toBe("application/json");
  });
});

describe("送信の列：再送", () => {
  it("通信エラー・5xx は同じ ID で2回まで再送する（0.5秒後・2秒後）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const { replica, queue, confirmed } = setup(server);
    const task = seedTask(server, replica);
    server.fail("/api/mutate", "network", 503);
    const batch = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }],
    });
    replica.addPending([batch]);
    queue.kick();

    await vi.advanceTimersByTimeAsync(0);
    expect(server.requestsTo("/api/mutate")).toHaveLength(1);

    // 0.49 秒ではまだ送らない
    await vi.advanceTimersByTimeAsync(490);
    expect(server.requestsTo("/api/mutate")).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(10);
    expect(server.requestsTo("/api/mutate")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(server.requestsTo("/api/mutate")).toHaveLength(3);

    await queue.idle();
    expect(confirmed).toHaveLength(1);
    const ids = new Set(server.requestsTo("/api/mutate").map((r) => (r.body as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("RETRY_DELAYS_MS は [500, 2000] である（回帰の目印）", () => {
    expect(RETRY_DELAYS_MS).toEqual([500, 2000]);
  });

  it("drop-response（処理されたが応答が届かない）は、同じ ID の再送が重複と判定され成功扱いになる", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const { replica, queue, confirmed, failed } = setup(server);
    const task = seedTask(server, replica);
    server.fail("/api/mutate", "drop-response");
    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }] }),
    ]);
    queue.kick();
    await vi.advanceTimersByTimeAsync(0);
    // 1回目は応答が届かないが、サーバーでは処理されている
    expect(server.tasks.get(task.id)?.title).toBe("新");
    await vi.advanceTimersByTimeAsync(500);
    await queue.idle();

    expect(failed).toHaveLength(0);
    expect(confirmed).toHaveLength(1);
    expect(replica.task(task.id)?.title).toBe("新");
    expect(replica.pending).toHaveLength(0);
    // 再送は同じ ID
    const ids = new Set(server.requestsTo("/api/mutate").map((r) => (r.body as { id: string }).id));
    expect(ids.size).toBe(1);
  });

  it("再送しても駄目なら、まとまりと後ろに並ぶ送信中の操作をすべて捨て save-failed(network) が届く", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const { replica, queue, failed } = setup(server);
    const task = seedTask(server, replica);
    server.fail("/api/mutate", "network", "network", "network");
    const batch1 = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "1" } }],
    });
    const batch2 = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "2" } }],
    });
    replica.addPending([batch1, batch2]);
    queue.kick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);
    await queue.idle();

    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toEqual({ kind: "network" });
    expect(replica.pending).toHaveLength(0);
    // 表示は「1」も付いていない元の状態に戻る
    expect(replica.task(task.id)?.title).toBe(task.title);
    // 後ろに並んでいた batch2 は、実際には送られていない
    const ids = new Set(server.requestsTo("/api/mutate").map((r) => (r.body as { id: string }).id));
    expect(ids).toEqual(new Set([batch1.id]));
  });

  it("追加が失敗したときは、捨てたまとまりの mutations に title・memo が入っている", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const { replica, queue, failed } = setup(server);
    server.fail("/api/mutate", "network", "network", "network");
    replica.addPending([
      makeBatch({
        kind: "task.add",
        mutations: [
          {
            type: "task.create",
            task: {
              id: makeTask().id,
              title: "新しいタスク",
              memo: "メモ",
              bucket: "today",
              rank: "a0",
            },
          },
        ],
      }),
    ]);
    queue.kick();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(2000);
    await queue.idle();

    expect(failed).toHaveLength(1);
    // onFailed の discarded は PendingBatch[]。ここから作成の中身が読み取れることを確かめる
    // （画面側の FailedCreate への変換は notices.ts の describeDiscarded が担当）
    const batches = failed[0]?.discarded as {
      mutations: { type: string; task?: { title: string; memo: string } }[];
    }[];
    const createMutation = batches
      .flatMap((b) => b.mutations)
      .find((m) => m.type === "task.create");
    expect(createMutation?.task?.title).toBe("新しいタスク");
    expect(createMutation?.task?.memo).toBe("メモ");
  });

  it("400 は再送せずに捨てて save-failed(rejected) になる", async () => {
    const server = new FakeServer();
    const { replica, queue, failed } = setup(server);
    const task = seedTask(server, replica);
    server.fail("/api/mutate", 400);
    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }] }),
    ]);
    queue.kick();
    await queue.idle();

    expect(server.requestsTo("/api/mutate")).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.error).toMatchObject({ kind: "rejected", status: 400 });
  });
});

describe("送信の列：大きさ", () => {
  it("500 を超える操作は 500 ずつのまとまりに分かれて送られる（例：501 件の追加）", async () => {
    const server = new FakeServer();
    const { replica, queue, confirmed } = setup(server);
    const tasks = Array.from({ length: 501 }, () => makeTask({ bucket: "today" }));

    // AppStore.#perform と同じ分割ロジック（500 まで）を直接まねて積む
    const chunkSize = 500;
    // task.create は taskCreateSchema の項目だけを strictObject で受ける
    const mutations = tasks.map((t) => ({
      type: "task.create" as const,
      task: { id: t.id, title: t.title, bucket: t.bucket, rank: t.rank },
    }));
    const batches = [];
    for (let i = 0; i < mutations.length; i += chunkSize) {
      batches.push(makeBatch({ kind: "task.add", mutations: mutations.slice(i, i + chunkSize) }));
    }
    expect(batches).toHaveLength(2);
    replica.addPending(batches);
    queue.kick();
    await queue.idle();

    expect(confirmed).toHaveLength(2);
    const requests = server.requestsTo("/api/mutate");
    expect(requests).toHaveLength(2);
    expect((requests[0]?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(
      500,
    );
    expect((requests[1]?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(1);
  });
});
