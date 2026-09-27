import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * 7 の完了の条件1：今日で ⌥↑↓ で並べ替えた順番が、再読み込みしても保たれる。
 * 並べ替えられる場面の制限（今日・あとで・プロジェクトの今日とあとでだけ）と、ドラッグでの移動
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

/**
 * happy-dom の DragEvent は clientY を init から受け取らない（Event にフォールバックする）ので、
 * clientY をイベントに直接乗せて配る。それ以外は fireEvent.dragOver と同じ
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

async function open(path: string, server: FakeServer, name: string) {
  const { store, location } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name });
  return { store, location };
}

describe("完了の条件1：⌥↑↓ で並べ替えた順が、再読み込みしても保たれる", () => {
  it("今日で ⌥↓・⌥↑ で並べ替え、新しい AppStore で読み直しても同じ順", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const { store } = await open("/today", server, "今日");
    const beforeMutate = server.requestsTo("/api/mutate").length;

    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}"); // A を1つ下へ：B,A,C
    expect(optionTitles("今日")).toEqual(["B", "A", "C"]);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}"); // もう1つ下へ：B,C,A
    expect(optionTitles("今日")).toEqual(["B", "C", "A"]);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}"); // 1つ上へ戻す：B,A,C
    expect(optionTitles("今日")).toEqual(["B", "A", "C"]);

    await act(async () => {
      await store.idle();
    });

    // 送った mutation は、動かした行の rank だけ（ほかの行の rank は含まれない）
    const mutateRequests = server.requestsTo("/api/mutate").slice(beforeMutate);
    for (const request of mutateRequests) {
      const body = request.body as { mutations: { type: string; changes?: object }[] };
      for (const mutation of body.mutations) {
        expect(mutation.type).toBe("task.update");
        expect(Object.keys(mutation.changes ?? {})).toEqual(["rank"]);
      }
    }

    const fresh = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
    });
    stores.push(fresh);
    await fresh.start();
    expect(fresh.lists.today.map((t) => t.title)).toEqual(["B", "A", "C"]);
  });

  it("端では動かない（一番上で ⌥↑、一番下で ⌥↓）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (const [i, title] of ["A", "B"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    await open("/today", server, "今日");
    await user.keyboard("j"); // A
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(optionTitles("今日")).toEqual(["A", "B"]);
    await user.keyboard("jj"); // B（一番下）
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(optionTitles("今日")).toEqual(["A", "B"]);
  });

  it("複数選んで ⌥↓ すると、まとめて1つ動く", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C", "D"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    await open("/today", server, "今日");
    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}"); // A,B
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(optionTitles("今日")).toEqual(["C", "A", "B", "D"]);
  });
});

describe("並べ替えられるのは今日・あとで・プロジェクトの今日とあとでだけ", () => {
  it("受信箱では ⌥↓ は並びを変えず、キーを奪わない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "inbox", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "inbox", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    await open("/inbox", server, "受信箱");
    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}");
    expect(optionTitles("受信箱")).toEqual(["A", "B"]);
  });

  it("予定・完了ログでは並びが変わらない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "scheduled", scheduledOn: "2099-01-01" }));
    server.putTask(makeTask({ title: "B", bucket: "scheduled", scheduledOn: "2099-01-02" }));
    await open("/upcoming", server, "予定");
    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}");
    expect(optionTitles("予定")).toEqual(["A", "B"]);
  });

  it("あとでのプロジェクトのまとまりの中で並べ替えられる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "A", bucket: "later", projectId: project.id, rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "later", projectId: project.id, rank: "a1" }));
    const { store } = await open("/later", server, "あとで");
    await user.keyboard("j{Alt>}{ArrowDown}{/Alt}");
    expect(store.lists.later.map((t) => t.title)).toEqual(["B", "A"]);
  });

  it("まとまりをまたいで選んでいると動かない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "なし", bucket: "later", rank: "a0" }));
    server.putTask(makeTask({ title: "A", bucket: "later", projectId: project.id, rank: "a1" }));
    const { store } = await open("/later", server, "あとで");
    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}"); // なし, A（別のまとまり）
    const before = store.lists.later.map((t) => t.id);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect(store.lists.later.map((t) => t.id)).toEqual(before);
  });
});

describe("ドラッグ", () => {
  it("同じまとまりの中で、行の前・後ろに落とすと並べ替わる", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const { store } = await open("/today", server, "今日");
    const a = screen.getByRole("option", { name: /^A/ });
    const c = screen.getByRole("option", { name: /^C/ });
    fireEvent.dragStart(a);
    // happy-dom では要素の位置が0なので、clientY 0 以上は「後ろ」
    dragOverWithY(c, 10);
    fireEvent.drop(c);
    fireEvent.dragEnd(a);
    expect(optionTitles("今日")).toEqual(["B", "C", "A"]);
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "C", "A"]);
  });

  it("行の前へ落とす（clientY が負）", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    await open("/today", server, "今日");
    const c = screen.getByRole("option", { name: /^C/ });
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(c);
    dragOverWithY(a, -10);
    fireEvent.drop(a);
    expect(optionTitles("今日")).toEqual(["C", "A", "B"]);
  });

  it("複数選んだ行をつかむと、まとめて運ぶ", async () => {
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C", "D"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const user = userEvent.setup();
    await open("/today", server, "今日");
    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}"); // A,B
    const a = screen.getByRole("option", { name: /^A/ });
    const d = screen.getByRole("option", { name: /^D/ });
    fireEvent.dragStart(a);
    dragOverWithY(d, 10);
    fireEvent.drop(d);
    expect(optionTitles("今日")).toEqual(["C", "D", "A", "B"]);
  });

  it("サイドバーの「今日」「あとで」に落とすと移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await open("/inbox", server, "受信箱");
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(a);
    const later = screen.getByRole("link", { name: "あとで" });
    fireEvent.dragOver(later);
    fireEvent.drop(later);
    expect(optionTitles("受信箱")).toEqual([]);
    expect(store.lists.later.map((t) => t.title)).toEqual(["A"]);
  });

  it("プロジェクトに落とすと、そのプロジェクトが付く（置き場は変わらない）", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const { store } = await open("/inbox", server, "受信箱");
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(a);
    const p = screen.getByRole("link", { name: "P" });
    fireEvent.dragOver(p);
    fireEvent.drop(p);
    // 置き場は変わらない（受信箱に残る。行にはプロジェクト名も出る）
    expect(store.lists.inbox.map((t) => t.title)).toEqual(["A"]);
    expect(store.lists.inbox[0]?.projectId).toBe(project.id);
  });

  it("「予定」に落とすと日付の入力が開き、決めると予定へ移る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "inbox" }));
    const user = userEvent.setup();
    const { store } = await open("/inbox", server, "受信箱");
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(a);
    const upcoming = screen.getByRole("link", { name: "予定" });
    fireEvent.dragOver(upcoming);
    fireEvent.drop(upcoming);
    const date = await screen.findByRole("textbox", { name: "予定の日付" });
    await waitFor(() => expect(date).toHaveFocus());
    await user.type(date, "2099/1/1{Enter}");
    expect(store.lists.scheduled.map((t) => t.title)).toEqual(["A"]);
  });

  it("「受信箱」「完了ログ」には落とせない（dragOver で preventDefault されない）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    server.putTask(
      makeTask({ title: "済み", bucket: "later", completedAt: "2026-01-01T00:00:00.000Z" }),
    );
    await open("/today", server, "今日");
    const a = screen.getByRole("option", { name: /^A/ });
    fireEvent.dragStart(a);
    const inbox = screen.getByRole("link", { name: "受信箱" });
    const defaultPrevented1 = !fireEvent.dragOver(inbox);
    expect(defaultPrevented1).toBe(false);
    const logbook = screen.getByRole("link", { name: "完了ログ" });
    const defaultPrevented2 = !fireEvent.dragOver(logbook);
    expect(defaultPrevented2).toBe(false);
  });

  it("開いている行と完了した行はつかめない（draggable が false）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "開いた", bucket: "today", rank: "a0" }));
    const user = userEvent.setup();
    await open("/today", server, "今日");
    await user.keyboard("j{Enter}"); // 開く
    const opened = screen.getByRole("option", { name: /^開いた/ });
    expect(opened).toHaveAttribute("draggable", "false");
  });
});
