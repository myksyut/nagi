import "./features";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { ListUi } from "./tasks/list-ui";
import { TaskDetailPopoverHost, taskDetailPopoverOf } from "./tasks/task-detail-popover";
import { ToastHost } from "./tasks/toast-host";
import { UiProvider } from "./tasks/ui-context";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";

/**
 * チケット11：小さな詳細（task-detail-popover.tsx）。この時点ではどの画面にもつながっていないので、
 * ここで自分で描いて確かめる（13・14 がつなぐ）。中身はリストの詳細と同じなので、タイトル・メモ・
 * チェックリスト・いつやる・締切・プロジェクト・状態がどれもその場で直せることと、開閉・フォーカスの決まりを見る
 */

type Harness = {
  store: AppStore;
  ui: ListUi;
  stop: () => void;
};

const harnesses: Harness[] = [];
afterEach(() => {
  for (const { stop, store } of harnesses.splice(0)) {
    stop();
    store.dispose();
  }
});

async function setupHarness(server: FakeServer, taskId: string) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  await store.start();
  await act(async () => {
    await store.sync();
  });
  const ui = new ListUi(store);
  const stop = ui.start();
  harnesses.push({ store, ui, stop });

  render(
    <StoreProvider store={store}>
      <UiProvider ui={ui}>
        <ToastHost toaster={ui.toaster}>
          <button
            type="button"
            onClick={(event) => taskDetailPopoverOf(ui).open(taskId, event.currentTarget)}
          >
            開く
          </button>
          <TaskDetailPopoverHost />
        </ToastHost>
      </UiProvider>
    </StoreProvider>,
  );

  return { store, ui };
}

function checklistGroup() {
  return screen.getByRole("group", { name: "チェックリスト" });
}

describe("開く・閉じる・フォーカス", () => {
  it("押すと role=dialog（「B」の詳細）が開き、タイトルを直して Enter で保存されて閉じ、押した「開く」ボタンへフォーカスが戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    const openButton = screen.getByRole("button", { name: "開く" });
    await user.click(openButton);
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });
    // 中ではアプリの1文字のキーを止める（キーマップは data-keymap="off" の中のキーを受けない。keymap.test.ts）
    expect(dialog).toHaveAttribute("data-keymap", "off");
    const title = within(dialog).getByRole("textbox", { name: "タイトル" });
    expect(title).toHaveValue("B");

    await user.clear(title);
    await user.type(title, "新しいB{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(openButton);
    expect(store.task(task.id)?.title).toBe("新しいB");
  });

  it("Esc で閉じて押した「開く」ボタンへフォーカスが戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    await setupHarness(server, task.id);
    const user = userEvent.setup();

    const openButton = screen.getByRole("button", { name: "開く" });
    await user.click(openButton);
    await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(openButton);
  });

  it("外を押すと閉じる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("タスクが削除されたら閉じる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    await screen.findByRole("dialog", { name: "「B」の詳細" });

    server.putTask({ id: task.id, deletedAt: "2026-01-02T00:00:00.000Z" });
    await act(async () => {
      await store.sync();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("中身の編集：メモ・チェックリスト", () => {
  it("メモを書ける", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: "メモを書く" }));
    const memo = within(dialog).getByRole("textbox", { name: "メモ" });
    await user.type(memo, "メモの中身");
    await user.click(within(dialog).getByRole("textbox", { name: "タイトル" }));

    await waitFor(() => expect(store.task(task.id)?.memo).toBe("メモの中身"));
  });

  it("チェックリストに項目を足してチェックできる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    await screen.findByRole("dialog", { name: "「B」の詳細" });

    const add = within(checklistGroup()).getByRole("textbox", { name: "項目を追加" });
    await user.type(add, "項目A{Enter}");
    await waitFor(() =>
      expect(store.task(task.id)?.checklist.map((item) => item.title)).toEqual(["項目A"]),
    );

    await user.click(within(checklistGroup()).getByRole("checkbox", { name: "項目A" }));
    await waitFor(() => expect(store.task(task.id)?.checklist[0]?.done).toBe(true));
  });
});

describe("いつやる・締切・プロジェクト", () => {
  it("「いつやる」から日付の入力が開き、「明日」Enter で予定になる。誤ったトーストは出ない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "later" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: /^いつやる/ }));
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "明日{Enter}");

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("scheduled"));
    // 一覧に行がないため、「「B」を今日へ」のような誤ったトーストは出ない（今回直した不具合）
    expect(screen.queryByText(/「B」を/)).toBeNull();
  });

  it("「締切を付ける」から締切を付けられる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "later" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: "締切を付ける" }));
    const input = await screen.findByRole("textbox", { name: "締切" });
    await user.type(input, "2099-01-01{Enter}");

    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2099-01-01"));
    expect(screen.queryByText(/「B」を今日へ/)).toBeNull();
  });

  it("「プロジェクトを付ける」から候補で選べる", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "AIPR" }));
    const task = server.putTask(makeTask({ title: "B", bucket: "today" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: "プロジェクトを付ける" }));
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "aipr{Enter}");

    await waitFor(() => expect(store.task(task.id)?.projectId).toBe(project.id));
    expect(
      await within(dialog).findByRole("button", { name: "プロジェクト：AIPR" }),
    ).toBeInTheDocument();
  });

  it("状態のボタンで進行中にできる（あとでのタスクなら今日へ移る）。誤ったトーストは出ない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "later" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: "状態：未着手" }));

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(store.task(task.id)?.startedAt).not.toBeNull();
    expect(await within(dialog).findByRole("button", { name: "状態：進行中" })).toBeInTheDocument();
    expect(screen.queryByText(/「B」を今日へ/)).toBeNull();
  });

  it("日付の入力や候補の中で Esc を押すと、その小さなポップオーバーだけが閉じ、小さな詳細は開いたまま。フォーカスは押した小さなボタンへ戻る", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    const task = server.putTask(makeTask({ title: "B", bucket: "later" }));
    await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    const whenButton = within(dialog).getByRole("button", { name: /^いつやる/ });
    await user.click(whenButton);
    await screen.findByRole("textbox", { name: "予定の日付" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "「B」の詳細" })).toBeInTheDocument();
    expect(document.activeElement).toBe(whenButton);

    const projectButton = within(dialog).getByRole("button", { name: "プロジェクトを付ける" });
    await user.click(projectButton);
    await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "「B」の詳細" })).toBeInTheDocument();
    expect(document.activeElement).toBe(projectButton);
  });

  it("日付の入力のカレンダーの日を押しても小さな詳細は閉じない", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "B", bucket: "later" }));
    const { store } = await setupHarness(server, task.id);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });

    await user.click(within(dialog).getByRole("button", { name: /^いつやる/ }));
    await screen.findByRole("textbox", { name: "予定の日付" });
    const calendarButtons = screen.getAllByRole("button", { name: /\d+年\d+月\d+日/ });
    const day = calendarButtons.at(-1);
    expect(day).toBeDefined();
    await user.click(day as HTMLElement);

    expect(screen.queryByRole("textbox", { name: "予定の日付" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "「B」の詳細" })).toBeInTheDocument();
    expect(store.task(task.id)?.bucket).toBe("scheduled");
  });
});
