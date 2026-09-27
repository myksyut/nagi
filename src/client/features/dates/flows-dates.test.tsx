import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { optionTitles, setupApp } from "@/test/render-app";
import { RolloverFakeServer } from "./rollover-fake-server";

/**
 * チケット5：日付の入力・d・⇧D・締切の表示・予定のまとまり。
 * 完了の条件（チケットの「完了の条件」）は、それぞれ対応する it() に書いてある
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe("日付の入力の手触り（d と ⇧D で共通）", () => {
  it("打つと解釈した日付がその場で出る。Enter で決定、読めないと出ない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    expect(document.activeElement).toBe(input);

    await user.type(input, "来週月曜");
    expect(screen.getByText("→ 10月5日(月)")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "xyz");
    expect(screen.getByText("日付として読めません")).toBeInTheDocument();

    // 読み取れないときの Enter は何もしない（開いたまま）
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "来週月曜{Enter}");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2026-10-05");
  });

  it("Esc でやめると一覧（listbox）にフォーカスが戻る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "来週月曜");
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("listbox", { name: "受信箱" }));
    // 予定へは移らず、受信箱に残る
    expect(optionTitles("受信箱")).toEqual(["A"]);
  });

  it("変換中の Enter（isComposing・keyCode 229）では決めない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "来週月曜");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toBeInTheDocument();

    // 変換中でない Enter では決まる
    await user.keyboard("{Enter}");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2026-10-05");
  });

  it("カレンダーのクリックでも決まる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    await screen.findByRole("textbox", { name: "予定の日付" });
    await user.click(screen.getByRole("button", { name: "2026年10月2日金曜日" }));

    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2026-10-02");
  });

  it("締切は空のまま Enter で外せる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "later", deadlineOn: "2026-10-10" }));
    const { store } = await setupApp("/later", server);
    stores.push(store);
    await screen.findByRole("listbox", { name: "あとで" });

    await user.keyboard("j");
    await user.keyboard("{Shift>}D{/Shift}");
    await screen.findByRole("textbox", { name: "締切" });
    expect(screen.getByText(/締切 10月10日\(土\)・空のまま Enter で外す/)).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("textbox", { name: "締切" })).toBeNull();
    expect(store.lists.later[0]?.deadlineOn).toBeNull();
  });
});

describe("d：予定へ移す", () => {
  it("今日か過去の日付なら今日の一番下（印なし）へ入る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜 = 今日
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "既存", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "今日{Enter}");

    expect(store.lists.today.map((t) => t.title)).toEqual(["既存", "A"]);
    const moved = store.lists.today.find((t) => t.title === "A");
    expect(moved && store.lists.isArrivedToday(moved)).toBe(false);

    // 過去の日付でも同じく今日へ
    server.putTask(makeTask({ title: "B", bucket: "inbox" }));
    await act(async () => {
      await store.sync();
    });
    await user.keyboard("j");
    await user.keyboard("d");
    const input2 = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input2, "2026-09-01{Enter}");
    const past = store.lists.today.find((t) => t.title === "B");
    expect(past?.scheduledOn).toBeNull();
    expect(past?.bucket).toBe("today");
  });

  it("受信箱で決めると受信箱から抜け、選択が次へ移り「「A」を10月5日(月)へ」のトーストが出る。⌘Z で戻る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "inbox", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "inbox", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j"); // A を選ぶ
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "来週月曜{Enter}");

    expect(optionTitles("受信箱")).toEqual(["B"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
    expect(await screen.findByText("「A」を10月5日(月)へ")).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["A", "B"]);
  });
});

describe("予定：日付ごとのまとまり、t・l・d で置き場を変える", () => {
  it("見出しは今日・明日・M/D(曜)。日付を d で変えると見出しが変わる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00+09:00")); // 日曜 = 今日
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "明日の分", bucket: "scheduled", scheduledOn: "2026-09-28" }));
    server.putTask(makeTask({ title: "金曜の分", bucket: "scheduled", scheduledOn: "2026-10-02" }));
    const { store } = await setupApp("/upcoming", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const list = await screen.findByRole("listbox", { name: "予定" });
    const headings = within(list).getAllByRole("heading");
    expect(headings.map((h) => h.textContent)).toEqual(["明日", "10/2(金)"]);

    await user.keyboard("j"); // 明日の分を選ぶ
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "10/2{Enter}");

    const headings2 = within(screen.getByRole("listbox", { name: "予定" })).getAllByRole("heading");
    expect(headings2.map((h) => h.textContent)).toEqual(["10/2(金)"]);
    expect(optionTitles("予定")).toEqual(["金曜の分", "明日の分"]);
  });

  it("予定にあるタスクを t・l で今日・あとでへ移せる", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2026-09-28", rank: "a0" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "scheduled", scheduledOn: "2026-09-28", rank: "a1" }),
    );
    const { store } = await setupApp("/upcoming", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "予定" });

    await user.keyboard("j");
    await user.keyboard("t");
    expect(optionTitles("予定")).toEqual(["B"]);
    expect(store.lists.today.map((t) => t.title)).toEqual(["A"]);

    await user.keyboard("l");
    expect(optionTitles("予定")).toEqual([]);
    expect(store.lists.later.map((t) => t.title)).toEqual(["B"]);
  });
});

describe("開いたタスクの小さなボタン", () => {
  it("「いつやる：予定 …」「締切 …／締切を付ける」の名前で、押すと日付の入力が開く", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2026-10-05" }));
    const { store } = await setupApp("/upcoming", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "予定" });

    await user.keyboard("j{Enter}");
    expect(screen.getByRole("button", { name: "いつやる：予定 10/5(月)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "締切を付ける" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "締切を付ける" }));
    const deadlineInput = await screen.findByRole("textbox", { name: "締切" });
    await user.type(deadlineInput, "10/2{Enter}");
    expect(store.lists.scheduled[0]?.deadlineOn).toBe("2026-10-02");
    expect(screen.getByRole("button", { name: "締切 10/2(金)" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "いつやる：予定 10/5(月)" }));
    const scheduleInput = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(scheduleInput, "xyz");
    expect(screen.getByText("日付として読めません")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    // タスクの詳細は開いたまま
    expect(screen.getByRole("button", { name: "締切 10/2(金)" })).toBeInTheDocument();
  });
});

describe("⇧D：締切を付ける・外す", () => {
  it("予定・あとでのタスクに今日以前の締切を付けると、すぐ今日の一番上へ印付きで移る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜 = 今日
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "既存", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "later", rank: "a1" }));
    const { store } = await setupApp("/later", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "あとで" });

    await user.keyboard("j");
    await user.keyboard("{Shift>}D{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "今日{Enter}");

    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "既存"]);
    const arrived = store.lists.today.find((t) => t.title === "B");
    expect(arrived && store.lists.isArrivedToday(arrived)).toBe(true);
    expect(arrived?.deadlineOn).toBe("2026-09-28");

    await user.keyboard("2");
    await screen.findByRole("listbox", { name: "今日" });
    expect(screen.getByRole("img", { name: "今日来たタスク" })).toBeInTheDocument();
    expect(screen.getByText("今日まで")).toBeInTheDocument();
  });

  it("予定のタスクにも同じく働く", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2026-10-05", rank: "a0" }),
    );
    const { store } = await setupApp("/upcoming", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "予定" });

    await user.keyboard("j");
    await user.keyboard("{Shift>}D{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "今日{Enter}");

    expect(store.lists.today.map((t) => t.title)).toEqual(["A"]);
    expect(store.lists.today[0]?.scheduledOn).toBeNull();
    const arrived = store.lists.today[0];
    expect(arrived && store.lists.isArrivedToday(arrived)).toBe(true);
  });

  it("受信箱のタスクでは動かない。締切だけ付いて受信箱に残る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("{Shift>}D{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "今日{Enter}");

    expect(store.lists.inbox.map((t) => t.title)).toEqual(["A"]);
    expect(store.lists.inbox[0]?.deadlineOn).toBe("2026-09-28");
    expect(screen.getByText("今日まで")).toBeInTheDocument();
  });

  it("今日にすでにあるタスクに今日以前の締切を付けても、位置は変えない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("jj"); // B を選ぶ
    await user.keyboard("{Shift>}D{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "今日{Enter}");

    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "B"]);
    const changed = store.lists.today.find((t) => t.title === "B");
    expect(changed && store.lists.isArrivedToday(changed)).toBe(false);
  });

  it("付け外しできる（空で Enter、「締切を外す」ボタンの両方）", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "later" }));
    const { store } = await setupApp("/later", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "あとで" });

    await user.keyboard("j");
    await user.keyboard("{Shift>}D{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "10/10{Enter}");
    expect(store.lists.later[0]?.deadlineOn).toBe("2026-10-10");

    // 空で Enter → 外れる
    await user.keyboard("{Shift>}D{/Shift}");
    await screen.findByRole("textbox", { name: "締切" });
    await user.keyboard("{Enter}");
    expect(store.lists.later[0]?.deadlineOn).toBeNull();

    // 開いたタスクの「締切を外す」ボタンからも
    await user.keyboard("{Enter}"); // タスクを開く
    await user.click(screen.getByRole("button", { name: "締切を付ける" }));
    const deadlineInput = await screen.findByRole("textbox", { name: "締切" });
    await user.type(deadlineInput, "10/10{Enter}");
    await user.click(screen.getByRole("button", { name: "締切 10/10(土)" }));
    await user.click(await screen.findByRole("button", { name: "締切を外す" }));
    expect(store.lists.later[0]?.deadlineOn).toBeNull();
    expect(screen.queryByRole("button", { name: "締切を外す" })).toBeNull();
  });

  it("行の表示の4段階すべてが出し分けられ、色も切り替わる。日付が変わるたびに段階が進む", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let current = new Date("2026-09-27T10:00:00+09:00"); // 日曜 = 今日。締切はここから4日先の 10/1
    vi.setSystemTime(current);
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0", deadlineOn: "2026-10-01" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    // setTimeout を偽にしているあいだは findBy*（内部で setTimeout を使う）が進まないので、
    // act で待ったあとは getBy* で同期的に確かめる
    expect(screen.getByRole("listbox", { name: "今日" })).toBeInTheDocument();

    const advanceTo = async (next: Date) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(next.getTime() - current.getTime());
      });
      current = next;
    };

    // 4日以上先：「締切 M/D」（plain。色は付かない）
    const plain = screen.getByText("締切 10/1");
    expect(plain.className).not.toMatch(/text-primary|text-destructive-foreground/);

    // 3日以内：「あとN日」（soon。アクセント色 text-primary）
    await advanceTo(new Date("2026-09-28T04:00:05+09:00"));
    expect(store.today).toBe("2026-09-28");
    expect(screen.getByText("あと3日").className).toMatch(/text-primary/);

    await advanceTo(new Date("2026-09-29T04:00:05+09:00"));
    expect(screen.getByText("あと2日").className).toMatch(/text-primary/);

    await advanceTo(new Date("2026-09-30T04:00:05+09:00"));
    expect(screen.getByText("あと1日").className).toMatch(/text-primary/);

    // 当日：「今日まで」（today。同じくアクセント色）
    await advanceTo(new Date("2026-10-01T04:00:05+09:00"));
    expect(screen.getByText("今日まで").className).toMatch(/text-primary/);

    // 過ぎたら：「N日超過」（overdue。控えめな赤 text-destructive-foreground だけ）
    await advanceTo(new Date("2026-10-02T04:00:05+09:00"));
    const overdue = screen.getByText("1日超過");
    expect(overdue.className).toMatch(/text-destructive-foreground/);
    expect(overdue.className).not.toMatch(/text-primary/);

    // 行全体（option）は赤くしない
    expect(screen.getByRole("option").className).not.toMatch(/text-destructive|red/);
  });
});

describe("完了の条件1：受信箱で d → 来週月曜 → Enter で予定に入り、その日の午前4時を過ぎると今日の一番上に印付きで出る", () => {
  it("受信箱で d →「来週月曜」→ Enter で予定に入り、その日の午前4時を過ぎてから画面を見ると今日の一番上に印付きで出る", async () => {
    // Date だけを偽にし、d の入力はほかのテストと同じ userEvent のキー操作で行う。
    // 「画面を見る」は、ストアが日付の切り替わりに気づくきっかけ（src/client/data/store.ts の
    // #listen：focus・visibilitychange・online）のうち window の focus で再現する。
    // day.refresh() が論理日付を確かめ直し、変わっていれば sync() を呼ぶので、間の日をまたいでも問題ない
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜 10:00
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new RolloverFakeServer();
    server.putTask(makeTask({ title: "既存", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard("d");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "来週月曜{Enter}");
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2026-10-05");
    expect(optionTitles("受信箱")).toEqual([]);

    // 10/5 の 3:59（1分未満前）に画面を見ても、まだ今日に出ない
    vi.setSystemTime(new Date("2026-10-05T03:59:00+09:00"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await store.sync();
    });
    // 4時前なので、論理日付はまだ前日（10/4）のまま
    expect(store.today).toBe("2026-10-04");
    expect(store.lists.today.map((t) => t.title)).toEqual(["既存"]);

    // 10/5 の 4:00 を過ぎてから画面を見ると、今日の一番上に印付きで出る（既存のタスクより上）
    vi.setSystemTime(new Date("2026-10-05T04:00:05+09:00"));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await store.sync();
    });
    expect(store.today).toBe("2026-10-05");
    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "既存"]);
    const arrived = store.lists.today.find((t) => t.title === "A");
    expect(arrived && store.lists.isArrivedToday(arrived)).toBe(true);
    expect(arrived?.scheduledOn).toBeNull();

    await user.click(screen.getByRole("link", { name: /^今日/ }));
    await screen.findByRole("listbox", { name: "今日" });
    expect(screen.getByRole("img", { name: "今日来たタスク" })).toBeInTheDocument();
  });

  it("午前4時のタイマーでも、予定の日付が来たタスクが今日の一番上に入る（画面を見なくても、日をまたぐタイマーの経路で自動的に移る）", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const start = new Date("2026-09-27T10:00:00+09:00"); // 日曜 = 今日
    vi.setSystemTime(start);
    const server = new RolloverFakeServer();
    server.putTask(makeTask({ title: "既存", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    expect(screen.getByRole("listbox", { name: "受信箱" })).toBeInTheDocument();

    const a = store.lists.inbox.find((t) => t.title === "A");
    expect(a).toBeDefined();
    // parseDateInput("来週月曜", "2026-09-27") === "2026-09-28"（date-input.test.ts で確認済み）
    store.actions.moveTasks([a?.id ?? ""], { bucket: "scheduled", on: "2026-09-28" });
    expect(store.lists.inbox.map((t) => t.title)).toEqual([]);
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2026-09-28");

    // 3:59（1分未満前）ではまだ今日に出ない
    const beforeBoundary = new Date("2026-09-28T03:59:00+09:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(beforeBoundary.getTime() - start.getTime());
    });
    expect(store.today).toBe("2026-09-27");
    expect(store.lists.today.map((t) => t.title)).toEqual(["既存"]);

    // 4時を過ぎると、今日の一番上に印付きで出る
    const afterBoundary = new Date("2026-09-28T04:00:05+09:00");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(afterBoundary.getTime() - beforeBoundary.getTime());
    });
    expect(store.today).toBe("2026-09-28");
    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "既存"]);
    const arrived = store.lists.today.find((t) => t.title === "A");
    expect(arrived && store.lists.isArrivedToday(arrived)).toBe(true);
    expect(arrived?.scheduledOn).toBeNull();

    // 今日の画面に切り替えて、印が出ていることも確かめる（userEvent は使わず、実の click イベントで）
    fireEvent.click(screen.getByRole("link", { name: /^今日/ }));
    expect(screen.getByRole("listbox", { name: "今日" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "今日来たタスク" })).toBeInTheDocument();
  });
});

describe("d・⇧D が効かないとき", () => {
  it("何も選んでいないときと、完了したタスクを選んでいるときは、入力欄が開かない", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "A",
        bucket: "today",
        rank: "a0",
        completedAt: "2026-09-28T09:00:00.000Z",
      }),
    );
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    // 何も選んでいないとき（唯一のタスクは完了済みで畳まれているので、まだ何も選ばれていない）
    await user.keyboard("d");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    await user.keyboard("{Shift>}D{/Shift}");
    expect(screen.queryByRole("textbox", { name: "締切" })).toBeNull();

    // 完了したタスク（「完了 N件」を開いて選ぶ）
    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("A");

    await user.keyboard("d");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    await user.keyboard("{Shift>}D{/Shift}");
    expect(screen.queryByRole("textbox", { name: "締切" })).toBeNull();
  });
});
