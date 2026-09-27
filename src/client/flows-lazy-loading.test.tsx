import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 8-修正1 の 1・2：後から読み込む部品（⌘K・日付の入力・p の候補）が届く前に打ったキーは、別の操作にならず、
 * 届いたら入力欄へ移る。読み込めなかったときは「読み込めませんでした・もう一度」から読み直せる。
 * import を止めておける門（gate）を挟み、先読みはしない
 */

const gates = vi.hoisted(() => {
  (globalThis as { NAGI_NO_PRELOAD?: boolean }).NAGI_NO_PRELOAD = true;
  type Gate = { promise: Promise<void>; open: () => void; fail: () => void; failing: boolean };
  const make = (): Gate => {
    const gate = {} as Gate;
    gate.failing = false;
    gate.promise = new Promise<void>((resolve, reject) => {
      gate.open = resolve;
      gate.fail = () => reject(new Error("読み込めない"));
    });
    return gate;
  };
  return { make, palette: make(), date: make(), picker: make() };
});

vi.mock("./features/command-palette/command-palette", async (importOriginal) => {
  await gates.palette.promise;
  return importOriginal();
});
vi.mock("./features/dates/date-entry-panel", async (importOriginal) => {
  await gates.date.promise;
  return importOriginal();
});
vi.mock("./features/projects/picker-popup", async (importOriginal) => {
  await gates.picker.promise;
  return importOriginal();
});

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // 起動のあとの空いた時間の先読みを止める（読み込みの回数と順番を、テストの操作だけで決めるため）
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
});

async function open(server: FakeServer) {
  const { store } = await setupApp("/inbox", server, { preload: false });
  stores.push(store);
  await act(async () => store.sync());
  await screen.findByRole("listbox", { name: "受信箱" });
  return store;
}

describe("届く前に打ったキー", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("⌘K の直後の t は、選んでいるタスクを今日へ動かさず、届いたら検索欄に入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "受信箱のタスク", bucket: "inbox" }));
    const store = await open(server);

    await user.keyboard("j{Meta>}k{/Meta}t");
    // 待ちの欄が受け止める（別の操作にならない）
    expect(screen.getByRole("textbox", { name: "検索とコマンド" })).toHaveValue("t");
    expect(store.task(task.id)?.bucket).toBe("inbox");

    await act(async () => gates.palette.open());
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    expect(input).toHaveValue("t");
    await waitFor(() => expect(input).toHaveFocus());
    expect(store.task(task.id)?.bucket).toBe("inbox");
  });

  it("d の直後に打った文字は、ほかの操作にならず、届いたら日付の入力欄に入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "受信箱のタスク", bucket: "inbox" }));
    const store = await open(server);

    // t（今日へ）・l（あとでへ）・x（完了）を含む文字を打つ
    await user.keyboard("jdtlx");
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toHaveValue("tlx");
    const row = store.task(task.id);
    expect(row?.bucket).toBe("inbox");
    expect(row?.completedAt).toBeNull();

    await act(async () => gates.date.open());
    // 待ちの欄が本物の日付の入力（カレンダー付き）に替わり、打った文字が入っている
    // 本物の日付の入力（カレンダーを含む）を初めて読み込むので、少し長めに待つ
    await waitFor(() => expect(document.querySelector('[data-slot="waiting-input"]')).toBeNull(), {
      timeout: 5000,
    });
    expect(screen.getByRole("textbox", { name: "予定の日付" })).toHaveValue("tlx");
  });

  it("p の直後に打った文字は、ほかの操作にならず、届いたら候補の入力欄に入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    const task = server.putTask(makeTask({ title: "受信箱のタスク", bucket: "inbox" }));
    const store = await open(server);

    await user.keyboard("jptx");
    expect(screen.getByRole("textbox", { name: "プロジェクト" })).toHaveValue("tx");
    expect(store.task(task.id)?.bucket).toBe("inbox");
    expect(store.task(task.id)?.completedAt).toBeNull();

    await act(async () => gates.picker.open());
    expect(await screen.findByRole("combobox", { name: "プロジェクト" })).toHaveValue("tx");
  });
});
