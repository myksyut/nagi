import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeTask, nextId } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 6-修正1 の1：チェックリストは配列をまるごと置き換えるので、変える前の配列を添えて送り、
 * ほかの画面（別のタブ）が先に変えていたらサーバーが断る。断られた画面は変更を捨てて知らせ、
 * 最新を取りに行く。足そうとした項目の文字は「項目を追加」の下書きに戻す。
 * 同じ画面で続けて操作したとき（1つ目の送信中に2つ目を操作したとき）は断られない
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

const CONFLICT_TOAST = "ほかの画面で先に変更されていたため、保存できませんでした";

function checklistGroup() {
  return screen.getByRole("group", { name: "チェックリスト" });
}

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

function setup() {
  const server = new FakeServer();
  const a = { id: nextId(), title: "A", done: false };
  const b = { id: nextId(), title: "B", done: false };
  const task = server.putTask(makeTask({ title: "タスク", bucket: "today", checklist: [a, b] }));
  return { server, a, b, task };
}

async function openToday(server: FakeServer) {
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await screen.findByRole("listbox", { name: "今日" });
  return store;
}

describe("ほかの画面が先にチェックリストを変えていたら、後の方は断られる", () => {
  it("★ 同じ状態から別々の項目をチェックすると、後の方が断られて知らせが出て、先の変更が残る", async () => {
    const { server, a, b, task } = setup();
    const store = await openToday(server);
    const other = await otherTab(server);
    const user = userEvent.setup();

    // ほかのタブが先に A をチェックする（この画面はまだ知らない）
    other.actions.updateTask(task.id, { checklist: [{ ...a, done: true }, b] });
    await other.idle();

    // この画面は古い配列のまま B をチェックする
    await user.keyboard("j{Enter}");
    await user.click(within(checklistGroup()).getByRole("checkbox", { name: "B" }));
    await act(async () => {
      await store.idle();
      await store.sync();
    });

    expect((await screen.findAllByText(CONFLICT_TOAST)).length).toBeGreaterThan(0);
    // 先の変更（A のチェック）が残り、後の変更（B のチェック）は捨てられている
    expect(server.tasks.get(task.id)?.checklist).toEqual([{ ...a, done: true }, b]);
    // 画面は最新を取りに行く
    expect(store.task(task.id)?.checklist).toEqual([{ ...a, done: true }, b]);
    expect(within(checklistGroup()).getByRole("checkbox", { name: "A" })).toBeChecked();
    expect(within(checklistGroup()).getByRole("checkbox", { name: "B" })).not.toBeChecked();
  });

  it("足そうとした項目の文字は「項目を追加」の下書きに戻る", async () => {
    const { server, a, b, task } = setup();
    const store = await openToday(server);
    const other = await otherTab(server);
    const user = userEvent.setup();

    other.actions.updateTask(task.id, {
      checklist: [a, b, { id: nextId(), title: "C", done: false }],
    });
    await other.idle();

    await user.keyboard("j{Enter}");
    const add = within(checklistGroup()).getByRole("textbox", { name: "項目を追加" });
    await user.type(add, "足したい項目{Enter}");
    await act(async () => {
      await store.idle();
      await store.sync();
    });

    expect((await screen.findAllByText(CONFLICT_TOAST)).length).toBeGreaterThan(0);
    expect(server.tasks.get(task.id)?.checklist.map((item) => item.title)).toEqual(["A", "B", "C"]);
    expect(store.task(task.id)?.checklist.map((item) => item.title)).toEqual(["A", "B", "C"]);
    expect(within(checklistGroup()).getByRole("textbox", { name: "項目を追加" })).toHaveValue(
      "足したい項目",
    );
  });

  it("⌘Z で戻すときも、ほかの画面が先に変えていたら断られる", async () => {
    const { server, a, b, task } = setup();
    const store = await openToday(server);
    const other = await otherTab(server);
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    await user.click(within(checklistGroup()).getByRole("checkbox", { name: "A" }));
    await act(async () => {
      await store.idle();
    });

    // この画面の同期より先に、ほかのタブが B をチェックする
    await act(async () => {
      await other.sync();
    });
    other.actions.updateTask(task.id, {
      checklist: [
        { ...a, done: true },
        { ...b, done: true },
      ],
    });
    await other.idle();

    await user.keyboard("{Escape}");
    await user.keyboard("{Meta>}z{/Meta}");
    await act(async () => {
      await store.idle();
      await store.sync();
    });

    expect((await screen.findAllByText(CONFLICT_TOAST)).length).toBeGreaterThan(0);
    expect(server.tasks.get(task.id)?.checklist).toEqual([
      { ...a, done: true },
      { ...b, done: true },
    ]);
  });
});

describe("同じ画面で続けて操作したときは断られない", () => {
  it("★ 1つ目の送信中に2つ目を操作しても、両方が保存される", async () => {
    const { server, a, b, task } = setup();
    const store = await openToday(server);
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    const release = server.hold("/api/mutate");
    await user.click(within(checklistGroup()).getByRole("checkbox", { name: "A" }));
    await user.click(within(checklistGroup()).getByRole("checkbox", { name: "B" }));
    const add = within(checklistGroup()).getByRole("textbox", { name: "項目を追加" });
    await user.type(add, "C{Enter}");
    release();
    await act(async () => {
      await store.idle();
    });

    expect(screen.queryAllByText(CONFLICT_TOAST)).toHaveLength(0);
    expect(
      server.tasks.get(task.id)?.checklist.map(({ title, done }) => ({ title, done })),
    ).toEqual([
      { title: a.title, done: true },
      { title: b.title, done: true },
      { title: "C", done: false },
    ]);
  });
});
