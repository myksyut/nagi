import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 8-修正1 の 2：後から読み込む部品が読み込めなかったとき、開いたままでも「読み込めませんでした・もう一度」から
 * 読み直せる。閉じて開き直したとき、つながり直したとき（online）も読み直す。
 * 最初の import だけを失敗させる（先読みはしない）
 */

const failures = vi.hoisted(() => {
  (globalThis as { NAGI_NO_PRELOAD?: boolean }).NAGI_NO_PRELOAD = true;
  return { palette: 1, date: 2 };
});

vi.mock("./features/command-palette/command-palette", async (importOriginal) => {
  if (failures.palette > 0) {
    failures.palette--;
    throw new Error("読み込めない");
  }
  return importOriginal();
});
vi.mock("./features/dates/date-entry-panel", async (importOriginal) => {
  if (failures.date > 0) {
    failures.date--;
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
  // 起動のあとの空いた時間の先読みを止める（読み込みの回数と順番を、テストの操作だけで決めるため）
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
});
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

async function open(server = new FakeServer()) {
  const { store } = await setupApp("/inbox", server, { preload: false });
  stores.push(store);
  await act(async () => store.sync());
  await screen.findByRole("listbox", { name: "受信箱" });
  return store;
}

describe("読み込めなかったとき", () => {
  it("⌘K：「もう一度」で読み直し、打った文字のまま開く。失敗のあいだも Esc で閉じられる", async () => {
    const user = userEvent.setup();
    await open();

    await user.keyboard("{Meta>}k{/Meta}");
    const retry = await screen.findByRole("button", { name: "もう一度" });
    expect(screen.getByText(/読み込めませんでした/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "検索とコマンド" }), "今日");

    await user.click(retry);
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    expect(input).toHaveValue("今日");
  });

  it("日付の入力：失敗のあいだに Esc で閉じ、開き直すと読み直す。つながり直したときも読み直す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱のタスク", bucket: "inbox" }));
    await open(server);

    await user.keyboard("jd");
    await screen.findByRole("button", { name: "もう一度" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();

    // 開き直すと読み直す（2回目も失敗する設定）
    await user.keyboard("d");
    await screen.findByRole("button", { name: "もう一度" });
    expect(failures.date).toBe(0);

    // つながり直したら読み直す（3回目で届く）
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    // 本物の日付の入力（カレンダーを含む）を初めて読み込むので、少し長めに待つ
    await waitFor(() => expect(document.querySelector('[data-slot="waiting-input"]')).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toBeInTheDocument();
  });
});
