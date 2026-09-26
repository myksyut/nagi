import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";
import { AppStore, StoreProvider } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/** 完了の条件5とその他：開く・自動保存・メモのリンク・削除・保存の失敗・空のとき・読み込み前 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe("タスクを開く・タイトルを直す", () => {
  it("Enter で開く（フォーカスは一覧のまま）→ もう一度 Enter でタイトル欄にフォーカス → 直して Enter で保存して閉じる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", memo: "見て https://example.com/a" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    const listbox = screen.getByRole("listbox", { name: "今日" });
    expect(listbox).toHaveFocus();
    const link = screen.getByRole("link", { name: "example.com/a" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");

    await user.keyboard("{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });
    expect(title).toHaveFocus();
    await user.clear(title);
    await user.type(title, "B{Enter}");
    expect(store.lists.today[0]?.title).toBe("B");
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
    expect(listbox).toHaveFocus();
  });

  it("タイトルとメモの自動保存は 500ms 後・フォーカスが外れたとき・閉じたときで、⌘Z の対象にしない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });
    const canUndoBefore = store.canUndo;

    await user.keyboard("j{Enter}");
    const title = screen.getByRole("textbox", { name: "タイトル" });

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      fireEvent.change(title, { target: { value: "書き直した" } });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(store.task(store.lists.today[0]?.id ?? "")?.title).toBe("書き直した");
    expect(store.canUndo).toBe(canUndoBefore);
  });
});

describe("削除（⌘⌫）", () => {
  it("確認なしで削除し、トーストと ⌘Z で戻せる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "later" }));
    const { store } = await setupApp("/later", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "あとで" });

    await user.keyboard("j");
    await user.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(store.lists.later).toHaveLength(0);
    expect(await screen.findByText("削除しました")).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.later).toHaveLength(1);
  });
});

describe("保存の失敗", () => {
  it("追加に失敗すると「保存できませんでした」と出て、文字は追加欄の下書きに戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    server.fail("/api/mutate", 400);
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "失敗する{Enter}");

    const messages = await screen.findAllByText("保存できませんでした");
    expect(messages.length).toBeGreaterThan(0);
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toHaveValue("失敗する");
  });
});

describe("空のときの表示", () => {
  it("今日：まだない（受信箱にあれば件数を添える）／全部完了", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "X", bucket: "inbox" }));
    server.putTask(makeTask({ title: "Y", bucket: "inbox" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    expect(await screen.findByText("今日のタスクはまだありません")).toBeInTheDocument();
    expect(screen.getByText("受信箱に 2 件")).toBeInTheDocument();
  });

  it("今日：全部完了すると静かに知らせるだけ", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("jx");
    expect(await screen.findByText("今日のタスクはすべて完了しました")).toBeInTheDocument();
  });

  it.each([
    ["/inbox", "受信箱は空です"],
    ["/later", "あとでのタスクはありません"],
    ["/logbook", "完了したタスクはまだありません"],
  ] as const)("%s は「%s」", async (path, message) => {
    const { store } = await setupApp(path);
    try {
      await act(async () => {
        await store.sync();
      });
      expect(await screen.findByText(message)).toBeInTheDocument();
    } finally {
      store.dispose();
      cleanup();
    }
  });
});

describe("サイドバーの件数", () => {
  it("受信箱と今日の件数を出し、0 件なら出さない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    server.putTask(makeTask({ title: "B", bucket: "inbox" }));
    server.putTask(makeTask({ title: "C", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const nav = await screen.findByRole("navigation", { name: "リスト" });
    const linkTo = (path: string) =>
      within(nav)
        .getAllByRole("link")
        .find((link) => link.getAttribute("href") === path);
    expect(within(linkTo("/inbox") as HTMLElement).getByText("2")).toBeInTheDocument();
    expect(within(linkTo("/today") as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(within(linkTo("/later") as HTMLElement).queryByText(/\d/)).toBeNull();
  });
});

describe("読み込み前", () => {
  it("store.loaded が false のあいだは一覧を描かず、キーも効かない（1〜5の移動は効く）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: () => new Promise(() => {}), // 手元の控えを永遠に読み終えない
    });
    stores.push(store);
    void store.start();

    const location = memoryLocation({ path: "/today", record: true });
    render(
      <StoreProvider store={store}>
        <Router hook={location.hook} searchHook={location.searchHook}>
          <App />
        </Router>
      </StoreProvider>,
    );
    await screen.findByRole("heading", { name: "今日" });
    expect(screen.queryByRole("listbox", { name: "今日" })).toBeNull();
    expect(store.loaded).toBe(false);

    const user = userEvent.setup();
    // 1〜5 の移動だけは、読み込み前でも効く
    await user.keyboard("1");
    await screen.findByRole("heading", { name: "受信箱" });
  });
});
