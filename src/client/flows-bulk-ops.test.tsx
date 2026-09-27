import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, pickerListbox, setupApp } from "./test/render-app";

/**
 * 7 の完了の条件2：受信箱で3件を選んで t を押すとまとめて今日へ移り、⌘Z でまとめて戻る。
 * あわせて、l・x・⌘⌫・d・⇧D・p の複数選択と、500件の上限（B の完了の条件）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openInbox(server: FakeServer, path = "/inbox", name = "受信箱") {
  const { store } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name });
  return store;
}

function threeInboxTasks() {
  const server = new FakeServer();
  for (const [i, title] of ["A", "B", "C", "D"].entries()) {
    server.putTask(
      makeTask({ title, bucket: "inbox", createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );
  }
  return server;
}

describe("完了の条件2：受信箱で3件を選んで t、⌘Z でまとめて戻る", () => {
  it("3件を今日へ。トーストと1回のまとまりでの送信、⌘Z で受信箱の元の順に戻る", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);
    const before = server.requestsTo("/api/mutate").length;

    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}"); // A,B,C
    await user.keyboard("t");

    expect(optionTitles("受信箱")).toEqual(["D"]);
    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "B", "C"]);
    expect(await screen.findByText("3件を今日へ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeInTheDocument();

    await act(async () => {
      await store.idle();
    });
    expect(server.requestsTo("/api/mutate").length).toBe(before + 1);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C", "D"]);
    expect(store.lists.today).toHaveLength(0);
  });

  it("トーストの「元に戻す」ボタンからも戻せる", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    await openInbox(server);

    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("t");
    await user.click(await screen.findByRole("button", { name: "元に戻す" }));
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C", "D"]);
  });
});

describe("l・x・⌘⌫ もまとめてかかる", () => {
  it("l：3件をあとでへ", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);

    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("l");
    expect(optionTitles("受信箱")).toEqual(["D"]);
    expect(store.lists.later.map((t) => t.title)).toEqual(["A", "B", "C"]);
    expect(await screen.findByText("3件をあとでへ")).toBeInTheDocument();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C", "D"]);
  });

  it("x：今日で複数を完了すると「完了 N件」へ入り、選択は次の行へ", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (const [i, title] of ["A", "B", "C", "D"].entries()) {
      server.putTask(makeTask({ title, bucket: "today", rank: `a${i}` }));
    }
    const store = await openInbox(server, "/today", "今日");

    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}"); // A,B,C
    await user.keyboard("x");
    expect(optionTitles("今日")).toEqual(["D"]);
    expect(store.lists.completedTodayCount).toBe(3);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("D");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.completedTodayCount).toBe(0);
    expect(optionTitles("今日")).toEqual(["A", "B", "C", "D"]);
  });

  it("x：今日以外では「3件を完了しました」と出る", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("x");
    expect(await screen.findByText("3件を完了しました")).toBeInTheDocument();
  });

  it("⌘⌫：3件を削除。「3件を削除しました」、⌘Z で戻る", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("{Meta>}{Backspace}{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["D"]);
    expect(await screen.findByText("3件を削除しました")).toBeInTheDocument();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C", "D"]);
    expect(store.lists.inbox).toHaveLength(4);
  });
});

describe("d・⇧D：複数選んで日付の入力を1回だけ開き、すべてにかける", () => {
  it("d：決めた日付がすべての行にかかる（1つの操作、⌘Z 1回で戻る）", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("d");

    // 日付の入力は1つだけ開く
    expect(screen.getAllByRole("textbox", { name: "予定の日付" })).toHaveLength(1);
    const input = screen.getByRole("textbox", { name: "予定の日付" });
    await user.type(input, "2099/1/1{Enter}");

    expect(store.lists.scheduled.map((t) => t.title).sort()).toEqual(["A", "B", "C"]);
    for (const task of store.lists.scheduled) expect(task.scheduledOn).toBe("2099-01-01");

    await act(async () => {
      await store.idle();
    });
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.scheduled).toHaveLength(0);
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C", "D"]);
  });

  it("⇧D：締切も同じように複数へ、空の Enter で外せる", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("{Shift>}d{/Shift}");
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "2099/1/1{Enter}");

    const ids = store.lists.inbox.slice(0, 3).map((t) => t.id);
    for (const id of ids) expect(store.task(id)?.deadlineOn).toBe("2099-01-01");

    // もう一度開いて、空のまま Enter で外す（一度選択を外してから、先頭から選び直す）
    await user.keyboard("{Escape}");
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("{Shift>}d{/Shift}");
    const input2 = await screen.findByRole("textbox", { name: "締切" });
    await user.keyboard("{Enter}");
    for (const id of ids) expect(store.task(id)?.deadlineOn).toBeNull();
    void input2;
  });
});

describe("p：複数選んで候補を1回だけ開き、選んだプロジェクトをすべてに付ける", () => {
  it("既存のプロジェクトを選ぶと3件すべてに付く", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    server.putProject(makeProject({ name: "AIPR" }));
    const store = await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("p");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "aipr{Enter}");

    const targets = store.lists.inbox.slice(0, 3);
    expect(targets).toHaveLength(3);
    for (const task of targets) expect(task.projectId).not.toBeNull();
  });

  it("「「◯◯」を作成」は作って全員に付けるまでを1つの操作（⌘Z 1回で両方戻る）", async () => {
    const user = userEvent.setup();
    const server = threeInboxTasks();
    const store = await openInbox(server);
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.keyboard("p");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "新規");
    expect(
      within(pickerListbox()).getByRole("option", { name: "「新規」を作成" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");

    const project = store.lists.projects.find((p) => p.name === "新規");
    expect(project).toBeDefined();
    const targets = store.lists.inbox.slice(0, 3);
    for (const task of targets) expect(task.projectId).toBe(project?.id);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects.some((p) => p.name === "新規")).toBe(false);
    for (const task of store.lists.inbox.slice(0, 3)) expect(task.projectId).toBeNull();
  });
});

describe("完了の条件（B）：500件を超えると断り、500件ならちょうど実行できる", () => {
  function bigInbox(count: number) {
    const server = new FakeServer();
    for (let i = 0; i < count; i++) {
      server.putTask(
        makeTask({
          title: `T${i}`,
          bucket: "inbox",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    return server;
  }

  it("501件では、t・l・x・⌘⌫・d・⇧D・p・⌥↑↓ のどれも実行されず「一度に扱えるのは 500 件まで」", async () => {
    const user = userEvent.setup();
    const server = bigInbox(501);
    const store = await openInbox(server);
    const beforeMutate = server.requestsTo("/api/mutate").length;

    await user.keyboard("j");
    const list = screen.getByRole("listbox", { name: "受信箱" });
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(501);

    const tryAndExpectBlocked = async (fire: () => Promise<void> | void) => {
      await fire();
      await waitFor(() =>
        expect(screen.getAllByText("一度に扱えるのは 500 件まで").length).toBeGreaterThan(0),
      );
      expect(store.lists.inbox).toHaveLength(501);
      expect(server.requestsTo("/api/mutate").length).toBe(beforeMutate);
    };

    await tryAndExpectBlocked(() => user.keyboard("t"));
    await tryAndExpectBlocked(() => user.keyboard("l"));
    await tryAndExpectBlocked(() => user.keyboard("x"));
    await tryAndExpectBlocked(() => user.keyboard("{Meta>}{Backspace}{/Meta}"));
    await tryAndExpectBlocked(() => user.keyboard("{Shift>}d{/Shift}"));
    expect(screen.queryByRole("textbox", { name: "締切" })).toBeNull();
    await tryAndExpectBlocked(() => user.keyboard("d"));
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    await tryAndExpectBlocked(() => user.keyboard("p"));
    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    // 501件は今日・あとでのまとまりの中にいないので ⌥↑↓ はそもそも when が false（キーを奪わない）。
    // ここでは今日の501件で確かめる
  }, 30000);

  it("501件のうち、今日で ⌥↑↓ を試みても動かない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (let i = 0; i < 501; i++) {
      server.putTask(makeTask({ title: `T${i}`, bucket: "today", rank: `a${i}` }));
    }
    const store = await openInbox(server, "/today", "今日");
    await user.keyboard("j");
    const list = screen.getByRole("listbox", { name: "今日" });
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(501);
    const before = store.lists.today.map((t) => t.id);
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    await waitFor(() =>
      expect(screen.getAllByText("一度に扱えるのは 500 件まで").length).toBeGreaterThan(0),
    );
    expect(store.lists.today.map((t) => t.id)).toEqual(before);
  }, 30000);

  it("500件ならちょうど実行できる", async () => {
    const user = userEvent.setup();
    const server = bigInbox(501);
    const store = await openInbox(server);
    await user.keyboard("j");
    const list = screen.getByRole("listbox", { name: "受信箱" });
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    // 一番上を外して500件にする
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(500);
    await user.keyboard("t");
    expect(store.lists.inbox).toHaveLength(1);
    expect(await screen.findByText("500件を今日へ")).toBeInTheDocument();
  }, 30000);
});
