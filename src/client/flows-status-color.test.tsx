import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, pickerListbox, setupApp } from "./test/render-app";

/**
 * チケット11：s（進行中にする・やめる）、l・d で今日から出すと未着手に戻る、プロジェクトの色の選び直し、
 * ⌘Z が戻せなかったときの文言の出し分け（進行中の操作でも）。
 * 「小さな詳細」（task-detail-popover）は flows-task-detail-popover.test.tsx にまとめてある。
 * ⌘K・ショートカットのページに「進行中にする／やめる」が出ることは、keymap.list() を汎用にたどる既存のテスト
 * （features/command-palette/command-palette.test.tsx・features/shortcuts/shortcuts-screen.test.tsx）が
 * task.start の登録を自動的にカバーする
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

/** 画面を描かない、もう1つのタブのストア（同じサーバーにつなぐ） */
async function otherTab(server: FakeServer): Promise<AppStore> {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  return store;
}

async function openList(path: string, server: FakeServer, name: string) {
  const { store, location } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name });
  return { store, location };
}

function completeButton(title: string, name = `「${title}」を完了にする`) {
  return screen.getByRole("button", { name });
}

describe("s：進行中にする・やめる", () => {
  it("今日のタスクで s → 位置は変わらず丸が進行中になり、もう一度 s で未着手に戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("s");
    const started = completeButton("A", "「A」を完了にする（進行中）");
    expect(started).toHaveAttribute("data-status", "in-progress");
    expect(optionTitles("今日")).toEqual(["A"]);

    await user.keyboard("s");
    const stopped = completeButton("A");
    expect(stopped).toHaveAttribute("data-status", "not-started");
    expect(optionTitles("今日")).toEqual(["A"]);
  });

  it("受信箱のタスクで s → 今日の一番上へ移り、受信箱から抜けてトーストが出る。今日を開くと行に印が出ている", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "既存", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await openList("/inbox", server, "受信箱");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("s");

    expect(optionTitles("受信箱")).toEqual([]);
    expect(store.lists.today[0]?.title).toBe("A");
    expect(await screen.findByText("「A」を今日へ")).toBeInTheDocument();

    await user.keyboard("2");
    await screen.findByRole("listbox", { name: "今日" });
    expect(optionTitles("今日")).toEqual(["A", "既存"]);
    expect(completeButton("A", "「A」を完了にする（進行中）")).toBeInTheDocument();
  });

  it("あとでのタスクでも同じく今日の一番上へ移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "later" }));
    const { store } = await openList("/later", server, "あとで");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("s");

    expect(optionTitles("あとで")).toEqual([]);
    expect(store.lists.today[0]?.title).toBe("A");
    expect(store.lists.today[0]?.startedAt).not.toBeNull();
  });

  it("まとめて操作：未着手が1つでもあれば未着手のものだけ進行中にする（進行中はそのまま）。2件以上で件数のトースト", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({ title: "C", bucket: "today", rank: "a2", startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}"); // A, B, C を選ぶ
    await user.keyboard("s");

    expect(completeButton("A", "「A」を完了にする（進行中）")).toBeInTheDocument();
    expect(completeButton("B", "「B」を完了にする（進行中）")).toBeInTheDocument();
    expect(completeButton("C", "「C」を完了にする（進行中）")).toBeInTheDocument();
    expect(await screen.findByText("2件を進行中にしました")).toBeInTheDocument();
  });

  it("全部が進行中のときだけ、まとめて未着手に戻す（2件以上で件数のトースト）", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "today", rank: "a0", startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "today", rank: "a1", startedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard("s");

    expect(completeButton("A")).toHaveAttribute("data-status", "not-started");
    expect(completeButton("B")).toHaveAttribute("data-status", "not-started");
    expect(await screen.findByText("2件を未着手に戻しました")).toBeInTheDocument();
  });

  it("完了済みの行には効かない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "today",
        rank: "a0",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const { store } = await openList("/today", server, "今日");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("完了済み");

    await user.keyboard("s");
    expect(store.task(task.id)?.startedAt).toBeNull();
  });

  it("開いたタスクの一番下の状態のボタンで切り替わる。完了したタスクには出ない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    const status = screen.getByRole("button", { name: "状態：未着手" });
    await user.click(status);
    expect(screen.getByRole("button", { name: "状態：進行中" })).toBeInTheDocument();
    expect(store.lists.today[0]?.startedAt).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "状態：進行中" }));
    expect(screen.getByRole("button", { name: "状態：未着手" })).toBeInTheDocument();

    // 完了したタスクには状態のボタンを出さない
    await user.keyboard("x");
    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.queryByRole("button", { name: /^状態：/ })).toBeNull();
  });
});

describe("進行中のタスクを l・d で今日から出すと未着手になる", () => {
  it("l であとでへ", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("js");
    expect(store.task(task.id)?.startedAt).not.toBeNull();

    await user.keyboard("l");
    expect(store.task(task.id)?.bucket).toBe("later");
    expect(store.task(task.id)?.startedAt).toBeNull();

    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(completeButton("A")).toHaveAttribute("data-status", "not-started");
  });

  it("d で先の日付（予定）へ → 未着手になる。⌘Z で今日の進行中に戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await openList("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("js");
    expect(store.task(task.id)?.startedAt).not.toBeNull();

    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "2099-01-01{Enter}");

    expect(store.task(task.id)?.bucket).toBe("scheduled");
    expect(store.task(task.id)?.startedAt).toBeNull();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(task.id)?.bucket).toBe("today");
    expect(store.task(task.id)?.startedAt).not.toBeNull();
  });
});

function dotColorOf(container: Element): string | null {
  return (
    container.querySelector("[data-project-color]")?.getAttribute("data-project-color") ?? null
  );
}

describe("プロジェクトの色を選び直す", () => {
  it("見出しの色の点を押すと8色のパレットが開き、選ぶとサイドバー・行・候補・完了ログに反映され、⌘Z で戻る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "今日の分", bucket: "today", projectId: project.id }));
    server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "today",
        projectId: project.id,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { store, location } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "P" });
    const user = userEvent.setup();

    // 最初は作成順（1つ目）の色：紫
    const colorButton = screen.getByRole("button", { name: "プロジェクトの色：紫" });
    await user.click(colorButton);
    const palette = await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    const radios = within(palette).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual([
      "紫",
      "水色",
      "ピンク",
      "黄",
      "緑",
      "橙",
      "青緑",
      "灰",
    ]);

    await user.click(within(palette).getByRole("radio", { name: "緑" }));
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(store.lists.projectColor(project.id)).toBe("emerald");
    expect(screen.getByRole("button", { name: "プロジェクトの色：緑" })).toBeInTheDocument();

    // サイドバーの点
    const nav = screen.getByRole("navigation", { name: "リスト" });
    const navLink = within(nav).getByRole("link", { name: /^P/ });
    expect(dotColorOf(navLink)).toBe("emerald");

    // 今日の行のプロジェクト名の点
    act(() => location.navigate("/today"));
    await screen.findByRole("listbox", { name: "今日" });
    const row = screen.getByRole("option", { name: /今日の分/ });
    expect(dotColorOf(row)).toBe("emerald");

    // p の候補の点
    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "P");
    const candidate = within(pickerListbox()).getByRole("option", { name: "P" });
    expect(dotColorOf(candidate)).toBe("emerald");
    await user.keyboard("{Escape}");

    // 完了ログの行の点
    act(() => location.navigate("/logbook"));
    await screen.findByRole("listbox", { name: "完了ログ" });
    const logRow = screen.getByRole("option", { name: /完了済み/ });
    expect(dotColorOf(logRow)).toBe("emerald");

    // ⌘Z で作成順の色（紫）に戻る
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projectColor(project.id)).toBe("violet");
    act(() => location.navigate(`/projects/${project.id}`));
    expect(await screen.findByRole("button", { name: "プロジェクトの色：紫" })).toBeInTheDocument();
  });

  it("Esc でパレットが閉じ、色の点のボタンへフォーカスが戻る。←→ で色を移れる", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "P" });
    const user = userEvent.setup();

    const colorButton = screen.getByRole("button", { name: "プロジェクトの色：紫" });
    await user.click(colorButton);
    const palette = await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    const first = within(palette).getByRole("radio", { name: "紫" });
    expect(document.activeElement).toBe(first);

    await user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(within(palette).getByRole("radio", { name: "水色" }));

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(document.activeElement).toBe(colorButton);
  });

  it("color が空のプロジェクトは作成順の色で出る（2つ目は sky）", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "1つ目" }));
    const second = server.putProject(makeProject({ name: "2つ目" }));
    const { store } = await setupApp(`/projects/${second.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "2つ目" });
    expect(screen.getByRole("button", { name: "プロジェクトの色：水色" })).toBeInTheDocument();
  });
});

describe("⌘Z が戻せなかったときの文言（10-修正1・11 の出し分け）", () => {
  const SAVE_CONFLICT_TOAST = "ほかの画面で先に変更されていたため、保存できませんでした";
  const UNDO_CONFLICT_TOAST = "ほかの画面で先に変更されていたため、元に戻せませんでした";

  it("タブAで s→s（未着手に戻す）のあと、タブBが同じタスクをあとでへ移していたら「元に戻せませんでした」", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store } = await openList("/today", server, "今日");
    const other = await otherTab(server);
    const user = userEvent.setup();

    await user.keyboard("j");
    await user.keyboard("s"); // 進行中にする
    await user.keyboard("s"); // 未着手に戻す
    await act(async () => {
      await store.idle();
    });

    // この画面の変更を、ほかのタブが先に取り込んでから、あとでへ移す
    await act(async () => {
      await other.sync();
    });
    other.actions.moveTasks([task.id], { bucket: "later" });
    await other.idle();

    // この画面がほかのタブの変更を取り込んでから ⌘Z
    await act(async () => {
      await store.sync();
    });
    await user.keyboard("{Meta>}z{/Meta}");
    await act(async () => {
      await store.idle();
      await store.sync();
    });

    expect((await screen.findAllByText(UNDO_CONFLICT_TOAST)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(SAVE_CONFLICT_TOAST)).toHaveLength(0);
  });
});
