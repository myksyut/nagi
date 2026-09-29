import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { SIDEBAR_STORAGE_KEY } from "./shell/sidebar-state";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット20：サイドバーを畳む（アイコンだけの細い帯）。
 * - ⌘\（JIS の ⌘¥）・一番下のボタンで畳む・広げる。<html data-sidebar="rail"> と localStorage に写る
 * - 読み込み直しても畳んだまま（localStorage から）
 * - 帯の項目にマウスを乗せる・運んで重ねると、帯の右に名前（と件数）の札が出る
 * - ⌘K の「プロジェクトを作成」は、広げてから名前の欄を開く。名前の欄にいるときに畳むと、フォーカスは一覧へ
 * 見た目（幅・透明）は CSS（styles.css の rail の書き方）なので、ここでは状態と札と ARIA を見る
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function open(path: string, server = new FakeServer()) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "リスト" });
}

function navLink(label: string): HTMLElement {
  return within(sidebar()).getByRole("link", { name: new RegExp(`^${label}`) });
}

function railTip(): HTMLElement | null {
  return document.querySelector("[data-rail-tip]");
}

const isRail = () => document.documentElement.dataset.sidebar === "rail";

describe("畳む・広げる", () => {
  it("⌘\\ で畳み、もう一度で広げる。<html> の data-sidebar と localStorage に写り、ボタンの名前も替わる", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    expect(isRail()).toBe(false);
    expect(screen.getByRole("button", { name: /^サイドバーを畳む/ })).toBeInTheDocument();

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("rail");
    expect(screen.getByRole("button", { name: /^サイドバーを広げる/ })).toBeInTheDocument();

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("JIS キーボードの ¥ のキー（⌘¥）でも切り替わる", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("{Meta>}¥{/Meta}");
    expect(isRail()).toBe(true);
  });

  it("一番下のボタンで切り替わる", async () => {
    const user = userEvent.setup();
    await open("/today");
    await user.click(screen.getByRole("button", { name: /^サイドバーを畳む/ }));
    expect(isRail()).toBe(true);
    await user.click(screen.getByRole("button", { name: /^サイドバーを広げる/ }));
    expect(isRail()).toBe(false);
  });

  it("畳んだまま読み込み直すと、最初から畳んでいる。外枠がなくなると data-sidebar を外す", async () => {
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    await open("/today");
    expect(isRail()).toBe(true);
    expect(screen.getByRole("button", { name: /^サイドバーを広げる/ })).toBeInTheDocument();
    // 帯でも、リストの行は名前で見つかる（名前は透明にして残している）
    expect(navLink("今日")).toHaveAttribute("aria-current", "page");
    cleanup();
    expect(document.documentElement.dataset.sidebar).toBeUndefined();
  });

  it("入力欄の中でも効く（タイトルを打っている途中でも）", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "資料");
    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    expect(input).toHaveValue("資料");
    expect(input).toHaveFocus();
  });
});

describe("帯の右の札", () => {
  it("帯のリストにマウスを乗せると、名前と未完了の件数が出て、外れると消える。広げているときは出さない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "a", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "b", bucket: "today", rank: "a1" }));
    await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.hover(navLink("今日"));
    expect(railTip()).toBeNull();

    await user.keyboard("{Meta>}\\{/Meta}");
    await user.hover(navLink("予定"));
    await user.hover(navLink("今日"));
    await waitFor(() => expect(railTip()).toHaveTextContent("今日2"));
    await user.unhover(sidebar());
    await user.hover(screen.getByRole("listbox", { name: "受信箱" }));
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("プロジェクトの色の点にマウスを乗せると、プロジェクトの名前が出る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putProject(makeProject({ name: "成田国際空港" }));
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    await open("/today", server);
    await user.hover(await within(sidebar()).findByRole("link", { name: /^成田国際空港/ }));
    await waitFor(() => expect(railTip()).toHaveTextContent("成田国際空港"));
  });

  it("タスクを運んで帯の項目に重ねると、その名前が出る", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "ADVICS" }));
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    await open("/today", server);
    const project = await within(sidebar()).findByRole("link", { name: /^ADVICS/ });
    fireEvent.dragOver(project);
    await waitFor(() => expect(railTip()).toHaveTextContent("ADVICS"));
    fireEvent.drop(window);
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("畳む・広げるボタンの札には、キーを添える", async () => {
    const user = userEvent.setup();
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    await open("/today");
    await user.hover(screen.getByRole("button", { name: /^サイドバーを広げる/ }));
    await waitFor(() => expect(railTip()).toHaveTextContent("サイドバーを広げる⌘\\"));
  });
});

describe("プロジェクトの名前の欄", () => {
  it("畳んでいるときに ⌘K の「プロジェクトを作成」を選ぶと、広げてから名前の欄を開く", async () => {
    const user = userEvent.setup();
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    await open("/today");
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "プロジェクトを作成{Enter}");
    const field = await screen.findByRole("textbox", { name: "新しいプロジェクトの名前" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(isRail()).toBe(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("名前の欄で打っている途中に畳むと、フォーカスは一覧へ移り、打った名前は広げると残っている", async () => {
    const user = userEvent.setup();
    await open("/today");
    const list = await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    const field = await screen.findByRole("textbox", { name: "新しいプロジェクトの名前" });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, "週次");

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    await waitFor(() => expect(list).toHaveFocus());

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(screen.getByRole("textbox", { name: "新しいプロジェクトの名前" })).toHaveValue("週次");
  });
});
