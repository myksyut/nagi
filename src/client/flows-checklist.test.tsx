import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask, nextId } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 完了の条件4：チェックリストの進み具合が行に出る。全部チェックしてもタスクは完了しない。
 * 追加・削除・並べ替え・⌘Z（一覧にフォーカスがあるとき）・名前の自動保存（⌘Z の対象にしない）・
 * チェックを戻すときに、そのあとに直した名前は残る（revertChecklist）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openToday(server: FakeServer) {
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "今日" });
  return store;
}

function checklistGroup() {
  return screen.getByRole("group", { name: "チェックリスト" });
}

describe("行の右側の進み具合。全部チェックしてもタスクは完了しない", () => {
  it("1/2 → チェックで 2/2。completedAt は null のまま、今日の一覧に残る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "リリース前の確認",
        bucket: "today",
        checklist: [
          { id: nextId(), title: "CHANGELOG", done: true },
          { id: nextId(), title: "デプロイ", done: false },
        ],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    expect(screen.getByText("1/2")).toBeInTheDocument();

    await user.keyboard("j{Enter}");
    const box = within(checklistGroup()).getByRole("checkbox", { name: "デプロイ" });
    await user.click(box);
    await act(async () => {
      await store.idle();
    });

    expect(store.task(taskId)?.completedAt).toBeNull();
    expect(store.lists.today.map((t) => t.id)).toContain(taskId);
    await user.keyboard("{Escape}");
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("項目が0件なら進み具合を出さない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "チェックリストなし", bucket: "today", checklist: [] }));
    await openToday(server);
    expect(screen.queryByText(/^\d+\/\d+$/)).toBeNull();
  });
});

describe("追加・削除・並べ替え", () => {
  it("Enter で一番下に足して、続けて次を打てる", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "タスク", bucket: "today", checklist: [] }));
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    const add = within(checklistGroup()).getByRole("textbox", { name: "項目を追加" });
    await user.type(add, "1つ目{Enter}");
    await user.type(add, "2つ目{Enter}");
    await act(async () => {
      await store.idle();
    });

    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["1つ目", "2つ目"]);
    // 追加欄はまだ入力できる状態（続けて何件でも足せる）
    expect(within(checklistGroup()).getByRole("textbox", { name: "項目を追加" })).toHaveValue("");
  });

  it("削除ボタンで消える。空の欄で ⌫ でも消える", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [
          { id: nextId(), title: "1つ目", done: false },
          { id: nextId(), title: "2つ目", done: false },
        ],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    await user.click(within(checklistGroup()).getByRole("button", { name: "「1つ目」を削除" }));
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["2つ目"]);

    const field = within(checklistGroup()).getByRole("textbox", { name: "項目" });
    await user.clear(field);
    await user.keyboard("{Backspace}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist).toEqual([]);
  });

  it("⌥↑／⌥↓ で並べ替える", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [
          { id: nextId(), title: "A", done: false },
          { id: nextId(), title: "B", done: false },
        ],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    const fieldA = within(checklistGroup()).getByDisplayValue("A");
    fieldA.focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("追加は ⌘Z で戻せる（一覧にフォーカスがあるとき）", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [{ id: nextId(), title: "元の項目", done: false }],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    const add = within(checklistGroup()).getByRole("textbox", { name: "項目を追加" });
    await user.type(add, "足した項目{Enter}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["元の項目", "足した項目"]);

    // タスクを閉じて一覧にフォーカスを戻してから ⌘Z
    await user.keyboard("{Escape}");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["元の項目"]);
  });
});

describe("削除・並べ替えも、画面から操作して ⌘Z で戻せる", () => {
  function setupThree() {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [
          { id: nextId(), title: "A", done: false },
          { id: nextId(), title: "B", done: true },
          { id: nextId(), title: "C", done: false },
        ],
      }),
    );
    return server;
  }

  /** タスクを閉じて一覧にフォーカスを戻してから ⌘Z（入力欄の中の ⌘Z はブラウザの取り消し） */
  async function undoFromList(user: ReturnType<typeof userEvent.setup>, store: AppStore) {
    screen.getByRole("listbox", { name: "今日" }).focus();
    await user.keyboard("{Meta>}z{/Meta}");
    await act(async () => {
      await store.idle();
    });
  }

  it("削除ボタンで消した項目は、⌘Z で元の位置・元のチェックのまま戻る", async () => {
    const store = await openToday(setupThree());
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    await user.click(within(checklistGroup()).getByRole("button", { name: "「B」を削除" }));
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["A", "C"]);

    await undoFromList(user, store);
    expect(store.task(taskId)?.checklist.map(({ title, done }) => ({ title, done }))).toEqual([
      { title: "A", done: false },
      { title: "B", done: true },
      { title: "C", done: false },
    ]);
    // 開いている画面にも戻っている
    expect(within(checklistGroup()).getByRole("checkbox", { name: "B" })).toBeChecked();
  });

  it("空の欄で ⌫ を押して消した項目も、⌘Z で戻る", async () => {
    const store = await openToday(setupThree());
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    const field = within(checklistGroup()).getByDisplayValue("C");
    await user.clear(field);
    await user.keyboard("{Backspace}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["A", "B"]);

    await undoFromList(user, store);
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });

  it("⌥↑／⌥↓ の並べ替えは、1回ずつ ⌘Z で戻る", async () => {
    const store = await openToday(setupThree());
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    within(checklistGroup()).getByDisplayValue("C").focus();
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["C", "A", "B"]);
    within(checklistGroup()).getByDisplayValue("A").focus();
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["C", "B", "A"]);

    await undoFromList(user, store);
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["C", "A", "B"]);
    await undoFromList(user, store);
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["A", "C", "B"]);
    await undoFromList(user, store);
    expect(store.task(taskId)?.checklist.map((c) => c.title)).toEqual(["A", "B", "C"]);
  });
});

describe("チェックを戻す ⌘Z でも、そのあとに直した名前は残る（revertChecklist）", () => {
  it("チェックを付けて、名前を直して（自動保存）、⌘Z で戻すとチェックだけ戻り、名前は残る", async () => {
    const server = new FakeServer();
    const itemId = nextId();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [{ id: itemId, title: "元の名前", done: false }],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const taskId = store.lists.today[0]?.id ?? "";

    await user.keyboard("j{Enter}");
    const box = within(checklistGroup()).getByRole("checkbox", { name: "元の名前" });
    await user.click(box);
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist).toEqual([{ id: itemId, title: "元の名前", done: true }]);

    // チェックのあとに名前を直す（自動保存、⌘Z の対象にしない）
    const field = within(checklistGroup()).getByRole("textbox", { name: "項目" });
    await user.clear(field);
    await user.type(field, "書き直した名前");
    await user.keyboard("{Escape}");
    await act(async () => {
      await store.idle();
    });
    expect(store.task(taskId)?.checklist).toEqual([
      { id: itemId, title: "書き直した名前", done: true },
    ]);

    // ⌘Z で戻すのはチェックの操作。名前の直しは残る
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(taskId)?.checklist).toEqual([
      { id: itemId, title: "書き直した名前", done: false },
    ]);
  });
});

describe("名前の変更は自動保存で、⌘Z の対象にしない", () => {
  it("500ms 後に保存され、store.canUndo は変わらない", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [{ id: nextId(), title: "元の名前", done: false }],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();
    const canUndoBefore = store.canUndo;

    await user.keyboard("j{Enter}");
    const field = within(checklistGroup()).getByRole("textbox", { name: "項目" });
    await user.clear(field);
    await user.type(field, "新しい名前");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
    });

    expect(store.task(store.lists.today[0]?.id ?? "")?.checklist[0]?.title).toBe("新しい名前");
    expect(store.canUndo).toBe(canUndoBefore);
  });
});

describe("保存の失敗（6：できれば）", () => {
  it("項目の名前の保存に失敗すると、直した名前が欄に戻る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "タスク",
        bucket: "today",
        checklist: [{ id: nextId(), title: "元の名前", done: false }],
      }),
    );
    const store = await openToday(server);
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    const field = within(checklistGroup()).getByRole("textbox", { name: "項目" });
    const release = server.hold("/api/mutate");
    await user.clear(field);
    await user.type(field, "新しい{Enter}");
    // Enter は上下の項目・追加欄へ移すだけ。フォーカスを外して保存を試みる
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("group", { name: "チェックリスト" })).toBeNull();

    server.fail("/api/mutate", 400);
    release();
    await act(async () => {
      await store.idle();
    });
    expect(store.task(store.lists.today[0]?.id ?? "")?.checklist[0]?.title).toBe("元の名前");

    // 開き直すと、打った文字が欄に戻っている
    await user.keyboard("{Enter}");
    expect(within(checklistGroup()).getByRole("textbox", { name: "項目" })).toHaveValue("新しい");
  });
});
