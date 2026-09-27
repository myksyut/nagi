import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { FakeServer } from "@/test/fake-server";
import { DraftStorage } from "./draft-storage";
import { ListUi } from "./list-ui";

/**
 * 8-修正1 の 5：タブが2つあっても、追加欄の下書きと、戻ってきた追加の残りを、古い中身で上書きしない。
 * あわせて 3：開いている入力欄の、まだ送っていない文字を、同期で下書きへ書ける（persistEditing）
 */

const stores: AppStore[] = [];
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const store of stores.splice(0)) store.dispose();
});

async function makeStore() {
  const store = new AppStore({
    fetch: new FakeServer().fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  return store;
}

/** 同じ localStorage を使う2つのタブ（それぞれのストアと ListUi） */
async function twoTabs() {
  const a = new ListUi(await makeStore(), { drafts: new DraftStorage(localStorage) });
  const b = new ListUi(await makeStore(), { drafts: new DraftStorage(localStorage) });
  disposers.push(a.start(), b.start());
  return { a, b };
}

/** ほかのタブが localStorage を書いたときの知らせ（同じページの中では届かないので、自分で送る） */
function notifyOtherTabs(key: string) {
  window.dispatchEvent(
    new StorageEvent("storage", {
      key,
      newValue: localStorage.getItem(key),
      storageArea: localStorage,
    }),
  );
}

describe("5：2つのタブが同じ下書きを使う", () => {
  it("先に開いていたタブが失敗した追加を戻しても、ほかのタブが戻した残りを消さない", async () => {
    const { a, b } = await twoTabs();
    a.setAddDraft("A で打っている途中");
    a.restoreDrafts(["A で保存できなかった"]);
    expect(JSON.parse(localStorage.getItem("nagi:draft:add-queue") ?? "[]")).toEqual([
      "A で保存できなかった",
    ]);

    // B はまだ A の変更を知らない（知らせが届く前）
    b.setAddDraft("B で打っている途中");
    b.restoreDrafts(["B で保存できなかった"]);
    expect(JSON.parse(localStorage.getItem("nagi:draft:add-queue") ?? "[]")).toEqual([
      "A で保存できなかった",
      "B で保存できなかった",
    ]);
  });

  it("ほかのタブが下書きを変えたら追いかける。追加し終えたときに、ほかのタブが書いた下書きを消さない", async () => {
    const { a, b } = await twoTabs();
    a.setAddDraft("A の下書き");
    notifyOtherTabs("nagi:draft:add");
    expect(b.addDraft).toBe("A の下書き");

    // B が続きを打って追加する。そのあいだ（知らせが届く前）に A が別の下書きを書いた
    b.setAddDraft("B で追加する文字");
    a.setAddDraft("A の新しい下書き");
    b.noteAdded("0199a000-0000-7000-8000-000000000001");
    expect(localStorage.getItem("nagi:draft:add")).toBe("A の新しい下書き");
    expect(b.addDraft).toBe("A の新しい下書き");
  });

  it("戻ってきた追加の残りは、ほかのタブが取ったものを取り直さない", async () => {
    const { a, b } = await twoTabs();
    a.setAddDraft("A の下書き");
    a.restoreDrafts(["一つ目", "二つ目"]);
    notifyOtherTabs("nagi:draft:add-queue");
    expect(b.draftCount).toBe(2);

    // A が追加し終えて、残りの一つ目を下書きに取った。B は知らせが届く前に追加し終えた
    a.noteAdded("0199a000-0000-7000-8000-000000000002");
    expect(a.addDraft).toBe("一つ目");
    b.noteAdded("0199a000-0000-7000-8000-000000000003");
    // B は A が取った一つ目を（下書きはタブのあいだで1つなので）そのまま受け取り、二つ目を取り直さない
    expect(b.addDraft).toBe("一つ目");
    expect(JSON.parse(localStorage.getItem("nagi:draft:add-queue") ?? "[]")).toEqual(["二つ目"]);
  });
});

describe("3：開いている入力欄の、まだ送っていない文字を同期で下書きへ書く", () => {
  it("persistEditing で、追いかけている欄の文字を localStorage へ書き、残せたら true", async () => {
    const ui = new ListUi(await makeStore(), { drafts: new DraftStorage(localStorage) });
    let typed: string | undefined = "打ちかけ";
    const stop = ui.trackEditing("task-1", "title", () => typed);
    expect(ui.persistEditing()).toBe(true);
    expect(localStorage.getItem("nagi:draft:unsaved:task-1:title")).toBe("打ちかけ");
    expect(ui.unsavedText("task-1", "title")).toBe("打ちかけ");

    // 送り済み（undefined）なら書かない。やめたら追いかけない
    typed = undefined;
    stop();
    localStorage.clear();
    ui.persistEditing();
    expect(localStorage.getItem("nagi:draft:unsaved:task-1:title")).toBeNull();
  });

  it("localStorage に書けなければ false", async () => {
    const broken = {
      length: 0,
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
    } satisfies Storage;
    const ui = new ListUi(await makeStore(), { drafts: new DraftStorage(broken) });
    ui.trackEditing("task-1", "memo", () => "書けないメモ");
    const error = console.error;
    console.error = () => {};
    try {
      expect(ui.persistEditing()).toBe(false);
    } finally {
      console.error = error;
    }
  });
});
