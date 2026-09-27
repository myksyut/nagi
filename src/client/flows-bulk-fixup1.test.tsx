import type { Task } from "@shared/model";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, pickerListbox, setupApp } from "./test/render-app";

/**
 * 7-修正1：完了ログへのジャンプの描画量・ドラッグの 500 件・rank の長さ・検索の観測・まとめて操作のトースト
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
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

describe("1：⌘K から完了ログの深い位置へ飛んでも、対象を含む窓だけを描く", () => {
  const TOTAL = 20_000;
  const TARGET = 15_000;

  /** 新しい順に「完了 0」「完了 1」…と並ぶ、昨日までに完了したタスク（手元の控えから読み込む） */
  async function openWithLogbook(path: string) {
    const base = Date.UTC(2025, 0, 1);
    const tasks: Task[] = Array.from({ length: TOTAL }, (_, i) =>
      makeTask({
        title: `完了 ${i}`,
        bucket: "today",
        rank: "a0",
        completedAt: new Date(base + (TOTAL - i) * 60_000).toISOString(),
        seq: i + 1,
      }),
    );
    // 手元の控えから読み込む（サーバーから 2 万行を取るより速い）。控えのカーソルとサーバーの seq をそろえ、
    // 最初の同期で全件を取り直さないようにする
    const server = new FakeServer();
    server.seq = TOTAL;
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => ({
        ...createMemoryLocalDb(),
        load: async () => ({ tasks, projects: [], cursor: TOTAL }),
      }),
    });
    stores.push(store);
    const location = memoryLocation({ path, record: true });
    await store.start();
    render(
      <StoreProvider store={store}>
        <Router hook={location.hook} searchHook={location.searchHook}>
          <App />
        </Router>
      </StoreProvider>,
    );
    return { store, location };
  }

  it("2 万件のうち 1 万 5 千件目へ飛ぶと、描く行は決まった範囲に収まり、対象が選ばれる", async () => {
    const user = userEvent.setup();
    const { location } = await openWithLogbook("/today");
    await screen.findByRole("listbox", { name: "今日" });

    const input = await openPalette(user);
    await user.type(input, `完了 ${TARGET}`);
    await user.keyboard("{Enter}");

    const list = await screen.findByRole("listbox", { name: "完了ログ" });
    expect(location.history.at(-1)).toBe("/logbook");
    await waitFor(() =>
      expect(within(list).getByRole("option", { selected: true }).textContent).toContain(
        `完了 ${TARGET}`,
      ),
    );
    const rows = within(list).getAllByRole("option");
    expect(rows.length).toBeLessThanOrEqual(400);
    // 窓の前後の続きを出せる
    expect(screen.getByRole("button", { name: /新しい完了を表示/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /さらに表示/ })).toBeInTheDocument();
  }, 60_000);

  it("窓の上の「新しい完了を表示」と、一番上での ↑ で、前の続きが出る", async () => {
    const user = userEvent.setup();
    await openWithLogbook("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const input = await openPalette(user);
    await user.type(input, `完了 ${TARGET}`);
    await user.keyboard("{Enter}");
    const list = await screen.findByRole("listbox", { name: "完了ログ" });
    await waitFor(() =>
      expect(within(list).getByRole("option", { selected: true }).textContent).toContain(
        `完了 ${TARGET}`,
      ),
    );
    const first = () => within(list).getAllByRole("option")[0]?.textContent ?? "";
    const firstIndex = () => Number(first().replace(/\D+/g, ""));
    const before = firstIndex();
    expect(before).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: /新しい完了を表示/ }));
    const afterClick = firstIndex();
    expect(afterClick).toBeLessThan(before);

    // 一番上の行を選んで ↑ で、さらに前の続きが出て、その1つ上が選ばれる
    const top = within(list).getAllByRole("option")[0];
    if (!top) throw new Error("行がありません");
    await user.click(top);
    await user.keyboard("{Escape}");
    await user.keyboard("{ArrowUp}");
    expect(firstIndex()).toBeLessThan(afterClick);
    expect(within(list).getByRole("option", { selected: true }).textContent).toContain(
      `完了 ${afterClick - 1}`,
    );
  }, 60_000);
});

describe("2：ドラッグでも、選んだ件数（完了済みを含む）で 500 件を判定する", () => {
  it("未完了 500 件と完了済み 1 件を選んでサイドバーへ落としても、知らせだけで何も送らない", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 500; i++) {
      server.putTask(
        makeTask({ title: `T${i}`, bucket: "today", rank: `a${String(i).padStart(3, "0")}V` }),
      );
    }
    server.putTask(
      makeTask({ title: "済", bucket: "today", rank: "b0", completedAt: new Date().toISOString() }),
    );
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    const list = screen.getByRole("listbox", { name: "今日" });
    await user.keyboard("j");
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(501);
    const beforeMutate = server.requestsTo("/api/mutate").length;

    const row = screen.getByRole("option", { name: /^T0/ });
    fireEvent.dragStart(row);
    const later = screen.getByRole("link", { name: "あとで" });
    fireEvent.dragOver(later);
    fireEvent.drop(later);
    fireEvent.dragEnd(row);

    await waitFor(() =>
      expect(screen.getAllByText("一度に扱えるのは 500 件まで").length).toBeGreaterThan(0),
    );
    await act(async () => store.idle());
    expect(server.requestsTo("/api/mutate").length).toBe(beforeMutate);
    expect(store.lists.later).toHaveLength(0);
  }, 30_000);
});

describe("3：rank の上限（1024 文字）に届いた並べ替えは、黙らずに知らせる", () => {
  it("1024 文字の rank のあいだへ入れようとして上限を超えると、「保存できませんでした」", async () => {
    const pad = "0".repeat(1021);
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: `a0${pad}1` }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: `a0${pad}2` }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a1" }));
    const { store } = await open("/today", server, "今日");
    expect(optionTitles("今日")).toEqual(["A", "B", "C"]);
    const user = userEvent.setup();
    const beforeMutate = server.requestsTo("/api/mutate").length;

    await user.keyboard("{ArrowUp}{Alt>}{ArrowUp}{/Alt}"); // C を A と B のあいだへ（1025 文字になる）
    await waitFor(() =>
      expect(screen.getAllByText("保存できませんでした").length).toBeGreaterThan(0),
    );
    expect(optionTitles("今日")).toEqual(["A", "B", "C"]);
    await act(async () => store.idle());
    expect(server.requestsTo("/api/mutate").length).toBe(beforeMutate);
  });

  it("1024 文字ちょうどの rank は保存できる（並べ替えで作った rank がそのまま通る）", async () => {
    const pad = "0".repeat(1020);
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: `a0${pad}1` }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: `a0${pad}2` }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a1" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("{ArrowUp}{Alt>}{ArrowUp}{/Alt}");
    expect(optionTitles("今日")).toEqual(["A", "C", "B"]);
    await act(async () => store.idle());
    const moved = store.lists.today.find((task) => task.title === "C");
    expect(moved?.rank.length).toBe(1024);
    expect(moved?.seq).toBeGreaterThan(0);
    expect(screen.queryByText("保存できませんでした")).toBeNull();
  });
});

describe("4：⌘K を開いたまま同期で変わったタイトル・メモが、検索結果に反映される", () => {
  it("タイトルが変わると、新しく合うものが出て、合わなくなったものが消える", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "見積もりの確認", bucket: "inbox" }));
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "請求書");
    expect(screen.queryByRole("option", { name: /見積もり|請求書/ })).toBeNull();

    server.putTask({ id: task.id, title: "請求書の確認" });
    await act(async () => {
      await store.sync();
    });
    expect(await screen.findByRole("option", { name: /請求書の確認/ })).toBeInTheDocument();

    server.putTask({ id: task.id, title: "別の件" });
    await act(async () => {
      await store.sync();
    });
    await waitFor(() => expect(screen.queryByRole("option", { name: /請求書の確認/ })).toBeNull());
  });

  it("メモが変わっても結果に反映される", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "定例", bucket: "inbox", memo: "" }));
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const input = await openPalette(user);
    await user.type(input, "議事録");
    expect(screen.queryByRole("option", { name: /定例/ })).toBeNull();

    server.putTask({ id: task.id, memo: "議事録は共有フォルダ" });
    await act(async () => {
      await store.sync();
    });
    expect(await screen.findByRole("option", { name: /定例/ })).toBeInTheDocument();
  });
});

describe("5：2 件以上をまとめて変えたら、一覧に残っていても件数入りのトーストを出す", () => {
  function threeInInbox(server: FakeServer) {
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(
        makeTask({ title, bucket: "inbox", createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
      );
    }
  }

  it("p：受信箱の 3 件にプロジェクトを付けると「3件を「AIPR」へ」と「元に戻す」", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    threeInInbox(server);
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}p");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "aipr");
    expect(within(pickerListbox()).getByRole("option", { name: "AIPR" })).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("3件を「AIPR」へ")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    await waitFor(() =>
      expect(store.lists.inbox.every((task) => task.projectId === null)).toBe(true),
    );
  });

  it("p の「作成」でも、作って付けた件数で出す（プロジェクトの分は数えない）", async () => {
    const server = new FakeServer();
    threeInInbox(server);
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}p");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "新案件{Enter}");
    expect(await screen.findByText("3件を「新案件」へ")).toBeInTheDocument();
  });

  it("⇧D：受信箱の 3 件に締切を付けると件数入りのトーストと「元に戻す」", async () => {
    const server = new FakeServer();
    threeInInbox(server);
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}d{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "2099/1/5{Enter}");

    expect(await screen.findByText(/^3件の締切を.+にしました$/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    await waitFor(() =>
      expect(store.lists.inbox.every((task) => task.deadlineOn === null)).toBe(true),
    );
  });

  it("⇧D で締切を外すときも件数で出す", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(
        makeTask({
          title,
          bucket: "inbox",
          deadlineOn: "2099-01-05",
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        }),
      );
    }
    await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}d{/Shift}");
    await screen.findByRole("textbox", { name: "締切" });
    await user.keyboard("{Enter}");
    expect(await screen.findByText("3件の締切を外しました")).toBeInTheDocument();
  });

  it("x：今日で 3 件を完了すると「3件を完了しました」と「元に戻す」（1 件のときは出さない）", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C", "D"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("x");
    expect(store.lists.completedTodayCount).toBe(1);
    expect(screen.queryByRole("button", { name: "元に戻す" })).toBeNull();

    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(3);
    await user.keyboard("x");
    expect(await screen.findByText("3件を完了しました")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "元に戻す" }));
    await waitFor(() =>
      expect(store.lists.today.map((task) => task.title)).toEqual(["B", "C", "D"]),
    );
  });

  it("t：プロジェクトの画面で 3 件を今日へ移すと、画面に残っても「3件を今日へ」", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "AIPR" }));
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "later", projectId: project.id, rank: `a${i}` }));
    }
    const { store } = await open(`/projects/${project.id}`, server, "AIPR");
    const user = userEvent.setup();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}t");
    expect(await screen.findByText("3件を今日へ")).toBeInTheDocument();
    expect(store.lists.today).toHaveLength(3);
  });
});
