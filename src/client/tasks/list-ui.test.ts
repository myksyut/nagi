import { runInAction } from "mobx";
import { afterEach, describe, expect, it } from "vitest";
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
