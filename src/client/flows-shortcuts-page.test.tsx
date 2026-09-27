import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { App } from "./app";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { fieldKeyScenes } from "./keyboard/field-keys";
import { keymap } from "./keyboard/keymap";
import { preloadDeferred } from "./lib/deferred";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * チケット17：ショートカットのページ（Core Flows のフロー6）。features/shortcuts/shortcuts-screen.test.tsx の続きで、
 * 完了の条件のうち、そこで確かめていない道筋を画面ごと確かめる。
 * - 開いて戻るのを何度か繰り返しても、戻り先が正しく、履歴にページが残らない（ブラウザの戻る・進むも）
 * - プロジェクトの画面・ページの中から移った画面へ戻る。ページが出ているあいだの ⌘K
 * - 入力欄の中の `?` はページを開かない。ページの右下の ＋ と n（小さな追加欄）
 * - 並び（決まった画面だけで効くキーは後ろに、効く画面ごと）、キーのない操作、場面の名前での絞り込み
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function open(path: string, server = new FakeServer()) {
  server.putTask(makeTask({ title: "A", bucket: "today" }));
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

/**
 * 本物のブラウザの履歴（window.history）で描く。ブラウザの戻る・進むを確かめるため
 * （render-app の setupApp はメモリの履歴で、戻るがない）
 */
async function openWithBrowserHistory(path: string) {
  await preloadDeferred();
  window.history.replaceState(null, "", path);
  const server = new FakeServer();
  server.putTask(makeTask({ title: "A", bucket: "today" }));
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  render(
    <StoreProvider store={store}>
      <Router>
        <App />
      </Router>
    </StoreProvider>,
  );
  await act(async () => {
    await store.sync();
  });
  return store;
}

/** ブラウザの戻る・進む（popstate が届くまで待つ） */
async function browser(direction: "back" | "forward") {
  await act(async () => {
    const popped = new Promise((resolve) =>
      window.addEventListener("popstate", resolve, { once: true }),
    );
    if (direction === "back") window.history.back();
    else window.history.forward();
    await popped;
  });
}

function filterInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "ショートカットを絞り込む" });
}

async function findPage(): Promise<HTMLElement> {
  return screen.findByRole("heading", { name: "ショートカット" });
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "リスト" });
}

describe("開いて戻るのを繰り返す", () => {
  it("`?` で開いて Esc で戻るのを3回繰り返しても、毎回もとの画面に戻り、履歴にページが残らない", async () => {
    const user = userEvent.setup();
    const { location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });

    for (let i = 0; i < 3; i++) {
      await user.keyboard("?");
      await findPage();
      expect(location.history?.at(-1)).toBe("/shortcuts");
      expect(filterInput()).toHaveFocus();
      await user.keyboard("{Escape}");
      await screen.findByRole("listbox", { name: "受信箱" });
    }
    expect(location.history).toEqual(["/inbox", "/inbox", "/inbox", "/inbox"]);
    expect(screen.queryByRole("heading", { name: "ショートカット" })).toBeNull();
  });

  it("欄の外で押す `?` の往復（⇧ を押した `?`）でも、同じように戻る", async () => {
    const user = userEvent.setup();
    const { location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    for (let i = 0; i < 2; i++) {
      await user.keyboard("{Shift>}?{/Shift}");
      await findPage();
      // 欄の外へフォーカスを出してから `?`（欄の中の `?` は文字になる）
      await user.click(screen.getByRole("heading", { name: "ショートカット" }));
      await user.keyboard("{Shift>}?{/Shift}");
      await screen.findByRole("listbox", { name: "今日" });
    }
    expect(location.history).toEqual(["/today", "/today", "/today"]);
  });

  it("ページから別の画面へ移り、そこで開いたページは、その画面へ戻る", async () => {
    const user = userEvent.setup();
    const { location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("?");
    await findPage();
    await user.click(within(sidebar()).getByRole("link", { name: /^受信箱/ }));
    await screen.findByRole("listbox", { name: "受信箱" });
    // ページを離れたら、Esc はページの割り当てではなくなる（受信箱に留まる）
    await user.keyboard("{Escape}");
    expect(location.history?.at(-1)).toBe("/inbox");

    await user.keyboard("?");
    await findPage();
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(location.history).toEqual(["/today", "/shortcuts", "/inbox", "/inbox"]);
  });

  it("プロジェクトの画面から開くと、Esc でそのプロジェクトの画面に戻り、一覧が出る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    server.putTask(makeTask({ title: "Pのタスク", bucket: "later", projectId: project.id }));
    const { location } = await open(`/projects/${project.id}`, server);
    await screen.findByRole("listbox", { name: "AIPR" });

    await user.keyboard("?");
    await findPage();
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "AIPR" });
    expect(location.history).toEqual([`/projects/${project.id}`, `/projects/${project.id}`]);
    expect(optionTitles("AIPR")).toEqual(["Pのタスク"]);
  });

  it("カレンダーから開くと、Esc でカレンダーに戻る（ページのあいだはカレンダーの [ ] は効かない）", async () => {
    const user = userEvent.setup();
    const { location } = await open("/calendar");
    await screen.findByRole("button", { name: "次の月" });
    // 見ている年月（見出しの下の「2026年9月」。h1 はいつも「カレンダー」なので、月が動いても変わらない）
    const shownMonth = () => screen.getByText(/^\d{4}年\d{1,2}月$/).textContent;
    const month = shownMonth();
    expect(month).toMatch(/^\d{4}年\d{1,2}月$/);

    await user.keyboard("?");
    await findPage();
    await user.click(screen.getByRole("heading", { name: "ショートカット" }));
    await user.keyboard("]");
    expect(location.history?.at(-1)).toBe("/shortcuts");
    await user.keyboard("{Escape}");
    await screen.findByRole("button", { name: "次の月" });
    expect(location.history).toEqual(["/calendar", "/calendar"]);
    // 見ている月は動いていない（カレンダーの見ている月は、画面を移っても残る）
    expect(shownMonth()).toBe(month);
  });

  // 17-修正1 の 7：戻り先のプロジェクトがもうないときは、今日へ移る
  // （「取り消したときにそのプロジェクトの画面を開いていれば、今日へ移る」と同じ扱い）
  it("戻り先のプロジェクトが、ページを開いているあいだに消えたら（作成の ⌘Z）、Esc で今日へ移る", async () => {
    const user = userEvent.setup();
    const { store, location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(
      screen.getByRole("textbox", { name: "新しいプロジェクトの名前" }),
      "すぐ取り消す{Enter}",
    );
    const list = await screen.findByRole("listbox", { name: "すぐ取り消す" });
    await waitFor(() => expect(list).toHaveFocus());

    await user.keyboard("?");
    await findPage();
    // 欄の外で ⌘Z（欄の中の ⌘Z は文字の取り消し）
    await user.click(screen.getByRole("heading", { name: "ショートカット" }));
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);

    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "今日" });
    expect(location.history?.at(-1)).toBe("/today");
    expect(screen.queryByText("プロジェクトが見つかりません")).toBeNull();
  });

  it("入力欄の中の `?` は文字として入り、ページを開かない", async () => {
    const user = userEvent.setup();
    const { location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("n");
    const add = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(add, "なぜ?");
    expect(add).toHaveValue("なぜ?");
    expect(location.history).toEqual(["/today"]);
  });
});

describe("ブラウザの戻る・進む", () => {
  it("開いて Esc で戻ったあと、ブラウザの戻るはページへ行かない", async () => {
    const user = userEvent.setup();
    await openWithBrowserHistory("/inbox");
    await user.click(within(sidebar()).getByRole("link", { name: /^今日/ }));
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("?");
    await findPage();
    expect(window.location.pathname).toBe("/shortcuts");
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "今日" });
    expect(window.location.pathname).toBe("/today");

    // 戻るは、ページではなく同じ今日（ページの履歴を今日で置き換えたため）、その次が受信箱
    await browser("back");
    expect(window.location.pathname).toBe("/today");
    expect(screen.queryByRole("heading", { name: "ショートカット" })).toBeNull();
    await browser("back");
    expect(window.location.pathname).toBe("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
  });

  it("ページをブラウザの戻るで離れたあとは、Esc はページの割り当てにならず、`?` でまた開ける。進むで戻ったページの Esc は前の画面へ", async () => {
    const user = userEvent.setup();
    await openWithBrowserHistory("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("?");
    await findPage();
    await browser("back");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(screen.queryByRole("heading", { name: "ショートカット" })).toBeNull();

    // ページはもう出ていない：Esc で画面は動かない
    await user.keyboard("{Escape}");
    expect(window.location.pathname).toBe("/inbox");

    await browser("forward");
    await findPage();
    expect(window.location.pathname).toBe("/shortcuts");
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(window.location.pathname).toBe("/inbox");

    // 画面の中でもう一度開ける
    await user.keyboard("?");
    await findPage();
    await user.keyboard("{Escape}");
    await screen.findByRole("listbox", { name: "受信箱" });
  });
});

describe("ページが出ているあいだ", () => {
  it("⌘K に「ショートカット一覧」は出ず、「前の画面に戻る」で戻れる", async () => {
    const user = userEvent.setup();
    const { location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    await user.keyboard("?");
    await findPage();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "ショートカット");
    expect(screen.queryByRole("option", { name: /ショートカット一覧/ })).toBeNull();

    await user.clear(input);
    await user.type(input, "前の画面に戻る");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(location.history).toEqual(["/inbox", "/inbox"]);
  });

  it("右下の ＋ と n で小さな追加欄が開き、受信箱に足せる。欄の Esc は欄を閉じるだけで、ページに留まる", async () => {
    const user = userEvent.setup();
    const { store, location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("?");
    await findPage();

    await user.click(screen.getByRole("button", { name: "タスクを追加" }));
    const quick = await screen.findByRole("textbox", { name: "受信箱に追加" });
    await waitFor(() => expect(quick).toHaveFocus());
    await user.keyboard("ページから足す{Enter}");
    expect(store.lists.inbox.map((row) => row.title)).toEqual(["ページから足す"]);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "受信箱に追加" })).toBeNull());
    expect(location.history?.at(-1)).toBe("/shortcuts");
    await findPage();

    // n（欄の外で）でも開く
    await user.click(screen.getByRole("heading", { name: "ショートカット" }));
    await user.keyboard("n");
    expect(await screen.findByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "受信箱に追加" })).toBeNull());
    expect(location.history?.at(-1)).toBe("/shortcuts");
  });
});

describe("並び", () => {
  it("移動のまとまりでは、どこでも効くキーが先に、決まった画面だけで効くキーが後ろに、効く画面ごとに並ぶ", async () => {
    await open("/shortcuts");
    await findPage();
    const section = screen.getByRole("region", { name: "移動" });
    const rows = within(section)
      .getAllByRole("listitem")
      .map((row) => {
        const label = row.firstElementChild?.textContent ?? "";
        const binding = keymap.list().find((entry) => entry.label === label);
        return binding?.where ?? null;
      });
    const firstWhere = rows.findIndex((where) => where !== null);
    expect(firstWhere).toBeGreaterThan(0);
    expect(rows.slice(firstWhere).every((where) => where !== null)).toBe(true);
    // 効く画面ごとにまとまり、名前の順（カレンダー・タイムライン・ボード）
    const wheres = rows.slice(firstWhere).filter((where, i, all) => where !== all[i - 1]);
    expect(wheres).toEqual(["カレンダー", "タイムライン", "ボード"]);
  });

  it("キーのない「プロジェクトを作成」は、リストのまとまりに「キーなし」で出て、名前で絞り込める", async () => {
    const user = userEvent.setup();
    await open("/shortcuts");
    await findPage();

    const row = within(screen.getByRole("region", { name: "リスト" }))
      .getByText("プロジェクトを作成", { exact: true })
      .closest("li") as HTMLElement;
    expect(within(row).getByText("キーなし")).toBeInTheDocument();
    expect(row.querySelector("kbd")).toBeNull();

    await user.type(filterInput(), "プロジェクトを");
    expect(screen.getByText("プロジェクトを作成", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("完了（もう一度で戻す）")).toBeNull();
  });

  it("場面の名前（チェックリスト）で絞ると、その場面のキーがすべて出る。キーの名前（esc）でも絞れる", async () => {
    const user = userEvent.setup();
    await open("/shortcuts");
    await findPage();
    const checklist = fieldKeyScenes().find((scene) => scene.id === "checklist");
    expect(checklist).toBeDefined();

    await user.type(filterInput(), "チェックリスト");
    const section = screen.getByRole("region", { name: "チェックリスト" });
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((row) => row.firstElementChild?.textContent),
    ).toEqual(checklist?.keys.map((key) => key.label));

    await user.clear(filterInput());
    await user.type(filterInput(), "esc");
    // ページの Esc（絞り込みを消す・前の画面に戻る）は当たり、? だけの「前の画面に戻る」は当たらない
    expect(screen.getByText("絞り込みを消す・前の画面に戻る", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("前の画面に戻る", { exact: true })).toBeNull();
    expect(screen.queryByText("完了（もう一度で戻す）")).toBeNull();
    // 候補や欄の中の Esc も当たる
    expect(screen.getByRole("region", { name: "候補や欄の中" })).toBeInTheDocument();
  });

  it("サイドバーの「ショートカット」は完了ログの下（一番下）", async () => {
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const links = within(sidebar())
      .getAllByRole("link")
      .map((link) => link.textContent);
    expect(links.at(-1)).toBe("ショートカット");
    expect(links.at(-2)).toMatch(/^完了ログ/);
  });
});
