import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { formatKey } from "./keyboard/keys";
import stylesCss from "./styles.css?raw";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { pickerListbox, setupApp } from "./test/render-app";

/**
 * チケット16：優先度と工数の画面。チケットの「完了の条件」のうち、付け方・見せ方・工数の合計を、画面ごと確かめる
 * （並べ替えは flows-task-sort.test.tsx）。実装担当の priority-points.test.tsx と flows-field-keys.test.tsx の続きで、
 * そこで確かめていない道筋を見る。
 * - ⇧P・e のまとめて操作と ⌘Z、トーストの出し分け、完了済みのタスク、500 件、全角の数字、変換中のキー
 * - 開いたタスクのボタンと、カレンダー・タイムラインの小さな詳細のボタン
 * - 行とボードのカードの印（data-priority）と工数、カレンダーのマスとタイムラインの棒には出ないこと
 * - 今日・プロジェクトの見出しと、ボードの列の見出しの工数の合計
 * - ショートカットのページに ⇧P・e・並び方と、3つの候補の場面が出ること
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function open(path: string, server: FakeServer, listName?: string) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  if (listName !== undefined) await screen.findByRole("listbox", { name: listName });
  return setup;
}

async function settle(store: AppStore) {
  await act(async () => {
    await store.idle();
  });
}

function row(listName: string, title: string): HTMLElement {
  return within(screen.getByRole("listbox", { name: listName })).getByRole("option", {
    name: new RegExp(`^${title}`),
  });
}

/** 優先度の印と工数の数字（行の右側の項目。どちらも role=img） */
function marksIn(element: HTMLElement): HTMLElement[] {
  return within(element).queryAllByRole("img", { name: /^(優先度|工数) / });
}

/** 見出しの下の一行（「9月28日 月曜日 ・ 2 件 ・ 工数 3」） */
function subtitle(): string {
  return screen.getByText(/ 件/).textContent ?? "";
}

async function openPriority(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("{Shift>}P{/Shift}");
  return screen.findByRole("combobox", { name: "優先度" });
}

async function openPoints(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard("e");
  return screen.findByRole("combobox", { name: "工数" });
}

const pickerClosed = (name: "優先度" | "工数") =>
  waitFor(() => expect(screen.queryByRole("combobox", { name })).toBeNull());

describe("完了の条件1：⇧P と e で、1件にもまとめてにも付けられ、⌘Z で戻る", () => {
  it("e：2件まとめて付けると「2件の工数を3に」が出て、⌘Z でまとめて戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}");
    const input = await openPoints(user);
    expect(input).toHaveAttribute("placeholder", "2件の工数");
    await user.type(input, "3{Enter}");
    await pickerClosed("工数");

    expect(store.lists.today.map((task) => task.points)).toEqual([3, 3]);
    expect(screen.getAllByRole("img", { name: "工数 3" })).toHaveLength(2);
    expect((await screen.findAllByText("2件の工数を3に")).length).toBeGreaterThan(0);
    // 選択は2件のまま（行は一覧から抜けない）
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(2);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.map((task) => task.points)).toEqual([null, null]);
    expect(screen.queryAllByRole("img", { name: "工数 3" })).toHaveLength(0);
  });

  it("⇧P の 0・e の 0 でまとめて外すと「2件の優先度を外しました」「2件の工数を外しました」。⌘Z で元の値に戻る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "today", rank: "a0", priority: "high", points: 5 }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "today", rank: "a1", priority: "low", points: 8 }),
    );
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    const priorities = () => store.lists.today.map((task) => task.priority);
    const points = () => store.lists.today.map((task) => task.points);

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}");
    await openPriority(user);
    await user.keyboard("0");
    await pickerClosed("優先度");
    expect(priorities()).toEqual([null, null]);
    expect((await screen.findAllByText("2件の優先度を外しました")).length).toBeGreaterThan(0);
    await user.keyboard("{Meta>}z{/Meta}");
    expect(priorities()).toEqual(["high", "low"]);

    // ⌘Z のあとは、戻った行の1つだけが選ばれる（4 からの決まり）ので、選び直す
    await user.keyboard("{Escape}j{Shift>}{ArrowDown}{/Shift}");
    const input = await openPoints(user);
    await user.type(input, "0");
    expect(
      within(pickerListbox())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["なし"]);
    await user.keyboard("{Enter}");
    await pickerClosed("工数");
    expect(points()).toEqual([null, null]);
    expect((await screen.findAllByText("2件の工数を外しました")).length).toBeGreaterThan(0);
    await user.keyboard("{Meta>}z{/Meta}");
    expect(points()).toEqual([5, 8]);
    // 工数を戻しても、優先度は戻したままの値
    expect(priorities()).toEqual(["high", "low"]);
  });

  it("1件に付けても外しても、トーストは出ない（行の印が変わる）。⌘Z で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today", priority: "medium" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    const noToast = () => expect(screen.queryByText(/の(優先度|工数)を/)).toBeNull();

    await user.keyboard("j");
    await openPriority(user);
    await user.keyboard("1");
    await pickerClosed("優先度");
    await settle(store);
    expect(store.task(task.id)?.priority).toBe("high");
    expect(within(row("今日", "A")).getByRole("img", { name: "優先度 高" })).toBeInTheDocument();
    noToast();

    await openPriority(user);
    await user.keyboard("0");
    await pickerClosed("優先度");
    await settle(store);
    expect(store.task(task.id)?.priority).toBeNull();
    expect(marksIn(row("今日", "A"))).toHaveLength(0);
    noToast();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(task.id)?.priority).toBe("high");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(task.id)?.priority).toBe("medium");

    const input = await openPoints(user);
    await user.type(input, "5{Enter}");
    await pickerClosed("工数");
    await settle(store);
    expect(store.task(task.id)?.points).toBe(5);
    noToast();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(task.id)?.points).toBeNull();
  });

  it("2件のうち1件がすでにその値なら、変えるのは1件だけで、トーストは出ない。⌘Z はその1件だけを戻す", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0", priority: "high" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}");
    await openPriority(user);
    await user.keyboard("1");
    await pickerClosed("優先度");
    await settle(store);
    expect(store.lists.today.map((task) => task.priority)).toEqual(["high", "high"]);
    expect(screen.queryByText(/件の優先度を/)).toBeNull();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.map((task) => task.priority)).toEqual(["high", null]);
  });

  it("完了済みのタスク（今日の「完了 N件」）にも、⇧P と e で付けられる", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "済み", bucket: "today", completedAt: new Date().toISOString() }),
    );
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "完了 1件" }));
    await user.keyboard("j");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("済み");

    await openPriority(user);
    await user.keyboard("2");
    await pickerClosed("優先度");
    const input = await openPoints(user);
    await user.type(input, "8{Enter}");
    await pickerClosed("工数");

    expect(store.task(task.id)?.priority).toBe("medium");
    expect(store.task(task.id)?.points).toBe(8);
    expect(store.task(task.id)?.completedAt).not.toBeNull();
    const done = row("今日", "済み");
    expect(within(done).getByRole("img", { name: "優先度 中" })).toBeInTheDocument();
    expect(within(done).getByRole("img", { name: "工数 8" })).toBeInTheDocument();
  });

  it("選択が 500 件を超えると、⇧P も e も候補を開かずに「一度に扱えるのは 500 件まで」。500 件なら開いて付けられる", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 501; i++) {
      server.putTask(
        makeTask({
          title: `T${i}`,
          bucket: "inbox",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    const { store } = await open("/inbox", server, "受信箱");
    const user = userEvent.setup();
    const before = server.requestsTo("/api/mutate").length;

    await user.keyboard("j");
    const list = screen.getByRole("listbox", { name: "受信箱" });
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(501);

    await user.keyboard("{Shift>}P{/Shift}");
    await waitFor(() =>
      expect(screen.getAllByText("一度に扱えるのは 500 件まで").length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole("combobox", { name: "優先度" })).toBeNull();
    await user.keyboard("e");
    expect(screen.queryByRole("combobox", { name: "工数" })).toBeNull();
    await settle(store);
    expect(server.requestsTo("/api/mutate").length).toBe(before);

    // 一番下を外して 500 件にする
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(500);
    await openPriority(user);
    await user.keyboard("3");
    await pickerClosed("優先度");
    expect(store.lists.inbox.filter((task) => task.priority === "low")).toHaveLength(500);
    expect(await screen.findByText("500件の優先度を低に")).toBeInTheDocument();
  }, 30_000);
});

describe("候補の中のキー：全角の数字と、変換中のキー", () => {
  it("⇧P：全角の １・２・３・０ でも、その場で高・中・低・なしに決まる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("j");

    for (const [key, value] of [
      ["１", "high"],
      ["２", "medium"],
      ["３", "low"],
      ["０", null],
    ] as const) {
      const input = await openPriority(user);
      fireEvent.keyDown(input, { key });
      await pickerClosed("優先度");
      expect(store.task(task.id)?.priority).toBe(value);
    }
  });

  it("e：全角の数字でも絞り込まれる（「１」で 1 と 13、「１３」で 13 だけ、「０」でなし）", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    const options = () =>
      within(pickerListbox())
        .getAllByRole("option")
        .map((option) => option.textContent);
    await user.keyboard("j");

    let input = await openPoints(user);
    await user.type(input, "１");
    expect(options()).toEqual(["1", "13"]);
    await user.type(input, "３");
    expect(options()).toEqual(["13"]);
    await user.keyboard("{Enter}");
    await pickerClosed("工数");
    expect(store.task(task.id)?.points).toBe(13);

    input = await openPoints(user);
    await user.type(input, "０");
    expect(options()).toEqual(["なし"]);
    await user.keyboard("{Enter}");
    await pickerClosed("工数");
    expect(store.task(task.id)?.points).toBeNull();
  });

  it("e：合う候補のない数字（4 など）では候補が空になって案内が出る。Enter では何も変えずに閉じ、一覧へ戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today", points: 5 }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("j");

    const input = await openPoints(user);
    await user.type(input, "4");
    expect(within(pickerListbox()).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("1・2・3・5・8・13 か、0（なし）")).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await pickerClosed("工数");
    await settle(store);
    expect(store.task(task.id)?.points).toBe(5);
    expect(screen.getByRole("listbox", { name: "今日" })).toHaveFocus();
  });

  it.each([
    ["keyCode 229", { keyCode: 229, which: 229 }],
    ["isComposing だけが立つ", { keyCode: 13, which: 13, isComposing: true }],
  ])(
    "e：変換を確定する Enter（%s）では決まらない。確定したあとの Enter で決まる",
    async (_, init) => {
      const server = new FakeServer();
      const task = server.putTask(makeTask({ title: "A", bucket: "today" }));
      const { store } = await open("/today", server, "今日");
      const user = userEvent.setup();
      await user.keyboard("j");

      const input = await openPoints(user);
      await user.type(input, "5");
      fireEvent.keyDown(input, { key: "Enter", ...init });
      expect(store.task(task.id)?.points).toBeNull();
      expect(screen.getByRole("combobox", { name: "工数" })).toBeInTheDocument();

      await user.keyboard("{Enter}");
      await pickerClosed("工数");
      expect(store.task(task.id)?.points).toBe(5);
    },
  );

  it("⇧P：変換中のキー（数字・Enter）では決まらない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("j");

    const input = await openPriority(user);
    fireEvent.keyDown(input, { key: "1", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229, which: 229 });
    expect(store.task(task.id)?.priority).toBeNull();
    expect(screen.getByRole("combobox", { name: "優先度" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "1" });
    await pickerClosed("優先度");
    expect(store.task(task.id)?.priority).toBe("high");
  });
});

describe("開いたタスクのボタン", () => {
  it("優先度と工数のボタンから候補が開いて付けられ、ボタンの文字が変わり、フォーカスはボタンへ戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await open("/today", server, "今日");
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    await user.click(await screen.findByRole("button", { name: "優先度を付ける" }));
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("1");
    await pickerClosed("優先度");
    expect(store.task(task.id)?.priority).toBe("high");
    const priorityButton = screen.getByRole("button", { name: "優先度：高" });
    expect(priorityButton).toHaveFocus();
    expect(within(priorityButton).getByRole("img", { name: "優先度 高" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "工数を付ける" }));
    const input = await screen.findByRole("combobox", { name: "工数" });
    await user.type(input, "8{Enter}");
    await pickerClosed("工数");
    expect(store.task(task.id)?.points).toBe(8);
    expect(screen.getByRole("button", { name: "工数：8" })).toBeInTheDocument();

    // 付けた値は、ボタンからも外せる（0 でなし）
    await user.click(screen.getByRole("button", { name: "優先度：高" }));
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("0");
    await pickerClosed("優先度");
    expect(store.task(task.id)?.priority).toBeNull();
    expect(screen.getByRole("button", { name: "優先度を付ける" })).toBeInTheDocument();
  });
});

/** カレンダーとタイムラインは、9/27（日）の朝にしておく（flows-field-keys.test.tsx と同じ） */
async function openView(path: "/calendar" | "/timeline", server: FakeServer) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-27T10:00:00+09:00"));
  const setup = await open(path, server);
  if (path === "/calendar") await screen.findByText("2026年9月");
  else await screen.findByRole("region", { name: "タイムライン" });
  return setup;
}

function calendarCell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`td[data-date="${date}"]`);
  if (!found) throw new Error(`マス（${date}）が見つかりません`);
  return found;
}

/** 小さな詳細の中の優先度と工数のボタンから付ける（候補は小さな詳細から開き、決めても小さな詳細は開いたまま） */
async function setFromPopover(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement) {
  await user.click(within(dialog).getByRole("button", { name: "優先度を付ける" }));
  await screen.findByRole("combobox", { name: "優先度" });
  await user.keyboard("3");
  await pickerClosed("優先度");
  expect(dialog).toBeInTheDocument();
  expect(within(dialog).getByRole("button", { name: "優先度：低" })).toHaveFocus();

  await user.click(within(dialog).getByRole("button", { name: "工数を付ける" }));
  const input = await screen.findByRole("combobox", { name: "工数" });
  await user.type(input, "2{Enter}");
  await pickerClosed("工数");
  expect(within(dialog).getByRole("button", { name: "工数：2" })).toBeInTheDocument();
}

describe("カレンダーとタイムライン", () => {
  it("カレンダー：マスのタスクには印も工数も出ない。小さな詳細のボタンから付けられる", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "予定A",
        bucket: "scheduled",
        scheduledOn: "2026-09-30",
        priority: "high",
        points: 13,
      }),
    );
    server.putTask(
      makeTask({ title: "予定B", bucket: "scheduled", scheduledOn: "2026-10-01", points: 5 }),
    );
    const { store } = await openView("/calendar", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const cell = calendarCell("2026-09-30");
    const chip = within(cell).getByRole("button", { name: "予定A" });
    expect(marksIn(cell)).toHaveLength(0);
    expect(cell.querySelector(".priority-mark")).toBeNull();
    expect(within(cell).queryByText("13")).toBeNull();
    expect(within(calendarCell("2026-10-01")).queryByText("5")).toBeNull();
    expect(document.querySelectorAll(".priority-mark")).toHaveLength(0);

    await user.click(chip);
    const dialog = await screen.findByRole("dialog", { name: "「予定A」の詳細" });
    // 小さな詳細には、ほかの欄と同じく今の値のボタンが出る
    await user.click(within(dialog).getByRole("button", { name: "優先度：高" }));
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("0");
    await pickerClosed("優先度");
    await user.click(within(dialog).getByRole("button", { name: "工数：13" }));
    const input = await screen.findByRole("combobox", { name: "工数" });
    await user.type(input, "0{Enter}");
    await pickerClosed("工数");
    expect(store.task(task.id)?.priority).toBeNull();
    expect(store.task(task.id)?.points).toBeNull();

    await setFromPopover(user, dialog);
    expect(store.task(task.id)?.priority).toBe("low");
    expect(store.task(task.id)?.points).toBe(2);
    // 付けても、マスには出ない
    expect(marksIn(calendarCell("2026-09-30"))).toHaveLength(0);
  });

  it("タイムライン：棒には印も工数も出ない。小さな詳細のボタンから付けられる", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "棒",
        bucket: "scheduled",
        scheduledOn: "2026-10-05",
        deadlineOn: "2026-10-09",
        priority: "high",
        points: 8,
      }),
    );
    const { store } = await openView("/timeline", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    const region = screen.getByRole("region", { name: "タイムライン" });
    const bar = within(region).getByRole("button", { name: /^「棒」/ });
    expect(marksIn(region)).toHaveLength(0);
    expect(region.querySelector(".priority-mark")).toBeNull();
    expect(bar.textContent).not.toContain("8");

    await user.click(bar);
    const dialog = await screen.findByRole("dialog", { name: "「棒」の詳細" });
    expect(within(dialog).getByRole("button", { name: "優先度：高" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "工数：8" })).toBeInTheDocument();
    act(() => {
      store.actions.setPriority([task.id], null);
      store.actions.setPoints([task.id], null);
    });

    await setFromPopover(user, dialog);
    expect(store.task(task.id)?.priority).toBe("low");
    expect(store.task(task.id)?.points).toBe(2);
    expect(marksIn(screen.getByRole("region", { name: "タイムライン" }))).toHaveLength(0);
  });
});

describe("完了の条件2：行とボードのカードに、優先度の印と工数が出る", () => {
  const server = () => {
    const s = new FakeServer();
    s.putTask(makeTask({ title: "高", bucket: "today", rank: "a0", priority: "high", points: 13 }));
    s.putTask(
      makeTask({ title: "中", bucket: "today", rank: "a1", priority: "medium", points: 1 }),
    );
    s.putTask(makeTask({ title: "低", bucket: "today", rank: "a2", priority: "low" }));
    s.putTask(makeTask({ title: "工数だけ", bucket: "today", rank: "a3", points: 5 }));
    s.putTask(makeTask({ title: "なし", bucket: "today", rank: "a4" }));
    return s;
  };

  /** 印（data-priority）と工数を確かめる。container は行かカード */
  function expectMarks(container: HTMLElement, priority: string | null, points: number | null) {
    const mark = within(container).queryByRole("img", { name: /^優先度 / });
    if (priority === null) expect(mark).toBeNull();
    else {
      expect(mark).toHaveAttribute("data-priority", priority);
      expect(mark).toHaveClass("priority-mark");
    }
    const value = within(container).queryByRole("img", { name: /^工数 / });
    if (points === null) expect(value).toBeNull();
    else {
      expect(value).toHaveAccessibleName(`工数 ${points}`);
      expect(value).toHaveTextContent(String(points));
    }
  }

  const EXPECTED = [
    ["高", "high", 13],
    ["中", "medium", 1],
    ["低", "low", null],
    ["工数だけ", null, 5],
    ["なし", null, null],
  ] as const;

  it("行：高・中・低の印（data-priority）と工数の数字が出る。なしなら出ない", async () => {
    await open("/today", server(), "今日");
    for (const [title, priority, points] of EXPECTED) {
      expectMarks(row("今日", title), priority, points);
    }
    expect(screen.getByRole("img", { name: "優先度 高" })).toHaveAttribute("title", "優先度 高");
    expect(screen.getByRole("img", { name: "優先度 中" })).toHaveAttribute("title", "優先度 中");
    expect(screen.getByRole("img", { name: "優先度 低" })).toHaveAttribute("title", "優先度 低");
  });

  it("今日のボードのカード（完了の列を含む）にも出て、付け外しで変わる", async () => {
    const s = server();
    s.putTask(
      makeTask({
        title: "済み",
        bucket: "today",
        priority: "high",
        points: 3,
        completedAt: new Date().toISOString(),
      }),
    );
    const { store } = await open("/today", s, "今日");
    const user = userEvent.setup();
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });
    const card = (title: string) =>
      within(board).getByRole("option", { name: new RegExp(`^${title}`) });

    for (const [title, priority, points] of EXPECTED) expectMarks(card(title), priority, points);
    expectMarks(card("済み"), "high", 3);

    // 一番上のカード（高）を外すと、印と工数が消える
    await user.keyboard("j");
    await openPriority(user);
    await user.keyboard("0");
    await pickerClosed("優先度");
    const input = await openPoints(user);
    await user.type(input, "0{Enter}");
    await pickerClosed("工数");
    expectMarks(card("高"), null, null);
    await user.keyboard("{Meta>}z{/Meta}");
    expectMarks(card("高"), null, 13);
    expect(store.lists.today[0]?.priority).toBeNull();
  });

  it("プロジェクトのボードのカードにも出る（予定・受信箱のまとまりのカードにも）", async () => {
    const s = new FakeServer();
    const project = s.putProject(makeProject({ name: "P" }));
    s.putTask(
      makeTask({
        title: "予定の",
        bucket: "scheduled",
        scheduledOn: "2099-01-01",
        projectId: project.id,
        priority: "medium",
        points: 2,
      }),
    );
    s.putTask(
      makeTask({ title: "受信箱の", bucket: "inbox", projectId: project.id, priority: "low" }),
    );
    await open(`/projects/${project.id}`, s, "P");
    const user = userEvent.setup();
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "Pのボード" });
    const card = (title: string) =>
      within(board).getByRole("option", { name: new RegExp(`^${title}`) });
    expectMarks(card("予定の"), "medium", 2);
    expectMarks(card("受信箱の"), "low", null);
  });

  it("色：高は琥珀（目を向けてほしい印のトークン --attention）、中と低は置いた場所の控えめな灰のまま。赤（締切超過の色）は使わない", () => {
    const rules = [...stylesCss.matchAll(/\.priority-mark[^{]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThanOrEqual(4);
    const body = (selector: string) => {
      const found = rules.find(
        (rule) => rule.startsWith(`${selector} {`) || rule.startsWith(`${selector}{`),
      );
      if (!found) throw new Error(`${selector} が見つかりません`);
      return found;
    };
    expect(body('.priority-mark[data-priority="high"]')).toMatch(/color:\s*var\(--attention\)/);
    expect(stylesCss).toMatch(/--attention:\s*#fbbf24/);
    for (const level of ["medium", "low"]) {
      expect(body(`.priority-mark[data-priority="${level}"]`)).not.toMatch(/(^|[\s;{])color:/);
    }
    for (const rule of rules) expect(rule).not.toMatch(/destructive|red/);
  });
});

describe("完了の条件3：今日とプロジェクトの見出し、ボードの列に工数の合計が出て、付け外しで変わる", () => {
  it("今日の見出し：工数のあるタスクだけを数え、付けると増え、外すと減り、完了すると減る。なければ工数を出さない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0", points: 3 }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    // 完了済みの工数は数えない
    server.putTask(
      makeTask({
        title: "済み",
        bucket: "today",
        points: 8,
        completedAt: new Date().toISOString(),
      }),
    );
    await open("/today", server, "今日");
    const user = userEvent.setup();
    expect(subtitle()).toMatch(/・ 2 件 ・ 工数 3$/);

    await user.keyboard("jj");
    let input = await openPoints(user);
    await user.type(input, "5{Enter}");
    await pickerClosed("工数");
    expect(subtitle()).toMatch(/・ 2 件 ・ 工数 8$/);

    await user.keyboard("k");
    input = await openPoints(user);
    await user.type(input, "0{Enter}");
    await pickerClosed("工数");
    expect(subtitle()).toMatch(/・ 2 件 ・ 工数 5$/);

    // B（工数 5）を完了すると、件数も工数も減る。工数のあるタスクがなくなれば工数は出ない
    await user.keyboard("jx");
    await waitFor(() => expect(subtitle()).toMatch(/・ 1 件$/));
    expect(subtitle()).not.toContain("工数");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(subtitle()).toMatch(/・ 2 件 ・ 工数 5$/);
  });

  it("プロジェクトの見出し：「N 件 ・ 工数 M」。今日・予定・あとで・受信箱の工数を数え（完了は数えない）、付け外しで変わる", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const projectId = project.id;
    server.putTask(makeTask({ title: "今日の", bucket: "today", projectId, points: 2 }));
    server.putTask(
      makeTask({
        title: "予定の",
        bucket: "scheduled",
        scheduledOn: "2099-01-01",
        projectId,
        points: 3,
      }),
    );
    server.putTask(makeTask({ title: "あとでの", bucket: "later", projectId, points: 5 }));
    server.putTask(makeTask({ title: "受信箱の", bucket: "inbox", projectId }));
    server.putTask(
      makeTask({
        title: "済み",
        bucket: "later",
        projectId,
        points: 8,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await open(`/projects/${projectId}`, server, "P");
    const user = userEvent.setup();
    expect(subtitle()).toBe("4 件 ・ 工数 10");

    // 一番下の受信箱の行に 1 を付ける
    await user.keyboard("k");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("受信箱の");
    let input = await openPoints(user);
    await user.type(input, "1{Enter}");
    await pickerClosed("工数");
    expect(subtitle()).toBe("4 件 ・ 工数 11");

    // あとでの行（工数 5）を外す
    await user.keyboard("k");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("あとでの");
    input = await openPoints(user);
    await user.type(input, "0{Enter}");
    await pickerClosed("工数");
    expect(subtitle()).toBe("4 件 ・ 工数 6");
  });

  it("今日のボードの列の見出し：列ごとの合計（0 なら出さない）。付け外しと列の移動で変わる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "未着手A", bucket: "today", rank: "a0", points: 3 }));
    server.putTask(makeTask({ title: "未着手B", bucket: "today", rank: "a1" }));
    server.putTask(
      makeTask({
        title: "進行中",
        bucket: "today",
        rank: "a2",
        points: 5,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "済み",
        bucket: "today",
        points: 8,
        completedAt: new Date().toISOString(),
      }),
    );
    await open("/today", server, "今日");
    const user = userEvent.setup();
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });
    const columnPoints = (label: string) => {
      const column = within(board).getByRole("group", { name: label });
      return within(column).queryByText(/^・ 工数/)?.textContent ?? null;
    };
    expect(columnPoints("未着手")).toBe("・ 工数 3");
    expect(columnPoints("進行中")).toBe("・ 工数 5");
    expect(columnPoints("完了")).toBe("・ 工数 8");

    // 未着手A を外すと、未着手の列には工数が出ない
    await user.keyboard("j");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("未着手A");
    let input = await openPoints(user);
    await user.type(input, "0{Enter}");
    await pickerClosed("工数");
    expect(columnPoints("未着手")).toBeNull();

    // 未着手B に 13 を付ける
    await user.keyboard("j");
    input = await openPoints(user);
    await user.type(input, "13{Enter}");
    await pickerClosed("工数");
    expect(columnPoints("未着手")).toBe("・ 工数 13");

    // 進行中のカードを完了すると、進行中の列から完了の列へ合計が移る
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("進行中");
    await user.keyboard("x");
    await waitFor(() => expect(columnPoints("進行中")).toBeNull());
    expect(columnPoints("完了")).toBe("・ 工数 13");
  });

  it("プロジェクトのボードの列の見出し：未着手の列は今日・予定・あとで・受信箱の合計、完了の列は直近 7 日の合計", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const projectId = project.id;
    server.putTask(makeTask({ title: "今日の", bucket: "today", projectId, points: 1 }));
    server.putTask(
      makeTask({
        title: "予定の",
        bucket: "scheduled",
        scheduledOn: "2099-01-01",
        projectId,
        points: 2,
      }),
    );
    server.putTask(makeTask({ title: "あとでの", bucket: "later", projectId, points: 3 }));
    server.putTask(makeTask({ title: "受信箱の", bucket: "inbox", projectId, points: 5 }));
    server.putTask(
      makeTask({
        title: "進行中",
        bucket: "today",
        projectId,
        points: 8,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "最近の済み",
        bucket: "later",
        projectId,
        points: 13,
        completedAt: new Date().toISOString(),
      }),
    );
    server.putTask(
      makeTask({
        title: "古い済み",
        bucket: "later",
        projectId,
        points: 13,
        completedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await open(`/projects/${projectId}`, server, "P");
    const user = userEvent.setup();
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "Pのボード" });
    const columnPoints = (label: string) => {
      const column = within(board).getByRole("group", { name: label });
      return within(column).queryByText(/^・ 工数/)?.textContent ?? null;
    };
    expect(columnPoints("未着手")).toBe("・ 工数 11");
    expect(columnPoints("進行中")).toBe("・ 工数 8");
    expect(columnPoints("完了")).toBe("・ 工数 13");
  });
});

describe("ショートカットのページ", () => {
  it("⇧P・e が「タスク」に、並び方の4つが「リスト」に（効く画面と「キーなし」付きで）、3つの候補の場面が一番下に出る", async () => {
    const server = new FakeServer();
    await open("/shortcuts", server);
    await screen.findByRole("heading", { name: "ショートカット" });
    const rowIn = (region: HTMLElement, label: string) => {
      const found = within(region)
        .getAllByRole("listitem")
        .find((item) => item.firstElementChild?.textContent === label);
      if (!found) throw new Error(`「${label}」の行が見つかりません`);
      return found;
    };

    const tasks = screen.getByRole("region", { name: "タスク" });
    expect(within(rowIn(tasks, "優先度")).getByText(formatKey("Shift+p"))).toBeInTheDocument();
    expect(formatKey("Shift+p")).toBe("⇧P");
    expect(within(rowIn(tasks, "工数")).getByText(formatKey("e"))).toBeInTheDocument();

    const lists = screen.getByRole("region", { name: "リスト" });
    for (const name of ["手動", "優先度", "工数が少ない順", "工数が多い順"]) {
      const item = rowIn(lists, `並び方：${name}`);
      expect(within(item).getByText("キーなし")).toBeInTheDocument();
      expect(within(item).getByText("今日・あとで・プロジェクト")).toBeInTheDocument();
    }

    const bottom = screen.getByRole("region", { name: "候補や欄の中" });
    const scene = (name: string) => within(bottom).getByRole("region", { name });
    const keysOf = (region: HTMLElement, label: string) =>
      Array.from(rowIn(region, label).querySelectorAll("kbd"), (kbd) => kbd.textContent);

    const priority = scene("優先度の候補（⇧P）");
    expect(keysOf(priority, "その場で決める（1 高・2 中・3 低・0 なし）")).toEqual([
      "1",
      "2",
      "3",
      "0",
    ]);
    expect(rowIn(priority, "やめる")).toHaveTextContent(formatKey("Escape"));

    const points = scene("工数の候補（e）");
    expect(keysOf(points, "数字で絞り込む（13 は 1・3、0 でなし）")).toEqual([
      "1",
      "2",
      "3",
      "5",
      "8",
      "0",
    ]);
    expect(rowIn(points, "決める")).toHaveTextContent(formatKey("Enter"));

    const sort = scene("並び方の一覧");
    expect(
      keysOf(sort, "その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）"),
    ).toEqual(["1", "2", "3", "4"]);
  });
});
