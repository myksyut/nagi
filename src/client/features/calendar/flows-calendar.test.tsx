import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeProject, makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";
import { CELL_CAPACITY } from "./calendar-screen";

/**
 * チケット13：カレンダー（features/calendar）。チケットの「完了の条件」ごとに describe を分ける。
 * 今日は 2026-09-28（月曜）に固定する（ほかのテストと同じ基準日。9/27 が日曜という既存の事実から、
 * 2026年9月の月の表は 8/30(日)〜10/3(土) の5週になる）
 */

const TODAY = "2026-09-28";

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function openCalendar(server = new FakeServer()) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${TODAY}T10:00:00+09:00`));
  const { store, location } = await setupApp("/calendar", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByText("2026年9月");
  return { store, server, location };
}

function cell(date: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`td[data-date="${date}"]`);
  if (!found) throw new Error(`マス（${date}）が見つかりません`);
  return found;
}

function dragTaskTo(chip: HTMLElement, targetDate: string): void {
  fireEvent.dragStart(chip);
  fireEvent.drop(cell(targetDate));
  fireEvent.dragEnd(chip);
}

describe("完了の条件1：予定・締切・今日のタスクが正しい日のマスに出る。月をまたいでも正しい", () => {
  it("予定は予定の日付、今日のタスクは今日、未完了の締切は◆で締切の日に出る。完了・締切なしの受信箱とあとでは出ない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "予定A", bucket: "scheduled", scheduledOn: "2026-09-30" }));
    server.putTask(makeTask({ title: "今日タスク", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "締切受信箱", bucket: "inbox", deadlineOn: "2026-09-15" }));
    server.putTask(makeTask({ title: "締切あとで", bucket: "later", deadlineOn: "2026-09-20" }));
    server.putTask(
      makeTask({
        title: "締切完了",
        bucket: "later",
        deadlineOn: "2026-09-22",
        completedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    server.putTask(makeTask({ title: "締切なし受信箱", bucket: "inbox" }));
    server.putTask(makeTask({ title: "締切なしあとで", bucket: "later" }));
    await openCalendar(server);

    expect(within(cell("2026-09-30")).getByRole("button", { name: "予定A" })).toBeInTheDocument();
    expect(within(cell(TODAY)).getByRole("button", { name: "今日タスク" })).toBeInTheDocument();
    expect(
      within(cell("2026-09-15")).getByRole("button", { name: "締切 締切受信箱" }),
    ).toBeInTheDocument();
    expect(
      within(cell("2026-09-20")).getByRole("button", { name: "締切 締切あとで" }),
    ).toBeInTheDocument();

    expect(screen.queryByText("締切完了")).toBeNull();
    expect(screen.queryByText("締切なし受信箱")).toBeNull();
    expect(screen.queryByText("締切なしあとで")).toBeNull();
  });

  it("前後の月の日（表の最初と最後の週）にも正しく出る", async () => {
    const server = new FakeServer();
    // 9月の表は 8/30(日) 〜 10/3(土)
    server.putTask(makeTask({ title: "先月分", bucket: "scheduled", scheduledOn: "2026-08-30" }));
    server.putTask(makeTask({ title: "来月分", bucket: "scheduled", scheduledOn: "2026-10-03" }));
    await openCalendar(server);

    expect(within(cell("2026-08-30")).getByRole("button", { name: "先月分" })).toBeInTheDocument();
    expect(within(cell("2026-10-03")).getByRole("button", { name: "来月分" })).toBeInTheDocument();
  });

  it("「次の月」「前の月」「今日」で表が替わり、その月の予定が出る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "10月の予定", bucket: "scheduled", scheduledOn: "2026-10-15" }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar(server);

    await user.click(screen.getByRole("button", { name: "次の月" }));
    expect(screen.getByText("2026年10月")).toBeInTheDocument();
    expect(
      within(cell("2026-10-15")).getByRole("button", { name: "10月の予定" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "今日" }));
    expect(screen.getByText("2026年9月")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "前の月" }));
    expect(screen.getByText("2026年8月")).toBeInTheDocument();
  });

  it("3件を超えると「ほか N 件」が出て、押すとその日のタスクが一覧で開く", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["T1", "T2", "T3", "T4"].entries()) {
      server.putTask(
        makeTask({ title, bucket: "scheduled", scheduledOn: "2026-09-30", rank: `a${i}` }),
      );
    }
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar(server);

    const target = cell("2026-09-30");
    expect(within(target).queryAllByRole("button", { name: /^T\d$/ })).toHaveLength(
      CELL_CAPACITY - 1,
    );
    const more = within(target).getByRole("button", { name: "ほか 2 件" });
    await user.click(more);

    const popup = await screen.findByRole("dialog", { name: /のタスク$/ });
    expect(within(popup).getAllByRole("button", { name: /^T\d$/ })).toHaveLength(4);
  });

  it("あとでのタスクの締切だけを変えると、その場でマスの中身が変わる（項目ごとの観測）", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "あとで締切", bucket: "later", deadlineOn: "2026-09-10" }),
    );
    const { store } = await openCalendar(server);

    expect(
      within(cell("2026-09-10")).getByRole("button", { name: "締切 あとで締切" }),
    ).toBeInTheDocument();

    act(() => {
      // 今日より先の日付にする（今日以前だと⇧D と同じ決まりで今日へ移ってしまうため）
      store.actions.setDeadline([task.id], "2026-09-30");
    });

    expect(within(cell("2026-09-10")).queryByText("あとで締切")).toBeNull();
    expect(
      within(cell("2026-09-30")).getByRole("button", { name: "締切 あとで締切" }),
    ).toBeInTheDocument();
    // 「あとで」の並びは締切では変わらない（bucket は変えない操作なため）
    expect(store.lists.later.map((t) => t.title)).toEqual(["あとで締切"]);
  });

  it("予定のタスクの予定の日付を、並びが変わらない範囲で変えても、その場でマスの中身が変わる", async () => {
    const server = new FakeServer();
    const a = server.putTask(
      makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2026-09-30", rank: "a0" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "scheduled", scheduledOn: "2026-10-02", rank: "a1" }),
    );
    const { store } = await openCalendar(server);

    expect(within(cell("2026-09-30")).getByRole("button", { name: "A" })).toBeInTheDocument();

    act(() => {
      // 今日より先の日付どうしで動かす（今日以前だと今日へ移ってしまうため）
      store.actions.moveTasks([a.id], { bucket: "scheduled", on: "2026-10-01" });
    });

    // 予定の並び（rank 順）は変わらない
    expect(store.lists.scheduled.map((t) => t.title)).toEqual(["A", "B"]);
    expect(within(cell("2026-09-30")).queryByText("A")).toBeNull();
    expect(within(cell("2026-10-01")).getByRole("button", { name: "A" })).toBeInTheDocument();
  });
});

describe("完了の条件2：ドラッグで予定・締切が変わる。過去なら今日へ。⌘Z で戻る", () => {
  it("今日のタスクを未来の日へドラッグすると、その日の予定になる。⌘Z で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "今日タスク", bucket: "today", rank: "a0" }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar(server);

    const chip = within(cell(TODAY)).getByRole("button", { name: "今日タスク" });
    dragTaskTo(chip, "2026-09-30");

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("scheduled"));
    expect(store.task(task.id)?.scheduledOn).toBe("2026-09-30");
    expect(
      within(cell("2026-09-30")).getByRole("button", { name: "今日タスク" }),
    ).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(store.task(task.id)?.scheduledOn).toBeNull();
  });

  it("予定のタスクを過去の日へドラッグすると、今日へ入る。⌘Z で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "予定タスク", bucket: "scheduled", scheduledOn: "2026-09-10" }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar(server);

    const chip = within(cell("2026-09-10")).getByRole("button", { name: "予定タスク" });
    dragTaskTo(chip, "2026-09-15"); // 過去（今日は 9/28）

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(store.task(task.id)?.scheduledOn).toBeNull();
    expect(within(cell(TODAY)).getByRole("button", { name: "予定タスク" })).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("scheduled"));
    expect(store.task(task.id)?.scheduledOn).toBe("2026-09-10");
  });

  it("◆を別の日へドラッグすると締切だけが変わる（置き場は変わらない）。⌘Z で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "今日の締切", bucket: "today", rank: "a0", deadlineOn: "2026-09-15" }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar(server);

    const chip = within(cell("2026-09-15")).getByRole("button", { name: "締切 今日の締切" });
    dragTaskTo(chip, "2026-09-18");

    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2026-09-18"));
    expect(store.task(task.id)?.bucket).toBe("today");
    expect(
      within(cell("2026-09-18")).getByRole("button", { name: "締切 今日の締切" }),
    ).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2026-09-15"));
  });

  it("予定・あとでのタスクの◆を今日以前へドラッグすると、⇧D と同じく今日へ移る。⌘Z で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "あとでの締切", bucket: "later", deadlineOn: "2026-09-30" }),
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar(server);

    const chip = within(cell("2026-09-30")).getByRole("button", { name: "締切 あとでの締切" });
    dragTaskTo(chip, "2026-09-20"); // 今日（9/28）以前

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-09-20");
    // 今日に来たので、締切の◆ではなく今日のタスクとしてマスに出る
    expect(within(cell(TODAY)).getByRole("button", { name: "あとでの締切" })).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("later"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-09-30");
  });
});

describe("完了の条件3：プロジェクトで絞り込める", () => {
  it("すべて・各プロジェクト・プロジェクトなしで、マスの中身が変わる", async () => {
    const server = new FakeServer();
    const p1 = server.putProject(makeProject({ name: "P1" }));
    const p2 = server.putProject(makeProject({ name: "P2" }));
    server.putTask(
      makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2026-09-10", projectId: p1.id }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "scheduled", scheduledOn: "2026-09-10", projectId: p2.id }),
    );
    server.putTask(makeTask({ title: "C", bucket: "scheduled", scheduledOn: "2026-09-10" }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar(server);

    const target = cell("2026-09-10");
    expect(within(target).getAllByRole("button", { name: /^[ABC]$/ })).toHaveLength(3);

    await user.click(
      screen.getByRole("button", { name: "プロジェクトで絞り込む：すべてのプロジェクト" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "P1" }));
    expect(
      within(target)
        .getAllByRole("button", { name: /^[ABC]$/ })
        .map((el) => el.textContent),
    ).toEqual(["A"]);

    await user.click(screen.getByRole("button", { name: "プロジェクトで絞り込む：P1" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "プロジェクトなし" }));
    expect(
      within(target)
        .getAllByRole("button", { name: /^[ABC]$/ })
        .map((el) => el.textContent),
    ).toEqual(["C"]);
  });

  it("絞り込み中に日のマスの「＋」から追加すると、そのプロジェクトが付く", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P1" }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar(server);

    await user.click(
      screen.getByRole("button", { name: "プロジェクトで絞り込む：すべてのプロジェクト" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "P1" }));

    const target = cell("2026-09-30");
    await user.hover(target);
    await user.click(within(target).getByRole("button", { name: /に追加$/ }));
    const input = await screen.findByRole("textbox", { name: /に追加$/ });
    await user.type(input, "絞り込み中に追加{Enter}");

    await waitFor(() =>
      expect(store.lists.scheduled.some((t) => t.title === "絞り込み中に追加")).toBe(true),
    );
    const added = store.lists.scheduled.find((t) => t.title === "絞り込み中に追加");
    expect(added?.projectId).toBe(project.id);
  });
});

describe("完了の条件4：日のマスの「＋」から、その日の予定として追加できる", () => {
  it("未来の日なら予定（その日付）へ、⌘Z 1回で消える", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar();

    const target = cell("2026-09-30");
    await user.hover(target);
    // 「＋」の名前は日付そのまま（「9月30日(水)に追加」）。開いた欄の入力の名前も未来の日は同じ
    const addButton = within(target).getByRole("button", { name: "9月30日(水)に追加" });
    await user.click(addButton);
    const input = await screen.findByRole("textbox", { name: "9月30日(水)に追加" });
    await user.type(input, "未来の予定{Enter}");

    await waitFor(() =>
      expect(
        within(cell("2026-09-30")).queryByRole("button", { name: "未来の予定" }),
      ).not.toBeNull(),
    );
    expect(store.lists.scheduled.find((t) => t.title === "未来の予定")?.scheduledOn).toBe(
      "2026-09-30",
    );

    // 欄が data-keymap="off" の中にあるあいだは⌘Zが効かないので、閉じてから戻す
    await user.keyboard("{Escape}");
    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() =>
      expect(store.lists.scheduled.some((t) => t.title === "未来の予定")).toBe(false),
    );
  });

  it("今日なら今日へ入る", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar();

    const target = cell(TODAY);
    await user.hover(target);
    // 「＋」の名前は日付そのまま（「9月28日(月)に追加」）だが、開いた欄の入力の名前は「今日に追加」
    const addButton = within(target).getByRole("button", { name: "9月28日(月)に追加" });
    await user.click(addButton);
    const input = await screen.findByRole("textbox", { name: "今日に追加" });
    await user.type(input, "今日の予定{Enter}");

    await waitFor(() => expect(store.lists.today.some((t) => t.title === "今日の予定")).toBe(true));
    expect(store.lists.today.find((t) => t.title === "今日の予定")?.scheduledOn).toBeNull();
  });

  it("過去の日には「＋」が出ない", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar();

    const target = cell("2026-09-20"); // 今日（9/28）より前
    await user.hover(target);
    expect(within(target).queryByRole("button", { name: /に追加$/ })).toBeNull();
  });
});

describe("完了の条件5：右下の「＋」と n では小さな追加欄が開く。初めは受信箱、切り替えると今日へ", () => {
  it("n で「受信箱に追加」の欄が開き、切り替えると「今日に追加」になる。追加するとトーストが出る", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await openCalendar();

    await user.keyboard("n");
    const input = await screen.findByRole("textbox", { name: "受信箱に追加" });
    await user.type(input, "受信箱行き{Enter}");
    expect(await screen.findByText("受信箱に追加しました")).toBeInTheDocument();
    expect(store.lists.inbox.some((t) => t.title === "受信箱行き")).toBe(true);

    await user.click(screen.getByRole("radio", { name: "今日" }));
    await user.type(screen.getByRole("textbox", { name: "今日に追加" }), "今日行き{Enter}");
    expect(await screen.findByText("今日に追加しました")).toBeInTheDocument();
    expect(store.lists.today.some((t) => t.title === "今日行き")).toBe(true);
  });

  it("Esc で閉じる", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar();

    await user.keyboard("n");
    await screen.findByRole("textbox", { name: "受信箱に追加" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "受信箱に追加" })).toBeNull());
  });

  it("一覧の画面（今日）では、これまでどおり一覧の追加欄が開く", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { location } = await openCalendar();

    act(() => location.navigate("/today"));
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("n");
    const input = await screen.findByRole("textbox", { name: "今日に追加" });
    // 一覧の追加欄は小さな追加欄のポップオーバーではなく、一覧の行として開く
    expect(input.closest("[data-keymap='off']")).toBeNull();
  });
});

describe("完了の条件6：その他（6・[ ]・⌘K）", () => {
  it("6 でカレンダーが開く", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T10:00:00+09:00`));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { store } = await setupApp("/today", new FakeServer());
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("6");
    expect(await screen.findByText("2026年9月")).toBeInTheDocument();
  });

  it("[ ] で前後の月へ移る", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar();

    await user.keyboard("]");
    expect(screen.getByText("2026年10月")).toBeInTheDocument();
    // userEvent の keyboard() では [ が特殊記法の開始なので、二重にして文字そのものとして打つ
    await user.keyboard("[[");
    await user.keyboard("[[");
    expect(screen.getByText("2026年8月")).toBeInTheDocument();
  });

  it("⌘K に「前の月へ」「次の月へ」「追加（カレンダー・タイムライン）」が出て実行できる", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await openCalendar();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "次の月へ{Enter}");
    expect(screen.getByText("2026年10月")).toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(screen.getByRole("combobox", { name: "検索とコマンド" }), "前の月へ{Enter}");
    expect(screen.getByText("2026年9月")).toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      screen.getByRole("combobox", { name: "検索とコマンド" }),
      "追加（カレンダー・タイムライン）{Enter}",
    );
    expect(await screen.findByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
  });
});
