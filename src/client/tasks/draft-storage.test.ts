import { afterEach, describe, expect, it } from "vitest";
import { DraftStorage } from "./draft-storage";

/**
 * 下書きの localStorage への保存（8）。追加欄の下書き・戻ってきた追加の残り・
 * 保存できなかったタイトルとメモが、キーを分けて残ることを確かめる
 */

afterEach(() => {
  localStorage.clear();
});

describe("追加欄の下書き（nagi:draft:add）", () => {
  it("保存して、別のインスタンスからも読める（再読み込み・作り直しの代わり）", () => {
    new DraftStorage().saveAddDraft("書いている途中");
    expect(new DraftStorage().loadAddDraft()).toBe("書いている途中");
  });

  it("空文字を保存するとキーが消え、読み込みは空文字に戻る", () => {
    const storage = new DraftStorage();
    storage.saveAddDraft("いったん");
    storage.saveAddDraft("");
    expect(localStorage.getItem("nagi:draft:add")).toBeNull();
    expect(new DraftStorage().loadAddDraft()).toBe("");
  });
});

describe("戻ってきた追加の残り（nagi:draft:add-queue）", () => {
  it("配列のまま残り、別のインスタンスからも順番どおり読める", () => {
    new DraftStorage().saveAddQueue(["一つ目", "二つ目"]);
    expect(new DraftStorage().loadAddQueue()).toEqual(["一つ目", "二つ目"]);
  });

  it("壊れた JSON や文字列以外が混じっていても、空の配列として読める（例外にしない）", () => {
    localStorage.setItem("nagi:draft:add-queue", "{ 壊れている");
    expect(new DraftStorage().loadAddQueue()).toEqual([]);

    localStorage.setItem("nagi:draft:add-queue", JSON.stringify(["ok", 1, null, "ok2"]));
    expect(new DraftStorage().loadAddQueue()).toEqual(["ok", "ok2"]);
  });

  it("空の配列を保存するとキーが消える", () => {
    const storage = new DraftStorage();
    storage.saveAddQueue(["残り"]);
    storage.saveAddQueue([]);
    expect(localStorage.getItem("nagi:draft:add-queue")).toBeNull();
  });
});

describe("保存できなかったタイトルとメモ（nagi:draft:unsaved:）", () => {
  it("タスクごと・項目ごとに別のキーで残り、別のインスタンスからも読める", () => {
    const storage = new DraftStorage();
    storage.saveUnsaved("task-1:title", "新しいタイトル");
    storage.saveUnsaved("task-1:memo", "メモの続き");
    storage.saveUnsaved("task-2:title", "別のタスクのタイトル");

    const loaded = new Map(new DraftStorage().loadUnsaved());
    expect(loaded.get("task-1:title")).toBe("新しいタイトル");
    expect(loaded.get("task-1:memo")).toBe("メモの続き");
    expect(loaded.get("task-2:title")).toBe("別のタスクのタイトル");
  });

  it("removeUnsaved で消すと、以後は読めない", () => {
    const storage = new DraftStorage();
    storage.saveUnsaved("task-1:title", "新しいタイトル");
    storage.removeUnsaved("task-1:title");
    expect(new DraftStorage().loadUnsaved()).toEqual([]);
  });

  it("ほかの用途の localStorage のキーには触らない", () => {
    localStorage.setItem("nagi:draft:add", "追加欄の下書き");
    localStorage.setItem("something-else", "無関係");
    new DraftStorage().saveUnsaved("task-1:title", "タイトル");
    expect(new DraftStorage().loadUnsaved()).toEqual([["task-1:title", "タイトル"]]);
  });
});

describe("localStorage が使えないとき（プライベートブラウズなど）", () => {
  it("例外を投げず、メモリの中だけでも動かない（既定値のまま）", () => {
    const broken: Storage = {
      length: 0,
      getItem: () => {
        throw new Error("使えない");
      },
      setItem: () => {
        throw new Error("使えない");
      },
      removeItem: () => {
        throw new Error("使えない");
      },
      clear: () => {},
      key: () => null,
    };
    const storage = new DraftStorage(broken);
    expect(() => storage.saveAddDraft("なにか")).not.toThrow();
    expect(storage.loadAddDraft()).toBe("");
    expect(storage.loadUnsaved()).toEqual([]);
  });

  it("storage が null（プライベートブラウズの容量切れなど）でも例外にしない", () => {
    const storage = new DraftStorage(null);
    expect(() => storage.saveAddDraft("なにか")).not.toThrow();
    expect(storage.loadAddDraft()).toBe("");
  });
});
