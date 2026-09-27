import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";
import { EMPHASIS_MS, RELOAD_DELAY_MS } from "./status-bar";

/**
 * チケット8：オフラインの帯（強調・つながると消える）、追加欄のオフラインの下書き、
 * 新しいバージョンの帯（下書きを残してから再読み込み・60秒以内の2回目はボタン）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const OFFLINE_TEXT = "オフライン — つながるまで保存できません";

describe("オフラインの帯", () => {
  it("オフラインのあいだだけ帯が出て、つながると消える", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });
    expect(screen.queryByText(OFFLINE_TEXT)).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(screen.getByText(OFFLINE_TEXT)).toHaveAttribute("role", "status");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.queryByText(OFFLINE_TEXT)).toBeNull();
  });

  it("オフラインで操作を止めたら帯を強調し、EMPHASIS_MS たつと外れる（続けて止めると延びる）", async () => {
    const user = userEvent.setup({ delay: null });
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    const bar = screen.getByText(OFFLINE_TEXT);
    expect(bar).not.toHaveAttribute("data-emphasized");

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(input, { target: { value: "オフラインで追加" } });
      fireEvent.keyDown(input, { key: "Enter" });
      // オフラインなので追加されない
      expect(store.lists.today).toHaveLength(0);
      expect(bar).toHaveAttribute("data-emphasized");

      // 途中でもう一度止められたら、そこから数え直す
      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMPHASIS_MS - 100);
      });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(bar).toHaveAttribute("data-emphasized");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(EMPHASIS_MS - 100);
      });
      expect(bar).toHaveAttribute("data-emphasized");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(bar).not.toHaveAttribute("data-emphasized");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("追加欄：オフラインのあいだの下書き", () => {
  it("オフラインの説明を出し、Enter では追加しない。閉じても下書きは残り、localStorage にも残る", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    expect(
      screen.getByText("オフラインのため、今は追加できません。入力は下書きとして残ります"),
    ).toBeInTheDocument();

    await user.type(input, "書いている途中");
    await user.keyboard("{Enter}");
    expect(store.lists.today).toHaveLength(0);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "今日に追加" })).toBeNull();
    expect(localStorage.getItem("nagi:draft:add")).toBe("書いている途中");

    // つながっても、下書きは自動では送らない
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(async () => {
      await store.idle();
    });
    expect(store.lists.today).toHaveLength(0);

    // ListUi／アプリを作り直しても（再読み込みの代わり）、下書きは localStorage から戻る
    store.dispose();
    stores.splice(stores.indexOf(store), 1);
    cleanup();
    const server2 = new FakeServer();
    const { store: store2 } = await setupApp("/today", server2, { preload: false });
    stores.push(store2);
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("n");
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toHaveValue("書いている途中");
  });
});

describe("新しいバージョンの帯", () => {
  async function triggerVersionMismatch(server: FakeServer, store: AppStore) {
    server.fail("/api/sync", 409);
    await act(async () => {
      await store.sync();
    });
  }

  it("開いていたタスクのタイトルの打ちかけを下書きに残し、閉じてから RELOAD_DELAY_MS 後に再読み込みする", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "元のタイトル", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    // 500ms の自動保存がまだ送られていない、打ちかけの状態にする
    fireEvent.change(title, { target: { value: "打ちかけのタイトル" } });

    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await act(async () => {
        await triggerVersionMismatch(server, store);
      });
      expect(
        screen.getByText("新しいバージョンがあります — 読み込み直しています"),
      ).toBeInTheDocument();
      // 開いていたタスクは閉じられる
      expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
      expect(localStorage.getItem(`nagi:draft:unsaved:${task.id}:title`)).toBe(
        "打ちかけのタイトル",
      );

      expect(reload).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(RELOAD_DELAY_MS);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("60秒以内に続けて新しい版になったら自動では読み込まず、ボタンを出す", async () => {
    sessionStorage.setItem("nagi:version-reload-at", String(Date.now()));
    const server = new FakeServer();
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const reload = vi.spyOn(window.location, "reload").mockImplementation(() => {});
    await act(async () => {
      await triggerVersionMismatch(server, store);
    });
    expect(screen.getByText("新しいバージョンがあります")).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    const button = screen.getByRole("button", { name: "再読み込み" });
    await act(async () => {
      button.click();
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
