import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { SIDEBAR_STORAGE_KEY } from "./shell/sidebar-state";
import { breakLocalStorage } from "./test/broken-storage";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * チケット20：サイドバーを畳む（アイコンだけの細い帯）。flows-sidebar-rail.test.tsx の続きで、そこで見ていない道筋を確かめる。
 * - ⌘K の「サイドバーを畳む・広げる」と、ショートカットのページの「全体」の ⌘\・⌘¥
 * - 帯の右の札：キーのフォーカス・押したとき・スクロール・フォーカスが外れたとき・広げたとき。
 *   完了ログ・ショートカット・ビューの項目。件数が 0 の項目
 * - 帯のアイコンと色の点に、タスクを運んで落とす
 * - 畳むときのフォーカス（プロジェクトの ＋、一覧のない画面の名前の欄）
 * - localStorage が使えないとき
 * happy-dom は :focus-visible を :focus と同じに扱う（キーのフォーカスとマウスのフォーカスを分けない）。
 * マウスで押したときの振る舞いは、:focus-visible の答えを差し替えて確かめる
 */

const stores: AppStore[] = [];
/** 例外を投げるように替えた localStorage を戻す */
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

async function open(path: string, server = new FakeServer()) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

/** 畳んだまま読み込み直したところから始める */
async function openRail(path: string, server = new FakeServer()) {
  localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
  return open(path, server);
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

/** 札の文字（名前・件数・キーをつなげたもの）。札がなければ null */
function railTipText(): string | null {
  return railTip()?.textContent ?? null;
}

const isRail = () => document.documentElement.dataset.sidebar === "rail";

/**
 * `:focus-visible` の答えだけを差し替える（ほかのセレクターはそのまま）。
 * happy-dom は :focus-visible を :focus と同じに答えるので、マウスで押したフォーカスや、:focus-visible を知らない環境を真似る
 */
function stubFocusVisible(answer: () => boolean) {
  const original = Element.prototype.matches;
  const asked: Element[] = [];
  vi.spyOn(Element.prototype, "matches").mockImplementation(function (
    this: Element,
    selector: string,
  ) {
    if (selector !== ":focus-visible") return original.call(this, selector);
    asked.push(this);
    return answer();
  });
  /** :focus-visible を尋ねられた要素 */
  return asked;
}

describe("⌘K とショートカットのページ", () => {
  it("⌘K の「サイドバーを畳む・広げる」（キーは ⌘\\）で畳み、もう一度で広げる。実行したあとのフォーカスは一覧", async () => {
    const user = userEvent.setup();
    await open("/today");
    const list = await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "サイドバー");
    const item = screen
      .getAllByRole("option")
      .find(
        (option) =>
          within(option).queryByText("サイドバーを畳む・広げる", { exact: true }) !== null,
      );
    expect(item).toBeDefined();
    expect(within(item as HTMLElement).getByText("⌘\\")).toBeInTheDocument();
    await user.click(item as HTMLElement);
    await waitFor(() => expect(isRail()).toBe(true));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("rail");
    await waitFor(() => expect(list).toHaveFocus());

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByRole("combobox", { name: "検索とコマンド" }),
      "サイドバーを畳む・広げる{Enter}",
    );
    await waitFor(() => expect(isRail()).toBe(false));
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("ショートカットのページの「全体」に、⌘\\ と ⌘¥ の両方が並ぶ", async () => {
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });
    const section = screen.getByRole("region", { name: "全体" });
    const row = within(section)
      .getByText("サイドバーを畳む・広げる", { exact: true })
      .closest("li") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByText("⌘\\")).toBeInTheDocument();
    expect(within(row).getByText("⌘¥")).toBeInTheDocument();
  });
});

describe("帯の右の札：キーのフォーカス", () => {
  it("Tab で帯の項目にフォーカスすると札が出て、次の項目へ移ると替わり、フォーカスが帯の外へ出ると消える", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "a", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "b", bucket: "today", rank: "a1" }));
    await openRail("/inbox", server);
    const list = await screen.findByRole("listbox", { name: "受信箱" });

    // 最初の Tab は帯の一番上（受信箱。0 件なので数字は出さない）
    await user.tab();
    expect(navLink("受信箱")).toHaveFocus();
    await waitFor(() => expect(railTipText()).toBe("受信箱"));
    await user.tab();
    expect(navLink("今日")).toHaveFocus();
    await waitFor(() => expect(railTipText()).toBe("今日2"));

    act(() => list.focus());
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("マウスで押したフォーカス（:focus-visible でない）では、札を出さない", async () => {
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const asked = stubFocusVisible(() => false);
    act(() => navLink("予定").focus());
    expect(navLink("予定")).toHaveFocus();
    expect(asked).toContain(navLink("予定"));
    expect(railTip()).toBeNull();
  });

  it(":focus-visible を知らない環境（matches が例外を投げる）では、フォーカスで札を出す", async () => {
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const asked = stubFocusVisible(() => {
      throw new SyntaxError("unknown pseudo-class");
    });
    act(() => navLink("予定").focus());
    expect(asked).toContain(navLink("予定"));
    await waitFor(() => expect(railTipText()).toBe("予定"));
  });

  it("広げているときは、Tab でフォーカスしても札を出さない", async () => {
    const user = userEvent.setup();
    await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    await user.tab();
    expect(navLink("受信箱")).toHaveFocus();
    expect(railTip()).toBeNull();
  });
});

describe("帯の右の札：消えるとき", () => {
  it("押すと（pointerdown）消える", async () => {
    const user = userEvent.setup();
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.hover(navLink("予定"));
    await waitFor(() => expect(railTipText()).toBe("予定"));
    // user.click は押したあとにフォーカスも移し、happy-dom ではそれがキーのフォーカスに見えて札がまた出る
    // （本物のブラウザでは、マウスで押したリンクは :focus-visible にならない）。押した瞬間だけを確かめる
    fireEvent.pointerDown(navLink("予定"));
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("帯の中をスクロールすると消える", async () => {
    const user = userEvent.setup();
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.hover(navLink("あとで"));
    await waitFor(() => expect(railTipText()).toBe("あとで"));
    fireEvent.scroll(sidebar());
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("出ているときに広げると消える（広げたあとは、マウスを乗せても出さない）", async () => {
    const user = userEvent.setup();
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.hover(navLink("予定"));
    await waitFor(() => expect(railTipText()).toBe("予定"));
    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(false);
    await waitFor(() => expect(railTip()).toBeNull());
    await user.hover(navLink("あとで"));
    expect(railTip()).toBeNull();
  });
});

describe("帯の右の札：項目ごとの中身", () => {
  it("完了ログ・ショートカット・ビュー（カレンダー・タイムライン）にも名前が出る（件数は出さない）", async () => {
    const user = userEvent.setup();
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    for (const label of ["完了ログ", "ショートカット", "カレンダー", "タイムライン"]) {
      await user.hover(navLink(label));
      await waitFor(() => expect(railTipText()).toBe(label));
    }
  });

  it("未完了の件数が 0 の項目は数字を出さない（空の受信箱、完了済みのタスクだけのプロジェクト）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const done = makeProject({ name: "済んだ案件" });
    const busy = makeProject({ name: "進行中" });
    server.putProject(done);
    server.putProject(busy);
    server.putTask(
      makeTask({
        title: "終わった",
        bucket: "later",
        projectId: done.id,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    server.putTask(makeTask({ title: "やる", bucket: "later", projectId: busy.id }));
    await openRail("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.hover(navLink("受信箱"));
    await waitFor(() => expect(railTipText()).toBe("受信箱"));
    await user.hover(await within(sidebar()).findByRole("link", { name: /^済んだ案件/ }));
    await waitFor(() => expect(railTipText()).toBe("済んだ案件"));
    await user.hover(navLink("進行中"));
    await waitFor(() => expect(railTipText()).toBe("進行中1"));
  });

  it("札は読み上げに出さない（項目の名前は、項目の中に残っている）", async () => {
    const user = userEvent.setup();
    await openRail("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.hover(navLink("予定"));
    await waitFor(() => expect(railTip()).toHaveAttribute("aria-hidden", "true"));
    // 札はサイドバーの外に1つだけ（すりガラスのはみ出しの切り取りに掛からないように）
    expect(sidebar().closest("aside")?.contains(railTip())).toBe(false);
    expect(document.querySelectorAll("[data-rail-tip]")).toHaveLength(1);
    expect(within(sidebar()).getByRole("link", { name: "予定" })).toBeInTheDocument();
  });
});

describe("帯へ運んで落とす", () => {
  it("帯の「あとで」のアイコンに落とすと移り、落としたあとは札が消える", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await openRail("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(a);
    const later = screen.getByRole("link", { name: "あとで" });
    fireEvent.dragOver(later);
    await waitFor(() => expect(railTipText()).toBe("あとで"));
    fireEvent.drop(later);
    expect(optionTitles("受信箱")).toEqual([]);
    expect(store.lists.later.map((t) => t.title)).toEqual(["A"]);
    await waitFor(() => expect(railTip()).toBeNull());
  });

  it("帯の「今日」のアイコンに落とすと、今日へ移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await openRail("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });
    fireEvent.dragStart(screen.getByRole("option", { name: /^A/ }));
    const today = screen.getByRole("link", { name: "今日" });
    fireEvent.dragOver(today);
    fireEvent.drop(today);
    expect(store.lists.today.map((t) => t.title)).toEqual(["A"]);
  });

  it("帯のプロジェクトの色の点に落とすと、そのプロジェクトが付く（置き場は変わらない）", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await openRail("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });
    fireEvent.dragStart(screen.getByRole("option", { name: /^A/ }));
    const p = screen.getByRole("link", { name: "P" });
    fireEvent.dragOver(p);
    await waitFor(() => expect(railTipText()).toBe("P"));
    fireEvent.drop(p);
    expect(store.lists.inbox.map((t) => t.title)).toEqual(["A"]);
    expect(store.lists.inbox[0]?.projectId).toBe(project.id);
  });

  it("帯の「予定」のアイコンに落とすと日付の入力が開き、決めると予定へ移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const user = userEvent.setup();
    const { store } = await openRail("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });
    fireEvent.dragStart(screen.getByRole("option", { name: /^A/ }));
    const upcoming = screen.getByRole("link", { name: "予定" });
    fireEvent.dragOver(upcoming);
    fireEvent.drop(upcoming);
    const date = await screen.findByRole("textbox", { name: "予定の日付" });
    await waitFor(() => expect(date).toHaveFocus());
    await user.type(date, "2099/1/1{Enter}");
    expect(store.lists.scheduled.map((t) => t.title)).toEqual(["A"]);
    expect(isRail()).toBe(true);
  });

  it("帯でも「受信箱」「完了ログ」には落とせない（dragOver で preventDefault されない）。札も出さない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    await openRail("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    fireEvent.dragStart(screen.getByRole("option", { name: /^A/ }));
    expect(fireEvent.dragOver(screen.getByRole("link", { name: "受信箱" }))).toBe(true);
    expect(railTip()).toBeNull();
    expect(fireEvent.dragOver(screen.getByRole("link", { name: "完了ログ" }))).toBe(true);
    expect(railTip()).toBeNull();
  });
});

describe("畳むときのフォーカス", () => {
  it("プロジェクトの ＋ にフォーカスがあるときに畳むと、フォーカスは一覧へ移る", async () => {
    const user = userEvent.setup();
    await open("/today");
    const list = await screen.findByRole("listbox", { name: "今日" });
    const plus = screen.getByRole("button", { name: "プロジェクトを作成" });
    act(() => plus.focus());
    expect(plus).toHaveFocus();
    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    await waitFor(() => expect(list).toHaveFocus());
  });

  it("一覧のない画面（カレンダー）で、空の名前の欄にいるときに畳むと、フォーカスが外れて欄は閉じる", async () => {
    const user = userEvent.setup();
    await open("/calendar");
    await user.click(await screen.findByRole("button", { name: "プロジェクトを作成" }));
    const field = await screen.findByRole("textbox", { name: "新しいプロジェクトの名前" });
    await waitFor(() => expect(field).toHaveFocus());

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    expect(field).not.toHaveFocus();
    expect(document.activeElement).toBe(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull(),
    );
    // 広げても開き直さない
    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(false);
    expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull();
  });

  it("一覧のない画面（カレンダー）で、名前を打った欄にいるときに畳むと、フォーカスは外れ、打った名前は広げると残っている", async () => {
    const user = userEvent.setup();
    await open("/calendar");
    await user.click(await screen.findByRole("button", { name: "プロジェクトを作成" }));
    const field = await screen.findByRole("textbox", { name: "新しいプロジェクトの名前" });
    await waitFor(() => expect(field).toHaveFocus());
    await user.type(field, "週次");

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(isRail()).toBe(true);
    expect(document.activeElement).toBe(document.body);

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(screen.getByRole("textbox", { name: "新しいプロジェクトの名前" })).toHaveValue("週次");
  });
});

describe("localStorage が使えないとき", () => {
  it("読み書きが例外を投げても、広げた幅で始まり、そのタブの中では畳む・広げるが効く", async () => {
    const user = userEvent.setup();
    const storage = breakLocalStorage();
    restores.push(storage.restore);
    const sidebarCalls = () =>
      storage.calls
        .filter(({ args }) => args[0] === SIDEBAR_STORAGE_KEY)
        .map(({ method }) => method);
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    expect(sidebarCalls()).toEqual(["getItem"]);
    expect(isRail()).toBe(false);

    await user.keyboard("{Meta>}\\{/Meta}");
    expect(sidebarCalls()).toEqual(["getItem", "setItem"]);
    expect(isRail()).toBe(true);
    expect(screen.getByRole("button", { name: /^サイドバーを広げる/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^サイドバーを広げる/ }));
    expect(sidebarCalls()).toEqual(["getItem", "setItem", "removeItem"]);
    expect(isRail()).toBe(false);
    expect(screen.getByRole("button", { name: /^サイドバーを畳む/ })).toBeInTheDocument();
  });
});
