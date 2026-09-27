import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
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
});

/** このファイルで動きを確かめた、場面の id と操作の名前 */
const VERIFIED: Record<string, readonly string[]> = {
  "project-picker": ["候補を選ぶ", "決める（「◯◯」を作成も）", "やめる"],
  "date-entry": ["決める", "締切を外す（欄を空にして）", "やめる"],
  "add-row": ["追加して続けて打つ", "閉じる（最後に追加したタスクを選ぶ）"],
  "quick-add": ["追加して続けて打つ", "閉じる", "行き先（受信箱｜今日）を切り替える"],
  "task-detail": ["タイトルを保存して閉じる", "メモを書く（メモの上で）", "メモを保存して閉じる"],
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
    // ラジオの checked そのものは見ない：ラベルの onClick が既定の動きを止めて自分で切り替えるので、
    // 矢印で動いたときの DOM の checked は、テストの DOM（happy-dom）では行き先と一致しない
    await user.tab();
    expect(screen.getByRole("radio", { name: "受信箱" })).toHaveFocus();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 1);
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "今日" })).toHaveFocus();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 0);
    expect(screen.getByRole("textbox", { name: "受信箱に追加" })).toBeInTheDocument();
    await press(user, "quick-add", "行き先（受信箱｜今日）を切り替える", 1);

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

  it("メモの上の Enter で書く欄になり、メモの Esc は保存して閉じる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "メモあり", bucket: "today", memo: "https://example.com" }));
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    // メモそのものにフォーカスが入ると、それだけで書く欄になる。Enter で書く欄になるのは、メモの中（リンク）にいるとき
    const memo = screen.getByRole("button", { name: "メモを直す" });
    within(memo).getByRole("link").focus();
    await press(user, "task-detail", "メモを書く（メモの上で）");
    const textarea = screen.getByRole("textbox", { name: "メモ" });
    expect(textarea).toHaveFocus();

    await user.keyboard(" を見る");
    await press(user, "task-detail", "メモを保存して閉じる");
    expect(screen.queryByRole("textbox", { name: "メモ" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
    await settle(store);
    expect(store.lists.today[0]?.memo).toBe("https://example.com を見る");
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
