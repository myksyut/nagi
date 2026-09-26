import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 4-修正1の1・2：閉じたあとの保存の失敗で打った文字を失わない・
 * 送信中の古い版の失敗で新しい入力を上書きしない
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("1：閉じたあとの自動保存の失敗で、打った文字を失わない", () => {
  it("タイトル：閉じたあとに失敗 → 開き直すと欄に戻る → 閉じると保存し直す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "元", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    await user.clear(title);
    const release = server.hold("/api/mutate");
    await user.type(title, "新しい{Enter}");
    // Enter で保存を試みつつ閉じる（部品はアンマウントされる）
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();

    server.fail("/api/mutate", 400);
    release();
    await act(async () => {
      await store.idle();
    });
    // ストアは元の値に戻る
    expect(store.lists.today[0]?.title).toBe("元");
    expect(
      (await screen.findAllByText("直した文字は、そのタスクを開くと欄に戻ります")).length,
    ).toBeGreaterThan(0);

    // もう一度開くと、打った文字が欄に入っている
    await user.keyboard("j{Enter}");
    expect(screen.getByRole("textbox", { name: "タイトル" })).toHaveValue("新しい");

    // 閉じると保存し直す
    await user.keyboard("{Escape}");
    await act(async () => {
      await store.idle();
    });
    expect(store.lists.today[0]?.title).toBe("新しい");
  });

  it("メモ：閉じたあとに失敗しても、開き直すと表示にも欄にも戻った文字が見える", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", memo: "元メモ", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    await user.click(screen.getByRole("button", { name: "メモを直す" }));
    const memo = screen.getByRole("textbox", { name: "メモ" });
    const release = server.hold("/api/mutate");
    await user.clear(memo);
    await user.type(memo, "新しいメモ");
    // フォーカスを外して即保存を試みる（自動保存の onBlur 経路）
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "メモ" })).toBeNull();

    server.fail("/api/mutate", 400);
    release();
    await act(async () => {
      await store.idle();
    });
    expect(store.task(store.lists.today[0]?.id ?? "")?.memo).toBe("元メモ");

    // 開き直すと、表示の状態でも戻った文字が見える
    await user.keyboard("{Enter}");
    expect(screen.getByText("新しいメモ")).toBeInTheDocument();
  });

  it("オフラインのまま閉じたときも、開き直すと打った文字が残っている", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "元", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    await user.clear(title);
    await user.type(title, "オフラインで打った");

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(store.isOnline).toBe(false);

    await user.keyboard("{Escape}");
    expect(store.lists.today[0]?.title).toBe("元");

    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "タイトル" })).toHaveValue("オフラインで打った");
  });
});

describe("2：送信中の古い版の失敗で、新しい入力を上書きしない", () => {
  it("A を送信中に AB と打ち、A が失敗しても欄は AB のまま。500ms 後に AB が保存される", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "T", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j{Enter}{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });

    const release = server.hold("/api/mutate");
    fireEvent.change(title, { target: { value: "A" } });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });
    expect(server.requestsTo("/api/mutate")).toHaveLength(1);

    // A の送信中に、まだ送っていない AB を打つ
    fireEvent.change(title, { target: { value: "AB" } });
    server.fail("/api/mutate", 400);
    release();
    await act(async () => {
      await store.idle();
    });
    // A の失敗で欄が上書きされず、AB のまま残る
    expect(title).toHaveValue("AB");

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await store.idle();
    });
    expect(store.lists.today[0]?.title).toBe("AB");
  });

  it("あとに打っていなければ、失敗した文字がそのまま欄に残る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "T", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const user = userEvent.setup();
    await user.keyboard("j{Enter}{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });

    server.fail("/api/mutate", 400);
    fireEvent.change(title, { target: { value: "X" } });
    fireEvent.blur(title);
    await act(async () => {
      await store.idle();
    });
    expect(store.lists.today[0]?.title).toBe("T");
    expect(title).toHaveValue("X");
  });
});
