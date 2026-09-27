import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット17：ショートカットのページの部品は後から読み込む（features/shortcuts/lazy.tsx）。
 * 先読みの前に `?` で開いたときは、見出し（戻り方の一行を含む）だけ先に出て、Esc と `?` で前の画面に戻れる。
 * 届いたら絞り込みの欄と一覧が出て、欄にフォーカスが入る。読み込めなかったときは「もう一度」から読み直せる。
 * import を止めておける門（gate）を挟み、先読みはしない
 */

const control = vi.hoisted(() => {
  (globalThis as { NAGI_NO_PRELOAD?: boolean }).NAGI_NO_PRELOAD = true;
  let open = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { gate, open: () => open(), failures: 0 };
});

vi.mock("./features/shortcuts/shortcuts-screen", async (importOriginal) => {
  await control.gate;
  if (control.failures > 0) {
    control.failures--;
    throw new Error("読み込めない");
  }
  return importOriginal();
});

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // 起動のあとの空いた時間の先読みを止める
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("読み込む前に開いたとき", () => {
  it("見出しが先に出て、Esc と `?` で戻れる。読み込めなければ「もう一度」から読み直せ、届くと絞り込みの欄にフォーカスが入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store, location } = await setupApp("/inbox", server, { preload: false });
    stores.push(store);
    await act(async () => store.sync());
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("?");
    expect(await screen.findByRole("heading", { name: "ショートカット" })).toBeInTheDocument();
    expect(screen.getByText("Esc か ? で前の画面に戻る")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "ショートカットを絞り込む" })).toBeNull();
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("?");
    await screen.findByRole("heading", { name: "ショートカット" });
    await user.keyboard("?");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(location.history).toEqual(["/inbox", "/inbox", "/inbox"]);

    // 開いたまま、読み込みが失敗する
    await user.keyboard("?");
    await screen.findByRole("heading", { name: "ショートカット" });
    control.failures = 1;
    await act(async () => control.open());
    const retry = await screen.findByRole("button", { name: "もう一度" });
    expect(screen.getByText(/ショートカットを読み込めませんでした/)).toBeInTheDocument();

    await user.click(retry);
    const filter = await screen.findByRole("textbox", { name: "ショートカットを絞り込む" });
    await waitFor(() => expect(filter).toHaveFocus());
    expect(screen.getByRole("region", { name: "タスク" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(location.history?.at(-1)).toBe("/inbox");
    // ページを開くと、先読みしていない部品（ビューや ⌘K など）をその場でまとめて読み込むので、時間に余裕を持たせる
  }, 30_000);
});
