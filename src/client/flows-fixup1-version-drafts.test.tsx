import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { RELOAD_DELAY_MS } from "./shell/status-bar";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 8-修正1 の 3・4・8：
 * - 3：409 のあと自動で読み込み直すまでは、タスクを開き直せず、追加欄も開けない（打った文字を失わない）
 * - 4：下書きを localStorage に残せないとき・sessionStorage を使えないときは、自動では読み込み直さず、ボタンにする
 * - 8：オフラインの帯は、操作を止めたときだけ強調する（タイトルの自動保存では強調しない）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function openToday(server: FakeServer) {
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => store.sync());
  await screen.findByRole("listbox", { name: "今日" });
  return store;
}

async function versionMismatch(server: FakeServer, store: AppStore) {
  server.fail("/api/sync", 409);
  await act(async () => store.sync());
}

describe("3：409 のあと、読み込み直すまで編集を受け付けない", () => {
  it("閉じたあとに開き直そうとしても開かず、n でも追加欄は開かない。そのあと読み込み直す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "元のタイトル", bucket: "today" }));
    const store = await openToday(server);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});

    await user.keyboard("j{Enter}");
    expect(screen.getByRole("textbox", { name: "タイトル" })).toBeInTheDocument();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await versionMismatch(server, store);
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();

    // 開き直して打とうとしても、開かない
    fireEvent.keyDown(window, { key: "Enter" });
    fireEvent.click(screen.getByText("元のタイトル"));
    fireEvent.keyDown(window, { key: "n" });
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "今日に追加" })).toBeNull();
    expect(reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("4：ストレージを使えないときは、自動では読み込み直さない", () => {
  it("下書きを localStorage に書けなければ、読み込み直さずにボタンを出し、開き直すと打った文字が欄に残っている", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "元のタイトル", bucket: "today" }));
    const store = await openToday(server);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    await user.keyboard("j{Enter}");
    fireEvent.change(screen.getByRole("textbox", { name: "タイトル" }), {
      target: { value: "打ちかけのタイトル" },
    });
    // 容量切れなどで、localStorage に書けない
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await versionMismatch(server, store);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS * 2);
    });
    vi.useRealTimers();

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(/下書きを残せないため/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
    expect(localStorage.getItem(`nagi:draft:unsaved:${task.id}:title`)).toBeNull();

    // 開き直すと、打った文字が欄に残っている（書き写してから読み込み直せる）
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "タイトル" })).toHaveValue("打ちかけのタイトル");
  });

  it("sessionStorage を読めなければ（繰り返しを防げないので）、自動では読み込み直さずにボタンを出す", async () => {
    const server = new FakeServer();
    const store = await openToday(server);
    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    vi.spyOn(sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await versionMismatch(server, store);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS * 2);
    });

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "再読み込み" })).toBeInTheDocument();
  });
});

describe("8：帯の強調は、操作を止めたときだけ", () => {
  it("オフラインでタイトルを打っても（自動保存が止まっても）強調せず、x では強調する", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "元のタイトル", bucket: "today" }));
    await openToday(server);

    await user.keyboard("j{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    const bar = screen.getByText("オフライン — つながるまで保存できません");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.change(title, { target: { value: "オフラインで打つ" } });
    await act(async () => {
      // 自動保存（500ms）が走り、オフラインで止められる
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(bar).not.toHaveAttribute("data-emphasized");
    vi.useRealTimers();

    // タイトル欄を閉じて、x（完了）を押す
    fireEvent.keyDown(title, { key: "Escape" });
    fireEvent.keyDown(window, { key: "x" });
    expect(bar).toHaveAttribute("data-emphasized");
  });
});
