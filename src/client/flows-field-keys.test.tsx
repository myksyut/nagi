import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { DAY_WIDTH } from "./features/timeline/timeline-screen";
import { fieldKeyScenes } from "./keyboard/field-keys";
import { parseKey } from "./keyboard/keys";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask, nextId } from "./test/fixtures";
import { optionTitles, pickerListbox, setupApp } from "./test/render-app";

/**
 * チケット17：候補や欄の中のキー（keyboard/field-keys.ts）の説明と、部品の実際のキーの扱いがずれていないか。
 * ショートカットのページに出す説明は、部品が onKeyDown や Base UI で直接扱うキーを「説明だけ」登録したもので、
 * キーマップのように登録から動きを作るわけではない。そのため、登録に書いたキーを押して、書いたとおりに動くかを確かめる。
 * - 押すキーは登録から読む（keysOf）。登録のキーを変えて部品を変えない・部品を変えて登録を変えない、のどちらでも落ちる
 * - 登録の場面と操作が、下の VERIFIED（このファイルで確かめたもの）と同じであることも確かめる。
 *   場面や操作を足したら、ここに動きのテストを足して VERIFIED に加える
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

/** このファイルで動きを確かめた、場面の id と操作の名前 */
const VERIFIED: Record<string, readonly string[]> = {
  "project-picker": ["候補を選ぶ", "決める（「◯◯」を作成も）", "やめる"],
  "priority-picker": [
    "その場で決める（1 高・2 中・3 低・0 なし）",
    "候補を選ぶ",
    "決める",
    "やめる",
  ],
  "points-picker": ["数字で絞り込む（13 は 1・3、0 でなし）", "候補を選ぶ", "決める", "やめる"],
  "date-entry": ["決める", "締切を外す（欄を空にして）", "やめる"],
  "date-calendar": [
    "前の日・次の日へ",
    "前の週・次の週へ",
    "前の月・次の月へ",
    "前の年・次の年へ",
    "週の始め・終わりへ",
    "その日に決める",
  ],
  "add-row": ["追加して続けて打つ", "閉じる（最後に追加したタスクを選ぶ）"],
  "quick-add": ["追加して続けて打つ", "閉じる", "行き先（受信箱｜今日）を切り替える"],
  "task-detail": ["タイトルを保存して閉じる", "改行（メモの中）", "メモを保存して閉じる"],
  checklist: [
    "次の項目へ",
    "前の項目へ",
    "並べ替え",
    "空の項目を消す",
    "チェックを付ける・外す（チェックボックスの上で）",
    "項目を足して続けて打つ（「項目を追加」の欄）",
    "閉じる",
  ],
  palette: ["候補を選ぶ", "実行する・開く", "閉じる"],
  "project-name": ["作って開く（同じ名前があれば開く）", "やめる"],
  "task-detail-popover": ["閉じる（押したタスクへ戻る）", "完了にする・戻す（丸の上で）"],
  "project-rename": ["保存する", "やめる"],
  "project-color": ["色を選ぶ", "決める", "閉じる"],
  "sort-menu": [
    "その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）",
    "候補を選ぶ",
    "決める",
    "閉じる",
  ],
  "calendar-task": [
    "小さな詳細を開く（タスクか◆にフォーカスがあるとき）",
    "「ほか N 件」の一覧を閉じる",
  ],
  "calendar-filter": ["候補を選ぶ", "決める", "閉じる"],
  "timeline-bar": [
    "小さな詳細を開く（棒か◆にフォーカスがあるとき）",
    "ドラッグをやめる（押しているあいだ）",
  ],
  "timeline-filter": ["候補を選ぶ", "決める", "閉じる"],
};

/** 場面の操作に登録されたキー（keys.ts の書き方）。登録がなければ落とす */
function keysOf(sceneId: string, label: string): readonly string[] {
  const scene = fieldKeyScenes().find((entry) => entry.id === sceneId);
  if (!scene) throw new Error(`場面「${sceneId}」が登録されていません`);
  const fieldKey = scene.keys.find((entry) => entry.label === label);
  if (!fieldKey) throw new Error(`場面「${sceneId}」に「${label}」が登録されていません`);
  return fieldKey.keys;
}

/** keys.ts の書き方を、user-event の keyboard の書き方にする（例：`Alt+ArrowUp` → `{Alt>}{ArrowUp}{/Alt}`） */
function typed(spec: string): string {
  const combo = parseKey(spec);
  const key = combo.key === " " ? " " : [...combo.key].length === 1 ? combo.key : `{${combo.key}}`;
  const modifiers = [combo.mod && "Meta", combo.shift && "Shift", combo.alt && "Alt"].filter(
    (modifier): modifier is string => typeof modifier === "string",
  );
  return `${modifiers.map((m) => `{${m}>}`).join("")}${key}${[...modifiers]
    .reverse()
    .map((m) => `{/${m}}`)
    .join("")}`;
}

/** その操作に登録された i 番目のキーを押す */
async function press(
  user: ReturnType<typeof userEvent.setup>,
  sceneId: string,
  label: string,
  i = 0,
) {
  const spec = keysOf(sceneId, label)[i];
  if (spec === undefined) throw new Error(`「${label}」の ${i} 番目のキーがありません`);
  await user.keyboard(typed(spec));
}

async function open(path: string, server = new FakeServer()) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

async function settle(store: AppStore) {
  await act(async () => {
    await store.idle();
  });
}

describe("登録と、このファイルで確かめたものが同じ", () => {
  it("登録されている場面と操作は、すべて下で動きを確かめてある", async () => {
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const registered = Object.fromEntries(
      fieldKeyScenes().map((scene) => [scene.id, scene.keys.map((key) => key.label)]),
    );
    expect(registered).toEqual(VERIFIED);
  });

  it("キーの書き方の読み替え（テストの道具）", () => {
    expect(typed("Enter")).toBe("{Enter}");
    expect(typed("Alt+ArrowDown")).toBe("{Alt>}{ArrowDown}{/Alt}");
    expect(typed("Mod+k")).toBe("{Meta>}k{/Meta}");
    expect(typed(" ")).toBe(" ");
  });
});

describe("p の候補", () => {
  async function openPicker() {
    const server = new FakeServer();
    for (const name of ["A", "B", "C"]) server.putProject(makeProject({ name }));
    server.putTask(makeTask({ title: "付ける先", bucket: "inbox" }));
    const setup = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });
    return setup;
  }

  /** p で開き、keys を押して、決めるキーで決めたときに付いたプロジェクトの名前 */
  async function pickWith(
    user: ReturnType<typeof userEvent.setup>,
    store: AppStore,
    moves: readonly [label: string, index: number][],
  ): Promise<string | undefined> {
    await user.keyboard("p");
    await screen.findByRole("combobox", { name: "プロジェクト" });
    for (const [label, index] of moves) await press(user, "project-picker", label, index);
    await press(user, "project-picker", "決める（「◯◯」を作成も）");
    const projectId = store.lists.inbox[0]?.projectId;
    return store.lists.projects.find((project) => project.id === projectId)?.name;
  }

  it("↑↓ で候補を選び、Enter で決める（↓2回と↑1回は↓1回と同じ候補。↓2回は別の候補）", async () => {
    const user = userEvent.setup();
    const { store } = await openPicker();
    await user.keyboard("j");
    const down = keysOf("project-picker", "候補を選ぶ").indexOf("ArrowDown");
    const up = keysOf("project-picker", "候補を選ぶ").indexOf("ArrowUp");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);

    const once = await pickWith(user, store, [["候補を選ぶ", down]]);
    expect(once).toBeDefined();
    const back = await pickWith(user, store, [
      ["候補を選ぶ", down],
      ["候補を選ぶ", down],
      ["候補を選ぶ", up],
    ]);
    expect(back).toBe(once);
    const twice = await pickWith(user, store, [
      ["候補を選ぶ", down],
      ["候補を選ぶ", down],
    ]);
    expect(twice).toBeDefined();
    expect(twice).not.toBe(once);
  });

  it("Enter で「◯◯」を作成も決まる", async () => {
    const user = userEvent.setup();
    const { store } = await openPicker();
    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "新しい案件");
    expect(
      within(pickerListbox()).getByRole("option", { name: "「新しい案件」を作成" }),
    ).toBeInTheDocument();
    await press(user, "project-picker", "決める（「◯◯」を作成も）");
    const created = store.lists.projects.find((project) => project.name === "新しい案件");
    expect(store.lists.inbox[0]?.projectId).toBe(created?.id);
  });

  it("Esc でやめる（何も付かない）", async () => {
    const user = userEvent.setup();
    const { store } = await openPicker();
    await user.keyboard("jp");
    await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.keyboard("{ArrowDown}");
    await press(user, "project-picker", "やめる");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull(),
    );
    expect(store.lists.inbox[0]?.projectId).toBeNull();
  });
});

/** 今日に1件のタスクを置いて開き、そのタスクを選ぶ（⇧P・e の候補の対象） */
async function openTodayWithTask(user: ReturnType<typeof userEvent.setup>) {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "付ける先", bucket: "today" }));
  const setup = await open("/today", server);
  await screen.findByRole("listbox", { name: "今日" });
  await user.keyboard("j");
  return setup;
}

/** 候補の一覧に出ている候補の文字 */
function pickerOptions(): string[] {
  return within(pickerListbox())
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("⇧P の候補（優先度）", () => {
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard("{Shift>}P{/Shift}");
    await screen.findByRole("combobox", { name: "優先度" });
  };
  const closed = () =>
    waitFor(() => expect(screen.queryByRole("combobox", { name: "優先度" })).toBeNull());

  it("1・2・3・0 で、その場で高・中・低・なしに決まる", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    const label = "その場で決める（1 高・2 中・3 低・0 なし）";
    expect(keysOf("priority-picker", label)).toEqual(["1", "2", "3", "0"]);
    for (const [index, value] of (["high", "medium", "low", null] as const).entries()) {
      await openPicker(user);
      await press(user, "priority-picker", label, index);
      await closed();
      expect(store.lists.today[0]?.priority).toBe(value);
    }
  });

  it("↑↓ で候補を選び、Enter で決める（↓2回と↑1回は↓1回と同じ候補。↓2回は別の候補）", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    const down = keysOf("priority-picker", "候補を選ぶ").indexOf("ArrowDown");
    const up = keysOf("priority-picker", "候補を選ぶ").indexOf("ArrowUp");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);
    const pickWith = async (moves: readonly number[]) => {
      await openPicker(user);
      for (const index of moves) await press(user, "priority-picker", "候補を選ぶ", index);
      await press(user, "priority-picker", "決める");
      await closed();
      return store.lists.today[0]?.priority;
    };

    const once = await pickWith([down]);
    expect(once).not.toBeNull();
    expect(await pickWith([down, down, up])).toBe(once);
    const twice = await pickWith([down, down]);
    expect(twice).not.toBeNull();
    expect(twice).not.toBe(once);
  });

  it("Esc でやめる（何も変わらず、一覧へ戻る）", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    await openPicker(user);
    await user.keyboard("{ArrowDown}");
    await press(user, "priority-picker", "やめる");
    await closed();
    expect(store.lists.today[0]?.priority).toBeNull();
    expect(screen.getByRole("listbox", { name: "今日" })).toHaveFocus();
  });
});

describe("e の候補（工数）", () => {
  const label = "数字で絞り込む（13 は 1・3、0 でなし）";
  const openPicker = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard("e");
    await screen.findByRole("combobox", { name: "工数" });
  };
  const closed = () =>
    waitFor(() => expect(screen.queryByRole("combobox", { name: "工数" })).toBeNull());

  it("数字で絞り込み、Enter で決める（13 は 1・3、0 でなし）", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    const keys = keysOf("points-picker", label);
    expect(keys).toEqual(["1", "2", "3", "5", "8", "0"]);

    // 13 は 1 と 3
    await openPicker(user);
    await press(user, "points-picker", label, keys.indexOf("1"));
    expect(pickerOptions()).toEqual(["1", "13"]);
    await press(user, "points-picker", label, keys.indexOf("3"));
    expect(pickerOptions()).toEqual(["13"]);
    await press(user, "points-picker", "決める");
    await closed();
    expect(store.lists.today[0]?.points).toBe(13);

    // 1 桁の数字は、その数字（1 なら 1 と 13 のうち先の 1）。0 でなし
    const expected: Record<string, number | null> = { 1: 1, 2: 2, 3: 3, 5: 5, 8: 8, 0: null };
    for (const [index, key] of keys.entries()) {
      await openPicker(user);
      await press(user, "points-picker", label, index);
      expect(pickerOptions()[0]).toBe(key === "0" ? "なし" : key);
      await press(user, "points-picker", "決める");
      await closed();
      expect(store.lists.today[0]?.points).toBe(expected[key]);
    }
  });

  it("↑↓ で候補を選び、Enter で決める（↓2回と↑1回は↓1回と同じ候補。↓2回は別の候補）", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    const down = keysOf("points-picker", "候補を選ぶ").indexOf("ArrowDown");
    const up = keysOf("points-picker", "候補を選ぶ").indexOf("ArrowUp");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);
    const pickWith = async (moves: readonly number[]) => {
      await openPicker(user);
      for (const index of moves) await press(user, "points-picker", "候補を選ぶ", index);
      await press(user, "points-picker", "決める");
      await closed();
      return store.lists.today[0]?.points;
    };

    const once = await pickWith([down]);
    expect(once).not.toBeNull();
    expect(await pickWith([down, down, up])).toBe(once);
    const twice = await pickWith([down, down]);
    expect(twice).not.toBeNull();
    expect(twice).not.toBe(once);
  });

  it("Esc でやめる（何も変わらず、一覧へ戻る）", async () => {
    const user = userEvent.setup();
    const { store } = await openTodayWithTask(user);
    await openPicker(user);
    await user.keyboard("5");
    await press(user, "points-picker", "やめる");
    await closed();
    expect(store.lists.today[0]?.points).toBeNull();
    expect(screen.getByRole("listbox", { name: "今日" })).toHaveFocus();
  });
});

describe("日付の入力（d・⇧D）", () => {
  it("Enter で決める。Esc でやめる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "予定にする", bucket: "inbox" }));
    const { store } = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("jd");
    await user.type(await screen.findByRole("textbox", { name: "予定の日付" }), "2099/1/1");
    await press(user, "date-entry", "やめる");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull());
    expect(store.lists.inbox[0]?.scheduledOn).toBeNull();

    await user.keyboard("d");
    await user.type(await screen.findByRole("textbox", { name: "予定の日付" }), "2099/1/1");
    await press(user, "date-entry", "決める");
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2099-01-01");
  });

  it("締切は、欄を空にして Enter で外す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "締切あり", bucket: "inbox", deadlineOn: "2099-01-01" }));
    const { store } = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j{Shift>}d{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    expect(input).toHaveValue("");
    await press(user, "date-entry", "締切を外す（欄を空にして）");
    expect(store.lists.inbox[0]?.deadlineOn).toBeNull();
  });
});

describe("日付の入力のカレンダー（日にフォーカスがあるとき）", () => {
  /** YYYY-MM-DD を days 日・months 月・years 年ずらす（その端末の暦で） */
  function shift(date: string, { days = 0, months = 0, years = 0 }): string {
    const [y, m, d] = date.split("-").map(Number) as [number, number, number];
    const next = new Date(y + years, m - 1 + months, d + days);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
  }

  /** フォーカスのある日（DayPicker の日のマスの data-day） */
  function focusedDay(): string | null | undefined {
    return document.activeElement?.closest("[data-day]")?.getAttribute("data-day");
  }

  async function openCalendarOn(date: string) {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "予定の日", bucket: "scheduled", scheduledOn: date }));
    const setup = await open("/upcoming", server);
    await screen.findByRole("listbox", { name: "予定" });
    const user = userEvent.setup();
    await user.keyboard("jd");
    await screen.findByRole("textbox", { name: "予定の日付" });
    const day = document.querySelector<HTMLElement>(`[data-day="${date}"] button`);
    expect(day).not.toBeNull();
    act(() => day?.focus());
    expect(focusedDay()).toBe(date);
    return { ...setup, user };
  }

  it("←→ で日、↑↓ で週、⇧←→ と PageUp・PageDown で月、⇧↑↓ と ⇧PageUp・⇧PageDown で年、Home・End で週の端へ", async () => {
    const start = "2099-06-17"; // 水曜
    const { user } = await openCalendarOn(start);
    const moves: [label: string, index: number, expected: string][] = [
      ["前の日・次の日へ", 1, shift(start, { days: 1 })],
      ["前の日・次の日へ", 0, start],
      ["前の週・次の週へ", 1, shift(start, { days: 7 })],
      ["前の週・次の週へ", 0, start],
      ["前の月・次の月へ", 1, shift(start, { months: 1 })],
      ["前の月・次の月へ", 0, start],
      ["前の月・次の月へ", 3, shift(start, { months: 1 })],
      ["前の月・次の月へ", 2, start],
      ["前の年・次の年へ", 1, shift(start, { years: 1 })],
      ["前の年・次の年へ", 0, start],
      ["前の年・次の年へ", 3, shift(start, { years: 1 })],
      ["前の年・次の年へ", 2, start],
      // 週は日曜始まり（6/14 が日曜、6/20 が土曜）
      ["週の始め・終わりへ", 0, "2099-06-14"],
      ["週の始め・終わりへ", 1, "2099-06-20"],
    ];
    for (const [label, index, expected] of moves) {
      await press(user, "date-calendar", label, index);
      await waitFor(() => expect(focusedDay(), `${label}（${index}）`).toBe(expected));
    }
  });

  it.each([
    [0, "Enter"],
    [1, "Space"],
  ])("日の上の %s 番目のキー（%s）で、その日に決める", async (index) => {
    const { user, store } = await openCalendarOn("2099-06-17");
    await press(user, "date-calendar", "前の日・次の日へ", 1);
    await waitFor(() => expect(focusedDay()).toBe("2099-06-18"));
    await press(user, "date-calendar", "その日に決める", index);
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull());
    expect(store.lists.scheduled[0]?.scheduledOn).toBe("2099-06-18");
  });
});

describe("追加欄", () => {
  it("Enter で追加して続けて打て、Esc で閉じると最後に追加したタスクが選ばれる", async () => {
    const user = userEvent.setup();
    const { store } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "受信箱に追加" });
    await user.type(input, "1つ目");
    await press(user, "add-row", "追加して続けて打つ");
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    await user.keyboard("2つ目");
    await press(user, "add-row", "追加して続けて打つ");
    expect(store.lists.inbox.map((row) => row.title)).toEqual(["1つ目", "2つ目"]);

    await press(user, "add-row", "閉じる（最後に追加したタスクを選ぶ）");
    expect(screen.queryByRole("textbox", { name: "受信箱に追加" })).toBeNull();
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("2つ目");
  });
});

describe("小さな追加欄", () => {
  it("Enter で追加して続けて打て、Esc で閉じる。行き先は ←→ で切り替わる", async () => {
    const user = userEvent.setup();
    const { store } = await open("/calendar");
    await screen.findByRole("button", { name: "次の月" });

    await user.click(screen.getByRole("button", { name: "タスクを追加" }));
    const input = await screen.findByRole("textbox", { name: "受信箱に追加" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.keyboard("受信箱へ");
    await press(user, "quick-add", "追加して続けて打つ");
    expect(store.lists.inbox.map((row) => row.title)).toEqual(["受信箱へ"]);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();

    // Tab で行き先の切り替えへ移り、→ で今日へ、← で受信箱へ戻る（行き先は欄の名前「◯◯に追加」に出る）。
    // ラジオの checked（読み上げに出る行き先）も、行き先とそろう（17-修正1 の 8）
    const radio = (name: string) => screen.getByRole("radio", { name });
    await user.tab();
    expect(radio("受信箱")).toHaveFocus();
    expect(radio("受信箱")).toBeChecked();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 1);
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toBeInTheDocument();
    expect(radio("今日")).toHaveFocus();
    expect(radio("今日")).toBeChecked();
    expect(radio("受信箱")).not.toBeChecked();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 0);
    expect(screen.getByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
    expect(radio("受信箱")).toBeChecked();
    expect(radio("今日")).not.toBeChecked();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 1);
    expect(radio("今日")).toBeChecked();

    const todayInput = screen.getByRole("textbox", { name: "今日に追加" });
    todayInput.focus();
    await user.keyboard("今日へ");
    await press(user, "quick-add", "追加して続けて打つ");
    expect(store.lists.today.map((row) => row.title)).toEqual(["今日へ"]);

    await press(user, "quick-add", "閉じる");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: /に追加$/ })).toBeNull());
  });
});

describe("開いたタスク", () => {
  it("タイトルの Enter と Esc は、保存して閉じる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "元の名前", bucket: "today" }));
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    const keys = keysOf("task-detail", "タイトルを保存して閉じる");
    for (const [i, name] of ["Enterで直した", "Escで直した"].entries()) {
      await user.keyboard(i === 0 ? "j{Enter}{Enter}" : "{Enter}{Enter}");
      const title = screen.getByRole("textbox", { name: "タイトル" });
      expect(title).toHaveFocus();
      await user.clear(title);
      await user.keyboard(name);
      await press(user, "task-detail", "タイトルを保存して閉じる", i);
      expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
      await settle(store);
      expect(store.lists.today[0]?.title).toBe(name);
    }
    expect(keys).toHaveLength(2);
  });

  it("メモの中の Enter は改行（閉じない）、メモの Esc は保存して閉じる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "メモあり", bucket: "today", memo: "1行目" }));
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    // メモにフォーカスが入ると、それだけで書く欄になる（Tab で入ったときも同じ）
    act(() => screen.getByRole("button", { name: "メモを直す" }).focus());
    const textarea = await screen.findByRole("textbox", { name: "メモ" });
    await waitFor(() => expect(textarea).toHaveFocus());

    await press(user, "task-detail", "改行（メモの中）");
    await user.keyboard("2行目");
    expect(textarea).toHaveFocus();
    expect(textarea).toHaveValue("1行目\n2行目");

    await press(user, "task-detail", "メモを保存して閉じる");
    expect(screen.queryByRole("textbox", { name: "メモ" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
    await settle(store);
    expect(store.lists.today[0]?.memo).toBe("1行目\n2行目");
  });
});

describe("チェックリスト", () => {
  function group() {
    return screen.getByRole("group", { name: "チェックリスト" });
  }

  async function openChecklist(titles: readonly string[]) {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: titles.map((title) => ({ id: nextId(), title, done: false })),
      }),
    );
    const setup = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    const user = userEvent.setup();
    await user.keyboard("j{Enter}");
    return { ...setup, user };
  }

  const titlesOf = (store: AppStore) => store.lists.today[0]?.checklist.map((item) => item.title);

  it("Enter と ↓ で次の項目へ、↑ で前の項目へ", async () => {
    const { user } = await openChecklist(["A", "B", "C"]);
    const [a, b, c] = ["A", "B", "C"].map((title) => within(group()).getByDisplayValue(title));
    a?.focus();
    await press(user, "checklist", "次の項目へ", 0);
    expect(b).toHaveFocus();
    await press(user, "checklist", "次の項目へ", 1);
    expect(c).toHaveFocus();
    // 最後の項目の次は「項目を追加」の欄
    await press(user, "checklist", "次の項目へ", 0);
    expect(within(group()).getByRole("textbox", { name: "項目を追加" })).toHaveFocus();
    c?.focus();
    await press(user, "checklist", "前の項目へ");
    expect(b).toHaveFocus();
  });

  it("⌥↑ ⌥↓ で並べ替える", async () => {
    const { store, user } = await openChecklist(["A", "B"]);
    within(group()).getByDisplayValue("A").focus();
    await press(user, "checklist", "並べ替え", 1);
    await settle(store);
    expect(titlesOf(store)).toEqual(["B", "A"]);
    await press(user, "checklist", "並べ替え", 0);
    await settle(store);
    expect(titlesOf(store)).toEqual(["A", "B"]);
  });

  it("空の項目で ⌫ を押すと消える", async () => {
    const { store, user } = await openChecklist(["A", "B"]);
    const field = within(group()).getByDisplayValue("B");
    await user.clear(field);
    await press(user, "checklist", "空の項目を消す");
    await settle(store);
    expect(titlesOf(store)).toEqual(["A"]);
  });

  it("チェックボックスの上の Space と Enter で、チェックを付ける・外す", async () => {
    const { store, user } = await openChecklist(["A"]);
    const box = within(group()).getByRole("checkbox", { name: "A" });
    box.focus();
    await press(user, "checklist", "チェックを付ける・外す（チェックボックスの上で）", 0);
    await settle(store);
    expect(store.lists.today[0]?.checklist[0]?.done).toBe(true);
    await press(user, "checklist", "チェックを付ける・外す（チェックボックスの上で）", 1);
    await settle(store);
    expect(store.lists.today[0]?.checklist[0]?.done).toBe(false);
    // 開いたタスクは閉じない（タイトルへ移らない）
    expect(screen.queryByRole("textbox", { name: "タイトル" })).not.toHaveFocus();
    expect(group()).toBeInTheDocument();
  });

  it("「項目を追加」の欄の Enter で足して、続けて打てる", async () => {
    const { store, user } = await openChecklist([]);
    const add = within(group()).getByRole("textbox", { name: "項目を追加" });
    add.focus();
    await user.keyboard("1つ目");
    await press(user, "checklist", "項目を足して続けて打つ（「項目を追加」の欄）");
    await user.keyboard("2つ目");
    await press(user, "checklist", "項目を足して続けて打つ（「項目を追加」の欄）");
    await settle(store);
    expect(titlesOf(store)).toEqual(["1つ目", "2つ目"]);
    expect(within(group()).getByRole("textbox", { name: "項目を追加" })).toHaveFocus();
  });

  it("項目の欄と「項目を追加」の欄の Esc で閉じる", async () => {
    const { user } = await openChecklist(["A"]);
    within(group()).getByDisplayValue("A").focus();
    await press(user, "checklist", "閉じる");
    expect(screen.queryByRole("group", { name: "チェックリスト" })).toBeNull();

    await user.keyboard("{Enter}");
    within(group()).getByRole("textbox", { name: "項目を追加" }).focus();
    await press(user, "checklist", "閉じる");
    expect(screen.queryByRole("group", { name: "チェックリスト" })).toBeNull();
  });
});

describe("⌘K", () => {
  /** ⌘K を開いて「を開く」で絞り、moves を押して、実行するキーで実行したときに開いた画面 */
  async function runWith(
    user: ReturnType<typeof userEvent.setup>,
    location: { history?: string[] },
    moves: readonly number[],
  ): Promise<string | undefined> {
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "を開く");
    for (const index of moves) await press(user, "palette", "候補を選ぶ", index);
    await press(user, "palette", "実行する・開く");
    await waitFor(() =>
      expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
    );
    const path = location.history?.at(-1);
    // 次の回のために受信箱へ戻る
    await user.keyboard("1");
    await screen.findByRole("listbox", { name: "受信箱" });
    return path;
  }

  it("↑↓ で候補を選び、Enter で実行する（↓2回と↑1回は↓1回と同じ。↓2回は別の画面）", async () => {
    const user = userEvent.setup();
    const { location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    const down = keysOf("palette", "候補を選ぶ").indexOf("ArrowDown");
    const up = keysOf("palette", "候補を選ぶ").indexOf("ArrowUp");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);

    const once = await runWith(user, location, [down]);
    const back = await runWith(user, location, [down, down, up]);
    const twice = await runWith(user, location, [down, down]);
    expect(once).toBeDefined();
    expect(back).toBe(once);
    expect(twice).not.toBe(once);
  });

  it("Esc と ⌘K で閉じる", async () => {
    const user = userEvent.setup();
    await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    for (const index of keysOf("palette", "閉じる").keys()) {
      await user.keyboard("{Meta>}k{/Meta}");
      await screen.findByRole("combobox", { name: "検索とコマンド" });
      await press(user, "palette", "閉じる", index);
      await waitFor(() =>
        expect(screen.queryByRole("combobox", { name: "検索とコマンド" })).toBeNull(),
      );
    }
    expect(keysOf("palette", "閉じる")).toEqual(["Escape", "Mod+k"]);
  });
});

describe("プロジェクトの名前の欄", () => {
  it("Enter で作って開く。同じ名前があれば開く。Esc でやめる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const existing = makeProject({ name: "既存" });
    server.putProject(existing);
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    await create();
    await user.keyboard("やめる");
    await press(user, "project-name", "やめる");
    expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull();
    expect(store.lists.projects).toHaveLength(1);

    await create();
    await user.keyboard("既存");
    await press(user, "project-name", "作って開く（同じ名前があれば開く）");
    expect(location.history?.at(-1)).toBe(`/projects/${existing.id}`);
    expect(store.lists.projects).toHaveLength(1);

    await create();
    await user.keyboard("新規");
    await press(user, "project-name", "作って開く（同じ名前があれば開く）");
    const created = store.lists.projects.find((project) => project.name === "新規");
    expect(location.history?.at(-1)).toBe(`/projects/${created?.id}`);
    await screen.findByRole("listbox", { name: "新規" });
    expect(optionTitles("新規")).toEqual([]);
  });
});

describe("プロジェクトの名前の変更（見出し）", () => {
  it("Enter で保存する。Esc でやめる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "元の名前" }));
    const { store } = await open(`/projects/${project.id}`, server);
    await screen.findByRole("heading", { name: "元の名前" });

    await user.click(screen.getByRole("button", { name: "元の名前" }));
    const input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    await user.keyboard("直した名前");
    await press(user, "project-rename", "保存する");
    expect(screen.queryByRole("textbox", { name: "プロジェクト名" })).toBeNull();
    expect(store.project(project.id)?.name).toBe("直した名前");

    await user.click(screen.getByRole("button", { name: "直した名前" }));
    await user.clear(screen.getByRole("textbox", { name: "プロジェクト名" }));
    await user.keyboard("やめた名前");
    await press(user, "project-rename", "やめる");
    expect(screen.queryByRole("textbox", { name: "プロジェクト名" })).toBeNull();
    expect(store.project(project.id)?.name).toBe("直した名前");
  });
});

describe("プロジェクトの色の候補", () => {
  it("←→↑↓ で色を移り、Enter と Space で決める。Esc で閉じる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const { store } = await open(`/projects/${project.id}`, server);
    await screen.findByRole("heading", { name: "P" });

    await user.click(screen.getByRole("button", { name: "プロジェクトの色：紫" }));
    let palette = await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    const radio = (name: string) => within(palette).getByRole("radio", { name });
    expect(radio("紫")).toHaveFocus();
    const moves: [index: number, name: string][] = [
      [1, "水色"], // →
      [3, "ピンク"], // ↓
      [2, "水色"], // ↑
      [0, "紫"], // ←
      [1, "水色"],
    ];
    for (const [index, name] of moves) {
      await press(user, "project-color", "色を選ぶ", index);
      expect(radio(name)).toHaveFocus();
    }
    await press(user, "project-color", "決める", 0);
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(store.project(project.id)?.color).toBe("sky");

    await user.click(screen.getByRole("button", { name: "プロジェクトの色：水色" }));
    palette = await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    await press(user, "project-color", "色を選ぶ", 1);
    expect(radio("ピンク")).toHaveFocus();
    await press(user, "project-color", "決める", 1);
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(store.project(project.id)?.color).toBe("pink");

    const button = screen.getByRole("button", { name: "プロジェクトの色：ピンク" });
    await user.click(button);
    await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    await press(user, "project-color", "閉じる");
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(button).toHaveFocus();
    expect(store.project(project.id)?.color).toBe("pink");
  });
});

describe("並び方の一覧", () => {
  const button = () => screen.getByRole("button", { name: /^並び：/ });
  const openMenu = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(button());
    await screen.findByRole("combobox", { name: "並び方" });
  };
  const closed = () =>
    waitFor(() => expect(screen.queryByRole("combobox", { name: "並び方" })).toBeNull());

  it("1〜4 で、その場で手動・優先度・工数が少ない順・工数が多い順に決まる", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const label = "その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）";
    expect(keysOf("sort-menu", label)).toEqual(["1", "2", "3", "4"]);
    // 手動から始めるので、2・3・4・1 の順に押す（どれも今と違う並び方になる）
    for (const [index, name] of [
      [1, "優先度"],
      [2, "工数が少ない順"],
      [3, "工数が多い順"],
      [0, "手動"],
    ] as const) {
      await openMenu(user);
      await press(user, "sort-menu", label, index);
      await closed();
      expect(button()).toHaveAccessibleName(`並び：${name}`);
    }
  });

  it("↑↓ で候補を選び、Enter で決める（↓2回と↑1回は↓1回と同じ候補。↓2回は別の候補）", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const down = keysOf("sort-menu", "候補を選ぶ").indexOf("ArrowDown");
    const up = keysOf("sort-menu", "候補を選ぶ").indexOf("ArrowUp");
    expect(down).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThanOrEqual(0);
    const pickWith = async (moves: readonly number[]) => {
      await openMenu(user);
      for (const index of moves) await press(user, "sort-menu", "候補を選ぶ", index);
      await press(user, "sort-menu", "決める");
      await closed();
      return button().textContent;
    };

    const once = await pickWith([down]);
    expect(await pickWith([down, down, up])).toBe(once);
    expect(await pickWith([down, down])).not.toBe(once);
  });

  it("Esc で閉じてボタンへ戻る（並び方は変わらない）", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await openMenu(user);
    await user.keyboard("{ArrowDown}");
    await press(user, "sort-menu", "閉じる");
    await closed();
    expect(button()).toHaveAccessibleName("並び：手動");
    expect(button()).toHaveFocus();
  });
});

/** カレンダーとタイムラインは、9/27（日）の朝にしておく */
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

describe("カレンダーのタスクと、小さな詳細", () => {
  it("タスクの上の Enter と Space で小さな詳細が開き、Esc で閉じて押したタスクへ戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "詳細A", bucket: "scheduled", scheduledOn: "2026-09-30" }));
    await openView("/calendar", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const chip = within(calendarCell("2026-09-30")).getByRole("button", { name: "詳細A" });

    for (const index of [0, 1]) {
      act(() => chip.focus());
      await press(
        user,
        "calendar-task",
        "小さな詳細を開く（タスクか◆にフォーカスがあるとき）",
        index,
      );
      const dialog = await screen.findByRole("dialog", { name: "「詳細A」の詳細" });
      act(() => dialog.focus());
      await press(user, "task-detail-popover", "閉じる（押したタスクへ戻る）");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(chip).toHaveFocus();
    }
  });

  it("小さな詳細の完了の丸の上の Enter と Space で、完了にする", async () => {
    const server = new FakeServer();
    for (const title of ["丸A", "丸B"]) {
      server.putTask(makeTask({ title, bucket: "scheduled", scheduledOn: "2026-09-30" }));
    }
    const { store } = await openView("/calendar", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    for (const [index, title] of ["丸A", "丸B"].entries()) {
      await user.click(within(calendarCell("2026-09-30")).getByRole("button", { name: title }));
      const dialog = await screen.findByRole("dialog", { name: `「${title}」の詳細` });
      act(() =>
        within(dialog)
          .getByRole("button", { name: `「${title}」を完了にする` })
          .focus(),
      );
      await press(user, "task-detail-popover", "完了にする・戻す（丸の上で）", index);
      await waitFor(() =>
        expect(store.lists.completedToday.map((row) => row.title)).toContain(title),
      );
    }
  });

  it("「ほか N 件」の一覧は Esc で閉じる", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["T1", "T2", "T3", "T4", "T5"].entries()) {
      server.putTask(
        makeTask({ title, bucket: "scheduled", scheduledOn: "2026-09-30", rank: `a${i}` }),
      );
    }
    await openView("/calendar", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(calendarCell("2026-09-30")).getByRole("button", { name: "ほか 3 件" }));
    await screen.findByRole("dialog", { name: /のタスク$/ });
    await press(user, "calendar-task", "「ほか N 件」の一覧を閉じる");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("カレンダーのプロジェクトの絞り込み", () => {
  it("↑↓ で候補を選び、Enter と Space で決める。Esc で閉じる", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "P1" }));
    await openView("/calendar", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const trigger = () => screen.getByRole("button", { name: /^プロジェクトで絞り込む：/ });
    const highlighted = () =>
      screen.getAllByRole("menuitemradio").find((item) => item.hasAttribute("data-highlighted"));

    await user.click(trigger());
    await screen.findByRole("menu");
    // 何も選んでいないときの ↓ は一番上（すべて）から
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await waitFor(() => expect(highlighted()).toHaveTextContent("すべてのプロジェクト"));
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await waitFor(() => expect(highlighted()).toHaveTextContent("P1"));
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await press(user, "calendar-filter", "候補を選ぶ", 0);
    await waitFor(() => expect(highlighted()).toHaveTextContent("P1"));
    await press(user, "calendar-filter", "決める", 0);
    await waitFor(() => expect(trigger()).toHaveAccessibleName("プロジェクトで絞り込む：P1"));

    await user.click(trigger());
    await screen.findByRole("menu");
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await press(user, "calendar-filter", "候補を選ぶ", 1);
    await waitFor(() => expect(highlighted()).toHaveTextContent("プロジェクトなし"));
    await press(user, "calendar-filter", "決める", 1);
    await waitFor(() =>
      expect(trigger()).toHaveAccessibleName("プロジェクトで絞り込む：プロジェクトなし"),
    );

    await user.click(trigger());
    await screen.findByRole("menu");
    await press(user, "calendar-filter", "閉じる");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(trigger()).toHaveAccessibleName("プロジェクトで絞り込む：プロジェクトなし");
  });
});

describe("タイムラインの棒と◆", () => {
  it("棒の上の Enter と Space で小さな詳細が開く。押しているあいだの Esc でドラッグをやめる", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "棒", bucket: "scheduled", scheduledOn: "2026-10-05" }),
    );
    const { store } = await openView("/timeline", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const bar = () => screen.getByRole("button", { name: /^「棒」/ });

    for (const index of [0, 1]) {
      act(() => bar().focus());
      await press(user, "timeline-bar", "小さな詳細を開く（棒か◆にフォーカスがあるとき）", index);
      const dialog = await screen.findByRole("dialog", { name: "「棒」の詳細" });
      act(() => dialog.focus());
      await press(user, "task-detail-popover", "閉じる（押したタスクへ戻る）");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }

    const element = bar();
    fireEvent.pointerDown(element, { button: 0, pointerId: 7, clientX: 0 });
    fireEvent.pointerMove(element, { pointerId: 7, clientX: 3 * DAY_WIDTH });
    await press(user, "timeline-bar", "ドラッグをやめる（押しているあいだ）");
    fireEvent.pointerUp(element, { pointerId: 7, clientX: 3 * DAY_WIDTH });
    expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05");
    expect(store.canUndo).toBe(false);
  });
});

describe("タイムラインのプロジェクトの絞り込み", () => {
  it("↑↓ で候補を選び、Enter と Space で決める。Esc で閉じてボタンへ戻る", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(
      makeTask({
        title: "Pのタスク",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        projectId: project.id,
      }),
    );
    server.putTask(
      makeTask({ title: "なしのタスク", bucket: "scheduled", scheduledOn: "2026-10-01" }),
    );
    await openView("/timeline", server);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const trigger = () => screen.getByRole("button", { name: /^プロジェクトで絞り込む：/ });
    const radio = (name: string) => screen.getByRole("radio", { name });

    await user.click(trigger());
    await waitFor(() => expect(radio("すべてのプロジェクト")).toHaveFocus());
    await press(user, "timeline-filter", "候補を選ぶ", 1);
    expect(radio("AIPR")).toHaveFocus();
    await press(user, "timeline-filter", "候補を選ぶ", 0);
    expect(radio("すべてのプロジェクト")).toHaveFocus();
    await press(user, "timeline-filter", "候補を選ぶ", 1);
    await press(user, "timeline-filter", "決める", 0);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^「なしのタスク」/ })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /^「Pのタスク」/ })).toBeInTheDocument();

    await user.click(trigger());
    await waitFor(() => expect(radio("AIPR")).toHaveFocus());
    await press(user, "timeline-filter", "候補を選ぶ", 1);
    expect(radio("プロジェクトなし")).toHaveFocus();
    await press(user, "timeline-filter", "決める", 1);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^「Pのタスク」/ })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /^「なしのタスク」/ })).toBeInTheDocument();

    await user.click(trigger());
    await waitFor(() => expect(radio("プロジェクトなし")).toHaveFocus());
    await press(user, "timeline-filter", "閉じる");
    await waitFor(() => expect(screen.queryByRole("radio", { name: "AIPR" })).toBeNull());
    expect(trigger()).toHaveFocus();
  });
});
