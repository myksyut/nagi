import type { Task } from "@shared/model";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { pickerListbox, setupApp } from "./test/render-app";

/**
 * チケット16：並び方（features/sort）。チケットの「完了の条件」の「並び方を切り替えると決まりどおりに並び、
 * 手動に戻すと元の並びになる。手動以外では ⌥↑↓ が止まる」を、画面ごと確かめる。
 * 実装担当の priority-points.test.tsx（今日の優先度と ⌥↓）の続きで、そこで確かめていない道筋を見る。
 * - 今日・あとで・プロジェクト・ボードでの、優先度・工数が少ない順・工数が多い順の並び（値のないものは最後、同じ値の中は手動の順）
 * - 並べ替えるのは手で並べ替えられるまとまりだけ（受信箱・予定・完了のまとまりはそのまま）
 * - 選択（↑↓・⇧↑↓・完了のあとの次の行）は表示の並びのとおり。優先度を変えて位置が変わっても、選択はその行に残る
 * - 手動に戻すと元の並び。rank は書き換えない（サーバーへ rank を送らない）
 * - ⌥↑↓ と同じまとまりの中へのドラッグは止めて知らせる。ほかのリストや列へのドラッグは止めない
 * - 画面ごとに覚え（今日とプロジェクトはリストとボードで同じ）、再読み込みしても残る。⌘K の「並び方：◯◯」
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

type SortName = "手動" | "優先度" | "工数が少ない順" | "工数が多い順";

const MANUAL_ONLY = "手動の並びのときに使えます";

async function open(path: string, server: FakeServer, listName: string) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  await screen.findByRole("listbox", { name: listName });
  return setup;
}

async function settle(store: AppStore) {
  await act(async () => {
    await store.idle();
  });
}

function sortButton(): HTMLElement {
  return screen.getByRole("button", { name: /^並び：/ });
}

/** 見出しの「並び：◯◯」を押して、一覧から選ぶ（クリック） */
async function chooseSort(user: ReturnType<typeof userEvent.setup>, name: SortName) {
  await user.click(sortButton());
  await screen.findByRole("combobox", { name: "並び方" });
  await user.click(within(pickerListbox()).getByRole("option", { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "並び方" })).toBeNull());
  expect(sortButton()).toHaveAccessibleName(`並び：${name}`);
}

/**
 * container の中の行（option）を、上から出ている順にタイトルで。行の文字には工数の数字なども続くので、
 * 知っているタイトルのうち、行の文字の頭に合う一番長いものにする
 */
function order(container: HTMLElement, titles: readonly string[]): string[] {
  return within(container)
    .queryAllByRole("option")
    .map((option) => {
      const text = option.textContent ?? "";
      const found = titles
        .filter((title) => text.startsWith(title))
        .sort((a, b) => b.length - a.length)[0];
      if (found === undefined) throw new Error(`知らない行：${text}`);
      return found;
    });
}

function list(name: string): HTMLElement {
  return screen.getByRole("listbox", { name });
}

function selectedTitles(titles: readonly string[]): string[] {
  const selected = screen.getAllByRole("option", { selected: true });
  const container = document.createElement("div");
  for (const option of selected) container.append(option.cloneNode(true));
  return order(container, titles);
}

/** 今日の6件（手動の順は A〜F）。優先度と工数の組み合わせで、どの並び方でも順が変わるように */
const TODAY_TASKS: readonly Partial<Task>[] = [
  { title: "A", priority: "low", points: 3 },
  { title: "B", priority: null, points: null },
  { title: "C", priority: "high", points: 8 },
  { title: "D", priority: "medium", points: 3 },
  { title: "E", priority: "high", points: null },
  { title: "F", priority: null, points: 1 },
];
const TODAY_TITLES = TODAY_TASKS.map((task) => task.title ?? "");

/** 並び方ごとの、TODAY_TASKS の表示の順 */
const TODAY_ORDER: Record<SortName, readonly string[]> = {
  手動: ["A", "B", "C", "D", "E", "F"],
  // 高・中・低・なし。同じ優先度の中は手動の順
  優先度: ["C", "E", "D", "A", "B", "F"],
  // 工数のないものは最後。同じ工数の中は手動の順
  工数が少ない順: ["F", "A", "D", "C", "B", "E"],
  工数が多い順: ["C", "A", "D", "F", "B", "E"],
};

function todayServer(): FakeServer {
  const server = new FakeServer();
  for (const [i, task] of TODAY_TASKS.entries()) {
    server.putTask(makeTask({ ...task, bucket: "today", rank: `a${i}` }));
  }
  return server;
}

describe("完了の条件4：並び方を切り替えると決まりどおりに並び、手動に戻すと元の並び", () => {
  it("今日：優先度・工数が少ない順・工数が多い順のどれでも決まりどおりに並び、手動に戻すと元の並び", async () => {
    await open("/today", todayServer(), "今日");
    const user = userEvent.setup();
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.手動);

    for (const name of ["優先度", "工数が少ない順", "工数が多い順", "手動"] as const) {
      await chooseSort(user, name);
      await waitFor(() => expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER[name]));
    }
  });

  it("あとで：プロジェクトごとのまとまりの中だけで並び、まとまりの順と見出しは変わらない", async () => {
    const server = new FakeServer();
    const p = server.putProject(makeProject({ name: "P", createdAt: "2026-01-01T00:00:00.000Z" }));
    const q = server.putProject(makeProject({ name: "Q", createdAt: "2026-01-02T00:00:00.000Z" }));
    const tasks: Partial<Task>[] = [
      { title: "N1", points: 2 },
      { title: "N2", priority: "high" },
      { title: "P1", projectId: p.id, priority: "low", points: 3 },
      { title: "P2", projectId: p.id, priority: "high", points: 13 },
      { title: "P3", projectId: p.id },
      { title: "Q1", projectId: q.id, points: 1 },
      { title: "Q2", projectId: q.id, priority: "medium", points: 5 },
    ];
    for (const [i, task] of tasks.entries()) {
      server.putTask(makeTask({ ...task, bucket: "later", rank: `a${i}` }));
    }
    const titles = tasks.map((task) => task.title ?? "");
    await open("/later", server, "あとで");
    const user = userEvent.setup();
    const headings = () =>
      within(list("あとで"))
        .getAllByRole("heading")
        .map((heading) => heading.textContent);
    expect(order(list("あとで"), titles)).toEqual(["N1", "N2", "P1", "P2", "P3", "Q1", "Q2"]);
    expect(headings()).toEqual(["P", "Q"]);

    await chooseSort(user, "優先度");
    await waitFor(() =>
      expect(order(list("あとで"), titles)).toEqual(["N2", "N1", "P2", "P1", "P3", "Q2", "Q1"]),
    );
    expect(headings()).toEqual(["P", "Q"]);
    await chooseSort(user, "工数が少ない順");
    await waitFor(() =>
      expect(order(list("あとで"), titles)).toEqual(["N1", "N2", "P1", "P2", "P3", "Q1", "Q2"]),
    );
    await chooseSort(user, "工数が多い順");
    await waitFor(() =>
      expect(order(list("あとで"), titles)).toEqual(["N1", "N2", "P2", "P1", "P3", "Q2", "Q1"]),
    );
    expect(headings()).toEqual(["P", "Q"]);
    await chooseSort(user, "手動");
    await waitFor(() =>
      expect(order(list("あとで"), titles)).toEqual(["N1", "N2", "P1", "P2", "P3", "Q1", "Q2"]),
    );
  });

  it("ボード：今日のボードの未着手と進行中の列の中で並び、完了の列はそのまま。リストと同じ並び方を使う", async () => {
    const server = new FakeServer();
    const tasks: Partial<Task>[] = [
      { title: "未1", points: 5 },
      { title: "未2", priority: "high", points: 1 },
      { title: "未3", priority: "medium" },
      { title: "進1", startedAt: "2026-01-01T00:00:00.000Z" },
      { title: "進2", startedAt: "2026-01-01T00:00:00.000Z", priority: "low", points: 8 },
    ];
    for (const [i, task] of tasks.entries()) {
      server.putTask(makeTask({ ...task, bucket: "today", rank: `a${i}` }));
    }
    // 完了の列は、完了した新しい順（済1 が新しい）。並び方では変わらない
    server.putTask(
      makeTask({
        title: "済1",
        bucket: "today",
        points: 1,
        completedAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    server.putTask(
      makeTask({
        title: "済2",
        bucket: "today",
        priority: "high",
        points: 13,
        completedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const titles = [...tasks.map((task) => task.title ?? ""), "済1", "済2"];
    await open("/today", server, "今日");
    const user = userEvent.setup();

    // リストで選んだ並び方が、ボードでもそのまま使われる
    await chooseSort(user, "優先度");
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });
    const column = (label: string) => within(board).getByRole("group", { name: label });
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    expect(order(column("未着手"), titles)).toEqual(["未2", "未3", "未1"]);
    expect(order(column("進行中"), titles)).toEqual(["進2", "進1"]);
    expect(order(column("完了"), titles)).toEqual(["済1", "済2"]);

    await chooseSort(user, "工数が多い順");
    await waitFor(() => expect(order(column("未着手"), titles)).toEqual(["未1", "未2", "未3"]));
    expect(order(column("進行中"), titles)).toEqual(["進2", "進1"]);
    expect(order(column("完了"), titles)).toEqual(["済1", "済2"]);
    await chooseSort(user, "工数が少ない順");
    await waitFor(() => expect(order(column("未着手"), titles)).toEqual(["未2", "未1", "未3"]));
    expect(order(column("完了"), titles)).toEqual(["済1", "済2"]);

    // ボードで選んだ並び方が、リストに戻ってもそのまま
    await user.keyboard("v");
    await screen.findByRole("listbox", { name: "今日" });
    expect(sortButton()).toHaveAccessibleName("並び：工数が少ない順");
    expect(order(list("今日"), titles)).toEqual(["未2", "未1", "進2", "未3", "進1"]);
  });
});

describe("並べ替えるのは、手で並べ替えられるまとまりだけ", () => {
  /** プロジェクト P：今日・予定・あとで・受信箱・完了のまとまりに2件ずつ。どれも手動の順と優先度・工数の順が逆 */
  function projectServer() {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const projectId = project.id;
    const put = (task: Partial<Task>) => server.putTask(makeTask({ projectId, ...task }));
    put({ title: "今日1", bucket: "today", rank: "a0", priority: "low", points: 1 });
    put({ title: "今日2", bucket: "today", rank: "a1", priority: "high", points: 8 });
    // 予定は日付の順
    put({ title: "予定1", bucket: "scheduled", scheduledOn: "2099-01-01", points: 1 });
    put({
      title: "予定2",
      bucket: "scheduled",
      scheduledOn: "2099-02-01",
      priority: "high",
      points: 13,
    });
    put({ title: "あとで1", bucket: "later", rank: "a0", points: 5 });
    put({ title: "あとで2", bucket: "later", rank: "a1", priority: "medium", points: 2 });
    // 受信箱は届いた順
    put({ title: "受信1", bucket: "inbox", createdAt: "2026-01-01T00:00:00.000Z", points: 1 });
    put({
      title: "受信2",
      bucket: "inbox",
      createdAt: "2026-01-02T00:00:00.000Z",
      priority: "high",
      points: 13,
    });
    // 完了は完了した新しい順
    put({
      title: "済1",
      bucket: "later",
      completedAt: "2026-01-02T00:00:00.000Z",
      points: 1,
    });
    put({
      title: "済2",
      bucket: "later",
      completedAt: "2026-01-01T00:00:00.000Z",
      priority: "high",
      points: 13,
    });
    return { server, project };
  }
  const PROJECT_TITLES = [
    "今日1",
    "今日2",
    "予定1",
    "予定2",
    "あとで1",
    "あとで2",
    "受信1",
    "受信2",
    "済1",
    "済2",
  ];

  it("プロジェクトの画面：今日・あとでのまとまりの中だけ並び、予定（日付順）・受信箱（届いた順）・完了はどの並び方でもそのまま", async () => {
    const { server, project } = projectServer();
    await open(`/projects/${project.id}`, server, "P");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "完了 2件" }));
    const manual = [
      "今日1",
      "今日2",
      "予定1",
      "予定2",
      "あとで1",
      "あとで2",
      "受信1",
      "受信2",
      "済1",
      "済2",
    ];
    expect(order(list("P"), PROJECT_TITLES)).toEqual(manual);

    const expected: Record<SortName, readonly string[]> = {
      手動: manual,
      優先度: [
        "今日2",
        "今日1",
        "予定1",
        "予定2",
        "あとで2",
        "あとで1",
        "受信1",
        "受信2",
        "済1",
        "済2",
      ],
      工数が少ない順: [
        "今日1",
        "今日2",
        "予定1",
        "予定2",
        "あとで2",
        "あとで1",
        "受信1",
        "受信2",
        "済1",
        "済2",
      ],
      工数が多い順: [
        "今日2",
        "今日1",
        "予定1",
        "予定2",
        "あとで1",
        "あとで2",
        "受信1",
        "受信2",
        "済1",
        "済2",
      ],
    };
    for (const name of ["優先度", "工数が多い順", "工数が少ない順", "手動"] as const) {
      await chooseSort(user, name);
      await waitFor(() => expect(order(list("P"), PROJECT_TITLES)).toEqual(expected[name]));
    }
  });

  it("プロジェクトのボード：未着手の列の今日・あとでのまとまりの中だけ並び、予定・受信箱・完了はそのまま", async () => {
    const { server, project } = projectServer();
    await open(`/projects/${project.id}`, server, "P");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "Pのボード" });
    const column = (label: string) => within(board).getByRole("group", { name: label });
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    expect(order(column("未着手"), PROJECT_TITLES)).toEqual([
      "今日2",
      "今日1",
      "予定1",
      "予定2",
      "あとで2",
      "あとで1",
      "受信1",
      "受信2",
    ]);
  });

  it("今日の「完了 N件」は、どの並び方でもそのまま（完了した新しい順）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "未", bucket: "today" }));
    server.putTask(
      makeTask({
        title: "済1",
        bucket: "today",
        points: 1,
        completedAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    server.putTask(
      makeTask({
        title: "済2",
        bucket: "today",
        priority: "high",
        points: 13,
        completedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    );
    const titles = ["未", "済1", "済2"];
    await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "完了 2件" }));
    expect(order(list("今日"), titles)).toEqual(["未", "済1", "済2"]);
    for (const name of ["優先度", "工数が多い順", "工数が少ない順"] as const) {
      await chooseSort(user, name);
      expect(order(list("今日"), titles)).toEqual(["未", "済1", "済2"]);
    }
  });

  it("受信箱・予定・完了ログには並び方の切り替えがなく、⌘K にも「並び方」は出ない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信", bucket: "inbox", priority: "high" }));
    server.putTask(
      makeTask({ title: "予定", bucket: "scheduled", scheduledOn: "2099-01-01", points: 3 }),
    );
    const { location } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    for (const [key, name] of [
      ["1", "受信箱"],
      ["3", "予定"],
      ["5", "完了ログ"],
    ] as const) {
      await user.keyboard(key);
      await screen.findByRole("heading", { name, level: 1 });
      expect(screen.queryByRole("button", { name: /^並び：/ })).toBeNull();
      await user.keyboard("{Meta>}k{/Meta}");
      const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
      await user.type(input, "並び方");
      expect(screen.queryAllByRole("option")).toHaveLength(0);
      await user.keyboard("{Escape}");
      await waitFor(() =>
        expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
      );
    }
    expect(location.history?.at(-1)).toBe("/logbook");
  });
});

describe("並べ替えと選択：表示の並びのとおりに動く", () => {
  it("↑↓・⇧↑↓ は表示の並びのとおり", async () => {
    await open("/today", todayServer(), "今日");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    // 表示は C E D A B F（手動は A B C D E F）
    await user.keyboard("j");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["C"]);
    await user.keyboard("jj");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["D"]);
    await user.keyboard("k");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["E"]);
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["E", "D", "A"]);
    // 一番下から ↑ で上へ
    await user.keyboard("{Escape}k");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]);
  });

  it("完了したあとは、表示の並びで次の行へ", async () => {
    const { store } = await open("/today", todayServer(), "今日");
    const user = userEvent.setup();
    await chooseSort(user, "工数が多い順");
    // 表示は C A D F B E。D を完了すると、次は F（手動の順なら E）
    await user.keyboard("jjj");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["D"]);
    await user.keyboard("x");
    await waitFor(() => expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]));
    expect(store.lists.today.map((task) => task.title)).toEqual(["A", "B", "C", "E", "F"]);
  });

  it("⇧P・e で値を変えて行の位置が変わっても、選択はその行に残り、↓ は新しい位置の次へ。⌘Z で戻っても選ばれたまま", async () => {
    await open("/today", todayServer(), "今日");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    // 表示 C E D A B F の一番下の F を高にすると、C E F D A B
    await user.keyboard("k");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]);
    await user.keyboard("{Shift>}P{/Shift}");
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("1");
    await waitFor(() =>
      expect(order(list("今日"), TODAY_TITLES)).toEqual(["C", "E", "F", "D", "A", "B"]),
    );
    expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]);
    await user.keyboard("j");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["D"]);

    // ⌘Z で F が一番下に戻り、F が選ばれる
    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.優先度));
    expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]);

    // 工数が少ない順（F A D C B E）で B に 1 を付けると、同じ工数 1 の中は手動の順なので B F A D C E。
    // 選択は B のまま、↓ で F
    await chooseSort(user, "工数が少ない順");
    await user.keyboard("{Escape}jjjjj");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["B"]);
    await user.keyboard("e");
    const input = await screen.findByRole("combobox", { name: "工数" });
    await user.type(input, "1{Enter}");
    await waitFor(() =>
      expect(order(list("今日"), TODAY_TITLES)).toEqual(["B", "F", "A", "D", "C", "E"]),
    );
    expect(selectedTitles(TODAY_TITLES)).toEqual(["B"]);
    await user.keyboard("j");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["F"]);
  });
});

/** 送った変更のうち、rank を含むもの */
function rankMutations(server: FakeServer): unknown[] {
  return server.requestsTo("/api/mutate").flatMap((request) => {
    const body = request.body as { mutations?: { changes?: object; task?: object }[] };
    return (body.mutations ?? []).filter(
      (mutation) => mutation.changes !== undefined && "rank" in mutation.changes,
    );
  });
}

describe("手動に戻すと元の並び。rank は書き換えない", () => {
  it("並び方を切り替えても、サーバーへは何も送らず、rank は変わらない", async () => {
    const server = todayServer();
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    const ranks = () => store.lists.today.map((task) => `${task.title}:${task.rank}`);
    const before = ranks();
    const requests = server.requestsTo("/api/mutate").length;

    for (const name of ["優先度", "工数が少ない順", "工数が多い順", "手動"] as const) {
      await chooseSort(user, name);
    }
    await settle(store);
    expect(server.requestsTo("/api/mutate").length).toBe(requests);
    expect(ranks()).toEqual(before);
    expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.手動);
  });

  it("並べているあいだに ⇧P・e で付けても、送るのは優先度と工数だけ。手動に戻すと rank の順", async () => {
    const server = todayServer();
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    const before = store.lists.today.map((task) => task.rank);

    await chooseSort(user, "優先度");
    // 一番下の F を高に、その次に選ぶ D に 13 を付ける
    await user.keyboard("k{Shift>}P{/Shift}");
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("1");
    await user.keyboard("j");
    expect(selectedTitles(TODAY_TITLES)).toEqual(["D"]);
    await user.keyboard("e");
    const input = await screen.findByRole("combobox", { name: "工数" });
    await user.type(input, "13{Enter}");
    await settle(store);

    const mutations = server.requestsTo("/api/mutate").flatMap((request) => {
      const body = request.body as { mutations: { type: string; changes?: object }[] };
      return body.mutations;
    });
    expect(mutations.length).toBeGreaterThanOrEqual(2);
    for (const mutation of mutations) {
      expect(mutation.type).toBe("task.update");
      for (const key of Object.keys(mutation.changes ?? {})) {
        expect(["priority", "points"]).toContain(key);
      }
    }
    expect(rankMutations(server)).toEqual([]);
    expect(store.lists.today.map((task) => task.rank)).toEqual(before);

    await chooseSort(user, "手動");
    await waitFor(() => expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.手動));
  });
});

/** happy-dom の DragEvent は clientY を init から受け取らないので、イベントに直接乗せて配る（flows-reorder-dnd と同じ） */
function dragOverWithY(el: Element, clientY: number) {
  const event = new Event("dragover", { bubbles: true, cancelable: true }) as unknown as Event & {
    clientY: number;
    dataTransfer: unknown;
  };
  event.clientY = clientY;
  event.dataTransfer = {};
  fireEvent(el, event);
}

function optionByTitle(container: HTMLElement, title: string): HTMLElement {
  return within(container).getByRole("option", { name: new RegExp(`^${title}`) });
}

describe("手動以外では ⌥↑↓ とドラッグの並べ替えが止まる", () => {
  it("あとで：⌥↑↓ は止まって「手動の並びのときに使えます」と出る。何も送らない。手動に戻すとまた効く", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(
        makeTask({ title, bucket: "later", rank: `a${i}`, points: i === 0 ? 5 : null }),
      );
    }
    const { store } = await open("/later", server, "あとで");
    const user = userEvent.setup();
    const titles = ["A", "B", "C"];
    await chooseSort(user, "工数が多い順");
    const requests = server.requestsTo("/api/mutate").length;

    await user.keyboard("jj");
    expect(selectedTitles(titles)).toEqual(["B"]);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect((await screen.findAllByText(MANUAL_ONLY)).length).toBeGreaterThan(0);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await settle(store);
    expect(server.requestsTo("/api/mutate").length).toBe(requests);
    expect(store.lists.later.map((task) => task.title)).toEqual(["A", "B", "C"]);

    await chooseSort(user, "手動");
    await user.keyboard("{Escape}jj{Alt>}{ArrowDown}{/Alt}");
    expect(order(list("あとで"), titles)).toEqual(["A", "C", "B"]);
    expect(store.lists.later.map((task) => task.title)).toEqual(["A", "C", "B"]);
  });

  it("プロジェクトの画面：今日・あとでのまとまりの ⌥↑↓ は止まる", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    server.putTask(
      makeTask({ title: "今日1", bucket: "today", rank: "a0", projectId: project.id }),
    );
    server.putTask(
      makeTask({ title: "今日2", bucket: "today", rank: "a1", projectId: project.id }),
    );
    const { store } = await open(`/projects/${project.id}`, server, "P");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}");
    expect((await screen.findAllByText(MANUAL_ONLY)).length).toBeGreaterThan(0);
    expect(store.lists.project(project.id).today.map((task) => task.title)).toEqual([
      "今日1",
      "今日2",
    ]);
  });

  it("リスト：並べ替えて見せているあいだは、同じまとまりの行の上を運んでも落とし先の線を出さない（手動なら出る）", async () => {
    await open("/today", todayServer(), "今日");
    const user = userEvent.setup();
    /** 行の落とし先の線（task-item.tsx。前か後ろに出る細い線） */
    const dropLines = () => list("今日").querySelectorAll("span.bg-primary-text");

    // 手動：A を C の上へ運ぶと、C の前に線が出る
    const a = optionByTitle(list("今日"), "A");
    fireEvent.dragStart(a);
    dragOverWithY(optionByTitle(list("今日"), "C"), -10);
    expect(dropLines()).toHaveLength(1);
    fireEvent.dragEnd(a);
    expect(dropLines()).toHaveLength(0);

    // 優先度で並べているあいだは、線を出さない
    await chooseSort(user, "優先度");
    const again = optionByTitle(list("今日"), "A");
    fireEvent.dragStart(again);
    dragOverWithY(optionByTitle(list("今日"), "C"), -10);
    expect(dropLines()).toHaveLength(0);
    fireEvent.dragEnd(again);
  });

  it("リスト：同じまとまりの中へのドラッグは並べ替えずに知らせる。サイドバーの「あとで」へのドラッグは止まらない", async () => {
    const server = todayServer();
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    const requests = server.requestsTo("/api/mutate").length;

    // 表示 C E D A B F。A を C の前へ落とす
    const a = optionByTitle(list("今日"), "A");
    const c = optionByTitle(list("今日"), "C");
    fireEvent.dragStart(a);
    dragOverWithY(c, -10);
    fireEvent.drop(c);
    fireEvent.dragEnd(a);
    expect((await screen.findAllByText(MANUAL_ONLY)).length).toBeGreaterThan(0);
    expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.優先度);
    await settle(store);
    expect(server.requestsTo("/api/mutate").length).toBe(requests);
    expect(store.lists.today.map((task) => task.title)).toEqual(TODAY_ORDER.手動);

    // 同じまとまりの行の上を通ってから、サイドバーの「あとで」へ落とすと移る
    const b = optionByTitle(list("今日"), "B");
    fireEvent.dragStart(b);
    dragOverWithY(optionByTitle(list("今日"), "E"), 10);
    const later = screen.getByRole("link", { name: "あとで" });
    fireEvent.dragOver(later);
    fireEvent.drop(later);
    fireEvent.dragEnd(b);
    expect(store.lists.later.map((task) => task.title)).toEqual(["B"]);
    expect(order(list("今日"), TODAY_TITLES)).toEqual(["C", "E", "D", "A", "F"]);
  });

  it("ボード：同じ列の中へのドラッグと ⌥↑↓ は止まって知らせる。ほかの列へのドラッグは状態が変わる", async () => {
    const server = todayServer();
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await chooseSort(user, "優先度");
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });
    const column = (label: string) => within(board).getByRole("group", { name: label });
    expect(order(column("未着手"), TODAY_TITLES)).toEqual(TODAY_ORDER.優先度);

    // 同じ列のカードの上へ落とす
    const a = optionByTitle(board, "A");
    fireEvent.dragStart(a);
    dragOverWithY(optionByTitle(board, "C"), -10);
    fireEvent.drop(optionByTitle(board, "C"));
    fireEvent.dragEnd(a);
    expect((await screen.findAllByText(MANUAL_ONLY)).length).toBeGreaterThan(0);
    expect(order(column("未着手"), TODAY_TITLES)).toEqual(TODAY_ORDER.優先度);
    expect(store.lists.today.map((task) => task.title)).toEqual(TODAY_ORDER.手動);

    // ⌥↓ も止まる
    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}");
    await settle(store);
    expect(store.lists.today.map((task) => task.title)).toEqual(TODAY_ORDER.手動);
    expect(rankMutations(server)).toEqual([]);

    // 同じ列のカードの上を通ってから、進行中の列のカードの上へ落とすと進行中になる
    const b = optionByTitle(board, "B");
    fireEvent.dragStart(b);
    dragOverWithY(optionByTitle(board, "E"), 10);
    fireEvent.dragEnter(column("進行中"));
    fireEvent.dragOver(column("進行中"));
    fireEvent.drop(column("進行中"));
    fireEvent.dragEnd(b);
    await waitFor(() =>
      expect(store.lists.today.find((task) => task.title === "B")?.startedAt).not.toBeNull(),
    );
    expect(order(column("進行中"), TODAY_TITLES)).toEqual(["B"]);
  });
});

describe("画面ごとに覚える（再読み込みしても残る）", () => {
  it("今日・あとで・プロジェクトで別々に覚え、再読み込み（新しいストアと画面）でも残る。受信箱には効かない", async () => {
    const server = todayServer();
    const project = server.putProject(makeProject({ name: "P" }));
    server.putTask(
      makeTask({ title: "P1", bucket: "later", rank: "a0", projectId: project.id, points: 1 }),
    );
    server.putTask(
      makeTask({ title: "P2", bucket: "later", rank: "a1", projectId: project.id, points: 8 }),
    );
    const first = await open("/today", server, "今日");
    const user = userEvent.setup();

    await chooseSort(user, "優先度");
    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    await chooseSort(user, "工数が多い順");
    await act(async () => first.location.navigate(`/projects/${project.id}`));
    await screen.findByRole("listbox", { name: "P" });
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    await chooseSort(user, "工数が少ない順");
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      today: "priority",
      later: "points-desc",
      [`project:${project.id}`]: "points-asc",
    });

    // 再読み込み：画面とストアを作り直す（localStorage はそのまま）
    cleanup();
    for (const store of stores.splice(0)) store.dispose();
    const second = await open("/today", server, "今日");
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.優先度);
    // リストとボードで同じ
    await user.keyboard("v");
    await screen.findByRole("listbox", { name: "今日のボード" });
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    await user.keyboard("v");
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(sortButton()).toHaveAccessibleName("並び：工数が多い順");
    expect(order(list("あとで"), ["P1", "P2"])).toEqual(["P2", "P1"]);
    await act(async () => second.location.navigate(`/projects/${project.id}`));
    await screen.findByRole("listbox", { name: "P" });
    expect(sortButton()).toHaveAccessibleName("並び：工数が少ない順");
    expect(order(list("P"), ["P1", "P2"])).toEqual(["P1", "P2"]);
  });

  it("覚えた値が壊れていても、手動として開ける（知らない並び方は捨てる）", async () => {
    localStorage.setItem(
      "nagi:task-sorts",
      JSON.stringify({ today: "random", later: "points-desc" }),
    );
    await open("/today", todayServer(), "今日");
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.手動);

    cleanup();
    for (const store of stores.splice(0)) store.dispose();
    localStorage.setItem("nagi:task-sorts", "{not json");
    await open("/today", todayServer(), "今日");
    expect(sortButton()).toHaveAccessibleName("並び：手動");
  });
});

describe("⌘K の「並び方：◯◯」", () => {
  async function runFromPalette(user: ReturnType<typeof userEvent.setup>, label: string) {
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "並び方");
    const options = screen.getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "並び方：手動",
      "並び方：優先度",
      "並び方：工数が少ない順",
      "並び方：工数が多い順",
    ]);
    // キーのない操作なので、キーは出ない
    for (const option of options) expect(option.querySelector("kbd")).toBeNull();
    const target = options.find((option) => option.textContent === label);
    if (!target) throw new Error(`⌘K に「${label}」が見つかりません`);
    await user.click(target);
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
    );
  }

  it("今日のリストとボードで選ぶと、並びと見出しのボタンが変わり、覚える", async () => {
    await open("/today", todayServer(), "今日");
    const user = userEvent.setup();

    await runFromPalette(user, "並び方：工数が多い順");
    expect(sortButton()).toHaveAccessibleName("並び：工数が多い順");
    await waitFor(() =>
      expect(order(list("今日"), TODAY_TITLES)).toEqual(TODAY_ORDER.工数が多い順),
    );
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      today: "points-desc",
    });

    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });
    await runFromPalette(user, "並び方：優先度");
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    const notStarted = within(board).getByRole("group", { name: "未着手" });
    await waitFor(() => expect(order(notStarted, TODAY_TITLES)).toEqual(TODAY_ORDER.優先度));

    await runFromPalette(user, "並び方：手動");
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    await waitFor(() => expect(order(notStarted, TODAY_TITLES)).toEqual(TODAY_ORDER.手動));
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({});
  });

  it("あとでとプロジェクトの画面でも効き、その画面の並び方だけを変える", async () => {
    const server = todayServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const { location } = await open("/later", server, "あとで");
    const user = userEvent.setup();

    await runFromPalette(user, "並び方：工数が少ない順");
    expect(sortButton()).toHaveAccessibleName("並び：工数が少ない順");
    await act(async () => location.navigate(`/projects/${project.id}`));
    await screen.findByRole("heading", { name: "P" });
    expect(sortButton()).toHaveAccessibleName("並び：手動");
    await runFromPalette(user, "並び方：優先度");
    expect(sortButton()).toHaveAccessibleName("並び：優先度");
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      later: "points-asc",
      [`project:${project.id}`]: "priority",
    });
  });
});
