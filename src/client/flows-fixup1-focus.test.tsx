import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 4-修正1の3：キーボードのフォーカス位置は常に見える。
 * happy-dom は :focus-visible の見た目を測れないので、輪郭を出すクラスと属性の組み合わせで確かめる
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("一覧（listbox）の輪郭", () => {
  it("選ぶ前は aria-activedescendant がなく、選ぶ前の輪郭クラスが効く形。選ぶと activedescendant が付く", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const list = await screen.findByRole("listbox", { name: "今日" });

    // 選ぶ前の輪郭：選択されていないときにだけ効くクラスを持つ
    expect(list).toHaveClass("[&:focus-visible:not([aria-activedescendant])]:ring-2");
    expect(list).not.toHaveAttribute("aria-activedescendant");

    await user.keyboard("j");
    expect(list).toHaveAttribute("aria-activedescendant");
  });
});

describe("編集欄の輪郭", () => {
  it("タイトル欄は focus-visible の輪郭クラスを持つ", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    expect(title).toHaveClass("focus-visible:ring-1");
  });

  it("メモ欄は、表示の状態でも書く状態でも focus-visible の輪郭クラスを持つ", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", memo: "見て", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j{Enter}");
    const memoDisplay = screen.getByRole("button", { name: "メモを直す" });
    expect(memoDisplay).toHaveClass("focus-visible:ring-1");

    await user.click(memoDisplay);
    const memoField = screen.getByRole("textbox", { name: "メモ" });
    expect(memoField).toHaveClass("focus-visible:ring-1");
  });

  it("追加欄の枠は focus-within の輪郭クラスを持つ", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("n");
    const group = screen.getByRole("group", { name: "今日に追加" });
    expect(group).toHaveClass("focus-within:ring-1");
  });
});
