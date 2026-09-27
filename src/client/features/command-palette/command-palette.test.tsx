import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "@/data";
import { type KeyBinding, keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { FakeServer } from "@/test/fake-server";
import { makeProject, makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";
import { PALETTE_BINDING_ID } from "./register";

/**
 * 7 の完了の条件3：⌘K から、キーマップにあるすべての操作を実行できる。表示されるキーと実際の割り当てが一致する。
 * あわせて、検索・絞り込み・フォーカスの決まり、ログアウト
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
});

async function open(path: string, server: FakeServer, name: string) {
  const { store, location } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name });
  return { store, location };
}

async function openPalette(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Meta>}k{/Meta}");
  return screen.findByRole("combobox", { name: "検索とコマンド" });
}

/** ⌘K の項目のうち、ラベルがちょうど一致するものを探す（部分一致による取り違えを避ける） */
function findItemByExactLabel(label: string): HTMLElement {
  const options = screen.getAllByRole("option");
  const found = options.find(
    (option) => within(option).queryByText(label, { exact: true }) !== null,
  );
  if (!found) throw new Error(`⌘K に「${label}」が見つかりません`);
  return found;
}

/** 各割り当てが ⌘K に正しいキー表示で並び、選ぶと run が呼ばれる */
async function expectRunnableFromPalette(
  user: ReturnType<typeof userEvent.setup>,
  bindings: readonly KeyBinding[],
) {
  for (const binding of bindings) {
    const spy = vi.spyOn(binding, "run").mockImplementation(() => {});
    try {
      await openPalette(user);
      const item = findItemByExactLabel(binding.label);
      // キーのない操作（プロジェクトを作成）は、キーを出さない
      const key = binding.keys[0];
      if (key === undefined) expect(item.querySelector("kbd")).toBeNull();
      else expect(within(item).getByText(formatKey(key))).toBeInTheDocument();

      await user.click(item);
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
      );
    } finally {
      spy.mockRestore();
    }
  }
}

/** ボードでだけ効く割り当ての場面（features/board/register.tsx） */
const BOARD_SCOPE = "board";

describe("完了の条件3：キーマップのすべての割り当てを ⌘K から実行できる", () => {
  it("keymap.list() の各割り当て（場面を分けたものを除く）が、今日のリストで正しいキー表示で並び、選ぶと run が呼ばれる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store } = await open("/today", server, "今日");

    // undo を使えるようにしておく（実際に1つ操作をしておく）
    await user.keyboard("j");
    await user.keyboard("{Meta>}z{/Meta}"); // 何もなくても静かに無視される
    await act(async () => {
      store.actions.addTask({ title: "捨てる用", bucket: "today" });
    });
    await user.keyboard("j"); // A を選ぶ（並べ替え・完了・today/later などの対象にする）
    expect(store.canUndo).toBe(true);

    // 場面（scope）を分けた割り当て（カレンダー・タイムラインの [ ]、ボードの ←→ など）は、その画面が出ているときだけ
    // 使えるので、その画面で確かめる（ボードは下のテスト、カレンダーとタイムラインはそれぞれの画面のテスト）
    const bindings = keymap
      .list()
      .filter((binding) => binding.id !== PALETTE_BINDING_ID && binding.scope === undefined);
    expect(bindings.length).toBeGreaterThan(5);
    await expectRunnableFromPalette(user, bindings);
  });

  it("ボードの場面の割り当て（←→）が、今日のボードで正しいキー表示で並び、選ぶと run が呼ばれる", async () => {
    localStorage.setItem("nagi:board-screens", JSON.stringify(["today"]));
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    await open("/today", server, "今日のボード");
    await user.keyboard("j");

    const bindings = keymap.list().filter((binding) => binding.scope === BOARD_SCOPE);
    expect(bindings.length).toBeGreaterThan(0);
    await expectRunnableFromPalette(user, bindings);
  });
});

describe("⌘K：絞り込みと、今使えない操作は出さない", () => {
  it("打った文字で絞り込まれる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    await open("/today", server, "今日");
    const input = await openPalette(user);
    await user.type(input, "今日を開く");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]?.textContent).toContain("今日を開く");
  });

  it("何も選んでいないときは t などが出ない", async () => {
    const server = new FakeServer();
    await open("/today", server, "今日");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "今日へ");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});

describe("⌘K：リスト・プロジェクトへの移動", () => {
  it("リストへ移動できる（1〜5 と同じ場所）", async () => {
    const server = new FakeServer();
    await open("/today", server, "今日");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "受信箱を開く{Enter}");
    await screen.findByRole("listbox", { name: "受信箱" });
  });

  it("プロジェクトへ移動できる", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    await open("/today", server, "今日");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "AIPR{Enter}");
    await screen.findByRole("heading", { name: "AIPR" });
  });
});

describe("⌘K：タスクの検索", () => {
  it("完了ログを含む。削除済みは出ない。場所が横に出る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "古い仕事", bucket: "today", completedAt: "2026-01-01T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "削除された仕事", bucket: "inbox", deletedAt: "2026-01-02T00:00:00.000Z" }),
    );
    server.putTask(makeTask({ title: "今の仕事", bucket: "inbox" }));
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "仕事");
    const options = screen.getAllByRole("option");
    const titles = options.map((o) => o.textContent ?? "");
    expect(titles.some((t) => t.includes("古い仕事"))).toBe(true);
    expect(titles.some((t) => t.includes("今の仕事"))).toBe(true);
    expect(titles.some((t) => t.includes("削除された仕事"))).toBe(false);
    expect(screen.getByRole("option", { name: /古い仕事/ }).textContent).toContain("完了ログ");
    expect(screen.getByRole("option", { name: /今の仕事/ }).textContent).toContain("受信箱");
  });

  it("選ぶと、そのタスクがあるリストが開き、その行が選ばれ、一覧にフォーカスが入る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "見つける用", bucket: "later" }));
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "見つける用{Enter}");
    await screen.findByRole("listbox", { name: "あとで" });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("見つける用"),
    );
    await waitFor(() => expect(screen.getByRole("listbox", { name: "あとで" })).toHaveFocus());
  });

  it("今日完了したタスクを選ぶと「完了 N件」が開いて選ばれる", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "終わった", bucket: "today", completedAt: new Date().toISOString() }),
    );
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "終わった");
    expect(screen.getByRole("option", { name: /終わった/ }).textContent).toContain("今日・完了");
    await user.keyboard("{Enter}");
    await screen.findByRole("listbox", { name: "今日" });
    await waitFor(() =>
      expect(screen.getByRole("option", { selected: true }).textContent).toContain("終わった"),
    );
  });
});

describe("⌘K：変換中の Enter・Esc でのフォーカス", () => {
  it("変換中の Enter（isComposing・keyCode 229）では実行しない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j");
    const input = await openPalette(user);
    await user.type(input, "今日へ");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(store.lists.inbox).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "検索とコマンド" })).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(store.lists.today).toHaveLength(1));
  });

  it("Esc で閉じると、一覧にフォーカスが戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("j"); // 一覧にフォーカスを置いてから開く
    await openPalette(user);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
    );
    await waitFor(() => expect(screen.getByRole("listbox", { name: "今日" })).toHaveFocus());
  });

  it("開いたタスクのタイトル欄から開いたら、Esc でタイトル欄へフォーカスが戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("j{Enter}{Enter}"); // 開いて、もう一度 Enter でタイトルへ
    const title = screen.getByRole("textbox", { name: "タイトル" });
    expect(title).toHaveFocus();
    await user.keyboard("{Meta>}k{/Meta}");
    await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(title).toHaveFocus());
  });
});

describe("⌘K から n・d・p を選ぶとフォーカスが入る", () => {
  it("n：追加欄", async () => {
    const server = new FakeServer();
    await open("/today", server, "今日");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "追加{Enter}");
    const add = await screen.findByRole("textbox", { name: "今日に追加" });
    await waitFor(() => expect(add).toHaveFocus());
  });

  it("d：日付の入力", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j");
    const input = await openPalette(user);
    await user.type(input, "日付を決めて{Enter}");
    const date = await screen.findByRole("textbox", { name: "予定の日付" });
    await waitFor(() => expect(date).toHaveFocus());
  });

  it("p：プロジェクトの候補", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j");
    const input = await openPalette(user);
    await user.type(input, "プロジェクト{Enter}");
    const combobox = await screen.findByRole("combobox", { name: "プロジェクト" });
    await waitFor(() => expect(combobox).toHaveFocus());
  });
});

describe("ログアウト", () => {
  it("POST /auth/logout を JSON の {} で呼び、成功したら /login へ移る。ボタンは画面にない", async () => {
    const server = new FakeServer();
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const { location } = await open("/today", server, "今日");
    expect(screen.queryByRole("button", { name: "ログアウト" })).toBeNull();

    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "ログアウト{Enter}");

    await waitFor(() => expect(location.history.at(-1)).toBe("/login"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/logout",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    );
  });

  it("失敗したら移らず「ログアウトできませんでした」と出る", async () => {
    const server = new FakeServer();
    const fetchMock = vi.fn(async () => new Response(null, { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { location } = await open("/today", server, "今日");

    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "ログアウト{Enter}");

    await waitFor(() =>
      expect(screen.getAllByText("ログアウトできませんでした").length).toBeGreaterThan(0),
    );
    expect(location.history.at(-1)).not.toBe("/login");
  });

  it("fetch 自体が失敗しても「ログアウトできませんでした」", async () => {
    const server = new FakeServer();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    const { location } = await open("/today", server, "今日");

    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "ログアウト{Enter}");

    await waitFor(() =>
      expect(screen.getAllByText("ログアウトできませんでした").length).toBeGreaterThan(0),
    );
    expect(location.history.at(-1)).not.toBe("/login");
  });
});
