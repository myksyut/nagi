import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeProject, makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";

/**
 * チケット12：ボード。今日と各プロジェクトの見出しの「リスト｜ボード」（v でも切り替わる。画面ごとに覚える）、
 * 状態の列（未着手・進行中・完了）、ドラッグと ⌥↑↓ での並べ替え、←→↑↓・x・s・t・l・⌘⌫ でのキーだけの操作。
 * データ層（uncompleteTasks の start）は data/actions.test.ts、列の中だけの移動・選択（ListUi）は tasks/list-ui.test.ts。
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function openBoard(path: string, server: FakeServer, listName: string, boardLabel: string) {
  const { store, location } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: listName });
  const user = userEvent.setup();
  await user.keyboard("v");
  await screen.findByRole("listbox", { name: boardLabel });
  return { store, location, user };
}

function board(label: string): HTMLElement {
  return screen.getByRole("listbox", { name: label });
}

function column(boardLabel: string, columnLabel: string): HTMLElement {
  return within(board(boardLabel)).getByRole("group", { name: columnLabel });
}

function card(boardLabel: string, title: string): HTMLElement {
  return within(board(boardLabel)).getByRole("option", { name: new RegExp(`^${title}`) });
}

/** カードを列（または列の中の別のカード）へドラッグして落とす */
function dragTo(fromCard: Element, toElement: Element) {
  fireEvent.dragStart(fromCard);
  fireEvent.dragEnter(toElement);
  fireEvent.dragOver(toElement);
  fireEvent.drop(toElement);
  fireEvent.dragEnd(fromCard);
}

describe("今日のボード：ドラッグで列をまたぐと状態が変わる", () => {
  it("進行中の列へ落とすと進行中になる（今日の中の位置は変わらない）。⌘Z で戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");

    const b = card("今日のボード", "B");
    dragTo(b, column("今日のボード", "進行中"));

    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "B"]);
    expect(store.lists.today.find((t) => t.title === "B")?.startedAt).not.toBeNull();
    expect(within(column("今日のボード", "進行中")).getByRole("option")).toHaveTextContent("B");

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.find((t) => t.title === "B")?.startedAt).toBeNull();
    expect(within(column("今日のボード", "未着手")).getAllByRole("option")).toHaveLength(2);
    expect(within(column("今日のボード", "進行中")).queryAllByRole("option")).toHaveLength(0);
  });

  it("完了の列へ落とすと完了になる。⌘Z で戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");

    dragTo(card("今日のボード", "A"), column("今日のボード", "完了"));
    expect(store.task(store.lists.completedToday[0]?.id ?? "")?.title).toBe("A");
    expect(store.lists.completedToday).toHaveLength(1);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.completedToday).toHaveLength(0);
    expect(store.lists.today.map((t) => t.title)).toEqual(["A"]);
  });
});

/**
 * happy-dom の DragEvent は clientY を init から受け取らないので、イベントに直接乗せて配る
 * （flows-reorder-dnd.test.tsx と同じ。カードの矩形は 0 なので、負なら前・正なら後ろ）
 */
function dragOverWithY(el: Element, clientY: number) {
  const event = new Event("dragover", { bubbles: true, cancelable: true }) as unknown as Event & {
    clientY: number;
    dataTransfer: unknown;
  };
  event.clientY = clientY;
  event.dataTransfer = {};
  fireEvent(el, event);
}

describe("今日のボード：列の中のドラッグと、複数のカード", () => {
  it("同じ列のカードの前へ落とすと、列の中で並べ替わる（状態は変わらない）", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const { store } = await openBoard("/today", server, "今日", "今日のボード");

    const c = card("今日のボード", "C");
    const a = card("今日のボード", "A");
    fireEvent.dragStart(c);
    dragOverWithY(a, -10);
    fireEvent.drop(a);
    fireEvent.dragEnd(c);

    expect(store.lists.today.map((t) => t.title)).toEqual(["C", "A", "B"]);
    expect(store.lists.today.every((t) => t.startedAt === null)).toBe(true);
  });

  it("複数選んだカードをつかんで別の列へ落とすと、まとめて1つの操作で変わる（⌘Z 1回で戻る）", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}"); // A,B
    dragTo(card("今日のボード", "A"), column("今日のボード", "進行中"));

    expect(store.lists.todayBoard.inProgress.map((t) => t.title)).toEqual(["A", "B"]);
    expect(store.lists.todayBoard.notStarted.map((t) => t.title)).toEqual(["C"]);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.todayBoard.inProgress).toHaveLength(0);
  });
});

describe("今日のボード：完了のカードを動かすと、完了を外すのと1つになる", () => {
  it("進行中の列へ落とすと、完了を外して進行中にする（1つの操作。⌘Z 1回で完了に戻る。mutate も1回）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "残り", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "later",
        rank: "a9",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");
    const done = store.lists.completedToday.find((t) => t.title === "完了済み");
    expect(done).toBeDefined();
    const beforeMutate = server.requestsTo("/api/mutate").length;

    dragTo(card("今日のボード", "完了済み"), column("今日のボード", "進行中"));

    const after = store.task(done?.id ?? "");
    expect(after?.completedAt).toBeNull();
    expect(after?.startedAt).not.toBeNull();
    expect(after?.bucket).toBe("today");
    // 今日の一番下（既存の「残り」より後ろ）
    expect(store.lists.today.map((t) => t.title)).toEqual(["残り", "完了済み"]);
    // 1つの操作（1回の /api/mutate）
    expect(server.requestsTo("/api/mutate").length - beforeMutate).toBe(1);

    await user.keyboard("{Meta>}z{/Meta}");
    const restored = store.task(done?.id ?? "");
    expect(restored?.completedAt).not.toBeNull();
    expect(restored?.startedAt).toBeNull();
  });

  it("未着手の列へ落とすと、完了を外して未着手・今日の一番下（進行中にはしない）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "残り", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "later",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const { store } = await openBoard("/today", server, "今日", "今日のボード");
    const done = store.lists.completedToday.find((t) => t.title === "完了済み");

    dragTo(card("今日のボード", "完了済み"), column("今日のボード", "未着手"));

    const after = store.task(done?.id ?? "");
    expect(after?.completedAt).toBeNull();
    expect(after?.startedAt).toBeNull();
    expect(after?.bucket).toBe("today");
    expect(store.lists.today.map((t) => t.title)).toEqual(["残り", "完了済み"]);
  });

  it("進行中の列から未着手の列へ落とすと、未着手に戻る（位置は変わらない）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "B",
        bucket: "today",
        rank: "a1",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { store } = await openBoard("/today", server, "今日", "今日のボード");

    dragTo(card("今日のボード", "B"), column("今日のボード", "未着手"));

    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "B"]);
    expect(store.task(store.lists.today[1]?.id ?? "")?.startedAt).toBeNull();
  });
});

describe("プロジェクトのボード", () => {
  it("あとでにあるタスクを進行中の列へ動かすと、今日へ移って進行中になる（今日の一番上）", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "既存の今日", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "あとで", bucket: "later", projectId: project.id }));
    const { store } = await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");

    dragTo(card("Pのボード", "あとで"), column("Pのボード", "進行中"));

    expect(store.lists.today.map((t) => t.title)).toEqual(["あとで", "既存の今日"]);
    expect(store.lists.today[0]?.startedAt).not.toBeNull();
  });

  it("未着手の列は今日・予定・あとで・受信箱の見出しの順で並ぶ", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "受信箱の分", bucket: "inbox", projectId: project.id }));
    server.putTask(
      makeTask({
        title: "予定の分",
        bucket: "scheduled",
        scheduledOn: "2099-01-01",
        projectId: project.id,
      }),
    );
    server.putTask(makeTask({ title: "あとでの分", bucket: "later", projectId: project.id }));
    server.putTask(makeTask({ title: "今日の分", bucket: "today", projectId: project.id }));
    await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");

    const notStarted = column("Pのボード", "未着手");
    const headings = within(notStarted)
      .getAllByRole("heading")
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["今日", "予定", "あとで", "受信箱"]);
  });

  it("完了の列は直近7日に完了したものだけ", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(
      makeTask({
        title: "直近",
        bucket: "later",
        projectId: project.id,
        completedAt: "2026-09-22T01:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "古い",
        bucket: "later",
        projectId: project.id,
        completedAt: "2026-09-20T01:00:00.000Z",
      }),
    );
    await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");

    const completed = column("Pのボード", "完了");
    expect(
      within(completed)
        .queryAllByRole("option")
        .map((o) => o.textContent?.includes("直近")),
    ).toEqual([true]);
    expect(within(completed).queryByText(/古い/)).toBeNull();
  });

  it("未着手の列の中で、あとでのまとまりから今日のまとまりへ落としても何も変わらない", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(
      makeTask({ title: "今日の分", bucket: "today", rank: "a0", projectId: project.id }),
    );
    server.putTask(
      makeTask({ title: "あとでの分", bucket: "later", rank: "a1", projectId: project.id }),
    );
    const { store } = await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");
    const before = {
      today: store.lists.project(project.id).today.map((t) => t.id),
      later: store.lists.project(project.id).later.map((t) => t.id),
    };

    dragTo(card("Pのボード", "あとでの分"), card("Pのボード", "今日の分"));

    expect(store.lists.project(project.id).today.map((t) => t.id)).toEqual(before.today);
    expect(store.lists.project(project.id).later.map((t) => t.id)).toEqual(before.later);
  });
});

describe("キーだけでの操作", () => {
  const selectedTitle = () => screen.getByRole("option", { selected: true }).textContent;

  it("↑↓（j k）は列の中だけを動き、端で止まる。行のある列がほかになければ →でも動かない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j"); // A
    expect(selectedTitle()).toContain("A");
    await user.keyboard("j"); // B
    expect(selectedTitle()).toContain("B");
    await user.keyboard("j"); // 未着手の列の一番下で止まる
    expect(selectedTitle()).toContain("B");
    await user.keyboard("k");
    expect(selectedTitle()).toContain("A");

    // 進行中・完了には行がないので、→ しても選択は動かない（列をまたぐ行き先がない）
    await user.keyboard("{ArrowRight}");
    expect(selectedTitle()).toContain("A");
  });

  it("←→ で隣の列へ移り（前の列と同じ位置、少なければ一番下）、行のない列は飛ばす", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({ title: "C", bucket: "today", rank: "a2", startedAt: "2026-09-28T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({
        title: "D",
        bucket: "today",
        rank: "a3",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("jj"); // B（未着手の2番目）
    await user.keyboard("{ArrowRight}"); // 進行中は1枚なので一番下の C
    expect(selectedTitle()).toContain("C");
    await user.keyboard("{ArrowRight}");
    expect(selectedTitle()).toContain("D");
    await user.keyboard("{ArrowRight}"); // 一番右の列では動かない
    expect(selectedTitle()).toContain("D");
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(selectedTitle()).toContain("A");
  });

  it("x・s・t・l・⌘⌫ が選んだカードに働く", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j"); // A
    await user.keyboard("s");
    expect(store.lists.today[0]?.startedAt).not.toBeNull();
    expect(within(column("今日のボード", "進行中")).getByRole("option")).toHaveTextContent("A");

    await user.keyboard("l");
    expect(store.lists.later.map((t) => t.title)).toEqual(["A"]);
    expect(store.lists.later[0]?.startedAt).toBeNull();

    // 次に選ばれた B を ⌘⌫ で削除する
    await user.keyboard("{ArrowLeft}");
    expect(selectedTitle()).toContain("B");
    await user.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(store.lists.today).toHaveLength(0);
    expect(within(board("今日のボード")).queryAllByRole("option")).toHaveLength(0);
  });

  it("プロジェクトのボードで t を押すと、あとでのカードが今日のまとまりへ移る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "あとでの分", bucket: "later", projectId: project.id }));
    const { store, user } = await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");

    await user.keyboard("j");
    await user.keyboard("t");
    expect(store.lists.project(project.id).today.map((t) => t.title)).toEqual(["あとでの分"]);
    // 未着手の列の「今日」の見出しの下に出る
    const notStarted = column("Pのボード", "未着手");
    expect(
      within(notStarted)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["今日"]);
    expect(within(notStarted).getByRole("option")).toHaveTextContent("あとでの分");
  });

  it("x で完了にしたあと、選択は同じ列の次のカードへ移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j"); // A
    await user.keyboard("x");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
  });

  it("⇧↑↓ は列の中だけで選択を広げる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "C",
        bucket: "today",
        rank: "a2",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j"); // A
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(
      screen.getAllByRole("option", { selected: true }).map((o) => o.textContent?.slice(0, 1)),
    ).toEqual(["A", "B"]);
  });

  it("⌥↑↓ で列の中だけ並べ替える（完了の列では並べ替わらない）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "C",
        bucket: "today",
        rank: "a2",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "D",
        bucket: "today",
        rank: "a3",
        completedAt: "2026-09-28T01:00:00.000Z",
      }),
    );
    const { store, user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j"); // A
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "A"]);

    // 完了の列は並べ替えられない（⌥↓ を押しても動かず、キーは奪わない）
    await user.keyboard("{ArrowRight}"); // 進行中には行がないので完了へ
    const selected = screen.getByRole("option", { selected: true }).textContent ?? "";
    expect(selected.includes("C") || selected.includes("D")).toBe(true);
    const before = within(column("今日のボード", "完了"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(
      within(column("今日のボード", "完了"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(before);
  });

  it("Enter でカードの下に詳細が広がる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0", memo: "メモ" }));
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("j{Enter}");
    expect(screen.getByRole("group", { name: "「A」の詳細" })).toBeInTheDocument();
  });

  it("n で今日は未着手の列の一番下、プロジェクトはあとでの一番下に追加欄が開く", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    const { user } = await openBoard("/today", server, "今日", "今日のボード");

    await user.keyboard("n");
    const addRow = within(column("今日のボード", "未着手")).getByRole("group", {
      name: "今日に追加",
    });
    // 未着手の列の一番下（A の下）に開く
    const a = card("今日のボード", "A");
    const after = a.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after).toBeTruthy();
  });

  it("n（プロジェクト）：あとでの一番下に追加欄が開く", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "あとでの分", bucket: "later", projectId: project.id }));
    const { user } = await openBoard(`/projects/${project.id}`, server, "P", "Pのボード");

    await user.keyboard("n");
    const addRow = within(column("Pのボード", "未着手")).getByRole("group", {
      name: "あとでに追加",
    });
    const existing = card("Pのボード", "あとでの分");
    const after = existing.compareDocumentPosition(addRow) & Node.DOCUMENT_POSITION_FOLLOWING;
    expect(after).toBeTruthy();
  });
});

describe("リスト｜ボードの切り替えを、画面ごとに覚える", () => {
  it("今日をボード、プロジェクトをリストにすると、開き直してもその見え方。v とボタンの両方で切り替わる。リストに戻すと localStorage から消える", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "今日T", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "あとでT", bucket: "later", projectId: project.id }));

    // 今日：v でボードに切り替える
    const { store: store1, location } = await setupApp("/today", server);
    stores.push(store1);
    await act(async () => {
      await store1.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });
    const user1 = userEvent.setup();
    await user1.keyboard("v");
    await screen.findByRole("listbox", { name: "今日のボード" });

    // プロジェクト：ボタンでボードに切り替え、もう一度ボタンでリストに戻す（同じアプリのまま移動）
    act(() => location.navigate(`/projects/${project.id}`));
    await screen.findByRole("heading", { name: "P" });
    const toggle = screen.getByRole("group", { name: "表示の切り替え" });
    expect(within(toggle).getByRole("button", { name: "リスト" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user1.click(within(toggle).getByRole("button", { name: "ボード" }));
    await screen.findByRole("listbox", { name: "Pのボード" });
    await user1.click(within(toggle).getByRole("button", { name: "リスト" }));
    await screen.findByRole("listbox", { name: "P" });

    // リストに戻したプロジェクトは localStorage から消え、今日だけが残る
    const saved = JSON.parse(localStorage.getItem("nagi:board-screens") ?? "[]");
    expect(saved).toEqual(["today"]);

    // 開き直す（cleanup してもう一度 setupApp。再読み込みの代わり）
    cleanup();
    const { store: store2 } = await setupApp("/today", server);
    stores.push(store2);
    await act(async () => {
      await store2.sync();
    });
    await screen.findByRole("listbox", { name: "今日のボード" });

    cleanup();
    const { store: store3 } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store3);
    await act(async () => {
      await store3.sync();
    });
    await screen.findByRole("listbox", { name: "P" });
  });
});
