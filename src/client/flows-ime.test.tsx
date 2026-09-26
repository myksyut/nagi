import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 完了の条件3：日本語入力で変換を確定する Enter では追加されない。
 * 変換中のキーは isComposing か keyCode 229 で見分ける（Safari 対策）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("追加欄の日本語入力", () => {
  it("変換を確定する Enter（isComposing・keyCode 229）では追加しない。ふつうの Enter では追加する", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "にほんご");

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(store.lists.today).toHaveLength(0);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(store.lists.today).toHaveLength(0);
    // 追加欄はまだ開いている
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(store.lists.today).toHaveLength(1);
    expect(store.lists.today[0]?.title).toBe("にほんご");
  });

  it("変換中の Esc では追加欄が閉じない", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "へんかんちゅう");

    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toBeInTheDocument();

    // 状態の変化（MobX の反応）が描き直しに反映されるのを待つ
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
    });
    expect(screen.queryByRole("textbox", { name: "今日に追加" })).toBeNull();
  });
});

describe("入力欄の中では1文字のショートカットが効かない", () => {
  it("x・t・n などは文字として入るだけで、操作にならない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "xtn実行しない");
    expect(input).toHaveValue("xtn実行しない");
    // 誰も完了・振り分けされていない
    expect(store.lists.completedTodayCount).toBe(0);
    expect(store.lists.today.map((t) => t.title)).toEqual(["A"]);
  });

  it("開いたタスクのタイトル欄でも同じ：変換中の Enter・Esc では閉じない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j{Enter}"); // 選んで開く
    const title = screen.getByRole("textbox", { name: "タイトル" });

    fireEvent.keyDown(title, { key: "Enter", isComposing: true });
    expect(screen.getByRole("textbox", { name: "タイトル" })).toBeInTheDocument();
    fireEvent.keyDown(title, { key: "Escape", keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "タイトル" })).toBeInTheDocument();
  });

  it("入力欄の中の ⌘Z はアプリの元に戻すにならない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j");
    await user.keyboard("x"); // 完了させて、元に戻す操作を1つ作っておく
    expect(store.canUndo).toBe(true);

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.click(input);
    await user.keyboard("{Meta>}z{/Meta}");
    // 入力欄の中の ⌘Z はブラウザの取り消しに任せるだけで、アプリの undo は動かない
    expect(store.canUndo).toBe(true);
    expect(store.lists.completedTodayCount).toBe(1);
  });
});
