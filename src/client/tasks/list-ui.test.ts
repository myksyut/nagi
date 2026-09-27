import { runInAction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import type { ListView } from "./list-ui";
import { ListUi } from "./list-ui";

const stores: AppStore[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function makeStore(server = new FakeServer()) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  await store.sync();
  return store;
}

function todayView(store: AppStore): ListView {
  return {
    key: "today",
    kind: "today",
    sections: () => [
      { key: "open", rows: store.lists.today },
      {
        key: "completed",
        rows: store.lists.completedToday,
        fold: { label: `完了 ${store.lists.completedTodayCount}件` },
      },
    ],
    addTo: { bucket: "today", label: "今日に追加" },
    addInSection: "open",
  };
}

/** ボードのように列（column）を付けた一覧。ListUi の列の振る舞い（12）を、画面なしで確かめる */
function boardView(store: AppStore): ListView {
  return {
    key: "board",
    kind: "today",
    sections: () => [
      { key: "notStarted", column: "notStarted", rows: store.lists.todayBoard.notStarted },
      { key: "inProgress", column: "inProgress", rows: store.lists.todayBoard.inProgress },
      { key: "completed", column: "completed", rows: store.lists.todayBoard.completed },
    ],
    addTo: { bucket: "today", label: "今日に追加" },
  };
}

function inboxView(store: AppStore): ListView {
  return {
    key: "inbox",
    kind: "inbox",
    sections: () => [{ key: "open", rows: store.lists.inbox }],
    addTo: { bucket: "inbox", label: "受信箱に追加" },
    addInSection: "open",
  };
}

function makeUi(store: AppStore): ListUi {
  const ui = new ListUi(store);
  disposers.push(ui.start());
  return ui;
}

describe("ListUi.neighborAfter", () => {
  it("閉じたまとまりの中と外をまたがない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "C",
        bucket: "today",
        rank: "a2",
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    const view = todayView(store);
    ui.setView(view);
    ui.toggleFold("completed"); // 開く

    const [a, b] = store.lists.today;
    // rows は [A, B, C]（C は完了済みでまとまりの中）。B を抜くと、C ではなく A へ
    expect(ui.neighborAfter([b?.id ?? ""])).toBe(a?.id ?? null);
  });

  it("行が消えたら同じ位置の行を選ぶ", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a2" }));
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(todayView(store));

    const [, b] = store.lists.today;
    ui.select(b?.id ?? null);
    runInAction(() => {
      store.actions.deleteTasks([b?.id ?? ""]);
    });
    // B（2番目）が消えたので、今2番目にいる行（元の C）が選ばれる
    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "C"]);
    expect(ui.selectedId).toBe(store.lists.today[1]?.id);
  });
});

describe("ListUi：列（column）のある一覧（12：ボード）", () => {
  it("moveColumn：←→ は行のある隣の列へ移り、前の列と同じ位置（少なければ一番下）を選ぶ", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a2" }));
    server.putTask(
      makeTask({
        title: "D",
        bucket: "today",
        rank: "a3",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "E",
        bucket: "today",
        rank: "a4",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    // 未着手（A,B,C）の3番目（C。0始まりの index 2）から、→ で進行中（D,E）へ：
    // 2件あるので同じ位置（index 2 は超えるので一番下＝E）
    const [a, b, c, , e] = store.lists.today;
    ui.select(c?.id ?? null);
    ui.moveColumn(1);
    expect(ui.selectedId).toBe(e?.id);

    // ← で未着手へ戻ると、進行中で今いた位置（E。index 1）と同じ位置（B）を選ぶ
    ui.moveColumn(-1);
    expect(ui.selectedId).toBe(b?.id);

    // 何も選んでいなければ、→ で行のある一番左の列（未着手）の一番上
    ui.select(null);
    ui.moveColumn(1);
    expect(ui.selectedId).toBe(a?.id);
  });

  it("moveColumn：行のない列は飛ばす", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "D",
        bucket: "today",
        rank: "a1",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    // 未着手（A）から → すると、進行中には行がないので完了（D）へ飛ぶ
    const [a] = store.lists.today;
    const d = store.lists.completedToday[0];
    expect(d).toBeDefined();
    ui.select(a?.id ?? null);
    ui.moveColumn(1);
    expect(ui.selectedId).toBe(d?.id);

    // 逆方向も同じく飛ぶ
    ui.moveColumn(-1);
    expect(ui.selectedId).toBe(a?.id);
  });

  it("moveColumn：列のない一覧では何もしない", async () => {
    const store = await makeStore();
    const ui = makeUi(store);
    ui.setView(todayView(store));
    expect(ui.columns).toEqual([]);
    ui.moveColumn(1);
    expect(ui.selectedId).toBeNull();
  });

  it("moveSelection（↑↓）は同じ列の中だけを動き、列の端で止まる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "C",
        bucket: "today",
        rank: "a2",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    const [a, b] = store.lists.today;
    ui.select(a?.id ?? null);
    ui.moveSelection(1);
    expect(ui.selectedId).toBe(b?.id);
    // 未着手の列の一番下（B）で、さらに ↓ しても C（進行中の列）へは移らない
    ui.moveSelection(1);
    expect(ui.selectedId).toBe(b?.id);
    ui.moveSelection(-1);
    expect(ui.selectedId).toBe(a?.id);
    // 一番上で ↑ しても止まる
    ui.moveSelection(-1);
    expect(ui.selectedId).toBe(a?.id);
  });

  it("extendSelection（⇧↑↓）も同じ列の中だけで選択を広げる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "C",
        bucket: "today",
        rank: "a2",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    const [a, b] = store.lists.today;
    ui.select(a?.id ?? null);
    ui.extendSelection(1);
    expect([...ui.selectedIds].sort()).toEqual([a?.id, b?.id].sort());
    // さらに広げても、進行中の列（C）へはまたがない
    ui.extendSelection(1);
    expect([...ui.selectedIds].sort()).toEqual([a?.id, b?.id].sort());
  });

  it("選んだカードが列だけを移ると（上から並べた行の順は同じ）、そのあと消えても、移った先の列の同じ位置を選ぶ（12-修正1）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "B",
        bucket: "today",
        rank: "a1",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    const [a, b] = store.lists.today;
    ui.select(a?.id ?? null);
    // s と同じ：A を進行中にする。行の順は [A, B] のままで、A だけが未着手から進行中の列へ移る
    store.actions.startTasks([a?.id ?? ""]);
    expect(ui.rows.map((row) => row.id)).toEqual([a?.id, b?.id]);
    expect(ui.columnOf(a?.id ?? "")).toBe("inProgress");

    // ほかの画面の変更などで A が消えると、A がいた進行中の列の同じ位置（B）を選ぶ
    store.actions.deleteTasks([a?.id ?? ""]);
    expect(ui.selectedId).toBe(b?.id);
  });

  it("neighborAfter は列をまたがない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "B",
        bucket: "today",
        rank: "a1",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const store = await makeStore(server);
    const ui = makeUi(store);
    ui.setView(boardView(store));

    const [a] = store.lists.today;
    // A（未着手の列で唯一の行）を抜くと、進行中の列（B）へはまたがず null
    expect(ui.neighborAfter([a?.id ?? ""])).toBeNull();
  });
});

describe("ListUi：リストの切り替えと選択", () => {
  it("リストを切り替えて戻ると選択が戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "X", bucket: "inbox" }));
    const store = await makeStore(server);
    const ui = makeUi(store);

    ui.setView(todayView(store));
    const [, b] = store.lists.today;
    ui.select(b?.id ?? null);

    ui.setView(inboxView(store));
    expect(ui.selectedId).not.toBe(b?.id);

    ui.setView(todayView(store));
    expect(ui.selectedId).toBe(b?.id ?? null);
  });
});

describe("ListUi：追加欄の下書き", () => {
  it("戻ってきた下書きは順番に入る", async () => {
    const store = await makeStore();
    const ui = makeUi(store);
    ui.setView(todayView(store));
    ui.startAdding();
    expect(ui.addDraft).toBe("");

    ui.restoreDrafts(["一つ目", "二つ目"]);
    expect(ui.addDraft).toBe("一つ目");
    expect(ui.draftCount).toBe(1);

    ui.noteAdded("dummy-id");
    expect(ui.addDraft).toBe("二つ目");
    expect(ui.draftCount).toBe(0);
  });

  it("空でない下書きが残っているあいだは、戻ってきた分をキューに積むだけ", async () => {
    const store = await makeStore();
    const ui = makeUi(store);
    ui.setView(todayView(store));
    ui.startAdding();
    ui.setAddDraft("打っている途中");

    ui.restoreDrafts(["失敗した分"]);
    expect(ui.addDraft).toBe("打っている途中");
    expect(ui.draftCount).toBe(1);
  });
});
