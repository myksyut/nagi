import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット9：右下の「＋」（n と同じ入口）と、空の表示に添える「＋ か N で追加」・完了の光の輪
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  // 完了の光の輪は document.body 直下に直接置かれる（React の外）ので、外れるタイマーを待たずに
  // 次のテストへ持ち越さない
  for (const ring of document.querySelectorAll("[data-complete-ring]")) ring.remove();
});

function addButton(): HTMLElement {
  return screen.getByRole("button", { name: "タスクを追加" });
}

describe("右下の「＋」", () => {
  it("aria-keyshortcuts=n を持ち、押すと n と同じ追加欄（今日に追加）を開いて Enter で今日に入る", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    const button = addButton();
    expect(button).toHaveAttribute("aria-keyshortcuts", "n");

    await user.click(button);
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "＋から追加{Enter}");
    expect(store.lists.today.map((t) => t.title)).toEqual(["＋から追加"]);
  });

  it("あとでで押すと「あとでに追加」が開く", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/later");
    stores.push(store);
    await screen.findByRole("listbox", { name: "あとで" });

    await user.click(addButton());
    const input = screen.getByRole("textbox", { name: "あとでに追加" });
    await user.type(input, "あとでのタスク{Enter}");
    expect(store.lists.later.map((t) => t.title)).toEqual(["あとでのタスク"]);
  });

  it("受信箱で押すと「受信箱に追加」が開く", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/inbox");
    stores.push(store);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.click(addButton());
    const input = screen.getByRole("textbox", { name: "受信箱に追加" });
    await user.type(input, "受信箱のタスク{Enter}");
    expect(store.lists.inbox.map((t) => t.title)).toEqual(["受信箱のタスク"]);
  });

  it("予定で押すと「受信箱に追加」が開く（n と同じ、予定への追加はない）", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/upcoming");
    stores.push(store);
    await screen.findByRole("heading", { name: "予定" });

    await user.click(addButton());
    expect(screen.getByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
  });

  it("完了ログで押すと「受信箱に追加」が開く（n と同じ）", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/logbook");
    stores.push(store);
    await screen.findByRole("heading", { name: "完了ログ" });

    await user.click(addButton());
    expect(screen.getByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
  });

  it("プロジェクトで押すと、そのプロジェクトの「あとで」に追加欄が開く", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "AIPR" });

    await user.click(addButton());
    const input = screen.getByRole("textbox", { name: "あとでに追加" });
    await user.type(input, "AIPR のタスク{Enter}");
    expect(store.lists.later.map((t) => t.title)).toEqual(["AIPR のタスク"]);
  });

  it("オフラインのときも追加欄は開くが、「オフラインのため」と出て Enter で追加されない", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    await user.click(addButton());
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    expect(
      screen.getByText("オフラインのため、今は追加できません。入力は下書きとして残ります"),
    ).toBeInTheDocument();

    await user.type(input, "オフラインで押した{Enter}");
    expect(store.lists.today).toHaveLength(0);
  });

  it("mousedown ではフォーカスを奪わない（開いている追加欄の入力にフォーカスが残る）", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    expect(input).toHaveFocus();

    // ＋ を mousedown しても、入力からフォーカスが奪われない
    await user.pointer({ target: addButton(), keys: "[MouseLeft>]" });
    expect(input).toHaveFocus();
    await user.pointer({ target: addButton(), keys: "[/MouseLeft]" });
  });

  it("マウスを乗せたときの「N」は Kbd（aria-hidden）で、キーマップの先頭のキーから作る", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    const button = addButton();
    // 手前の兄弟として、aria-hidden の Kbd（中身は N）が置かれている
    const kbd = button.parentElement?.querySelector("kbd");
    expect(kbd).not.toBeNull();
    expect(kbd).toHaveAttribute("aria-hidden", "true");
    expect(kbd?.textContent).toBe("N");
  });
});

describe("空の表示の「＋ か N で追加」", () => {
  const HINT = "＋ か N で追加";

  it("受信箱の空の表示に出る", async () => {
    const { store } = await setupApp("/inbox");
    stores.push(store);
    await screen.findByText("受信箱は空です");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("今日にまだ何もないときに出る", async () => {
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByText("今日のタスクはまだありません");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("予定の空の表示に出る", async () => {
    const { store } = await setupApp("/upcoming");
    stores.push(store);
    await screen.findByText("予定のタスクはありません");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("あとでの空の表示に出る", async () => {
    const { store } = await setupApp("/later");
    stores.push(store);
    await screen.findByText("あとでのタスクはありません");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("プロジェクトの空の表示に出る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByText("このプロジェクトのタスクはまだありません");
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("今日の「今日のタスクはすべて完了しました」には出さない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "済み", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("j");
    await user.keyboard("x");
    await screen.findByText("今日のタスクはすべて完了しました");
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("完了ログの「完了したタスクはまだありません」には出さない", async () => {
    const { store } = await setupApp("/logbook");
    stores.push(store);
    await screen.findByText("完了したタスクはまだありません");
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

function stubReducedMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

describe("完了の光の輪（実際の x・丸の操作から）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("x で完了にすると、丸の位置に輪が出る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
    await user.keyboard("j");
    await user.keyboard("x");
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(1);
  });

  it("reduced motion のときは出ない", async () => {
    stubReducedMotion(true);
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j");
    await user.keyboard("x");
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("完了を外すとき（もう一度 x）は出ない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j");
    await user.keyboard("x");
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(1);
    // 輪が外れるのを待たず、外す操作でも増えないことを確かめる
    const foldButton = await screen.findByRole("button", { name: /完了 1件/ });
    await user.click(foldButton);
    const undoneButton = screen.getByRole("button", { name: "「A」の完了を外す" });
    for (const ring of document.querySelectorAll("[data-complete-ring]")) ring.remove();
    await user.click(undoneButton);
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("オフラインで断られたときは出ない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await user.keyboard("j");
    await user.keyboard("x");
    expect(store.lists.completedTodayCount).toBe(0);
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });
});
