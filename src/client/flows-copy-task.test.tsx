import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import type { KeyContext } from "./keyboard/keymap";
import { useKeymap } from "./keyboard/use-keymap";
import { ListUi, type ListView } from "./tasks/list-ui";
import { TaskDetailPopoverHost, taskDetailPopoverOf } from "./tasks/task-detail-popover";
import { TaskList } from "./tasks/task-list";
import { ToastHost } from "./tasks/toast-host";
import { NOTICE_TOAST_MS } from "./tasks/toaster";
import { UiProvider } from "./tasks/ui-context";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * チケット21：選んでいるタスクのタイトルとメモを、⇧⌘C でクリップボードに入れる。
 * 形の細かいところ（空白・空の行）は features/copy/task-text.test.ts で見る。ここでは画面を通した流れを見る
 * （クリップボードは user-event の setup が navigator.clipboard に置く偽物）。トーストの文字は、読み上げのための
 * 知らせにも同じ文字が出ることがあるので、findAllByText で見る
 */

const stores: AppStore[] = [];
/** 自分で描いた土台（小さな詳細）の ListUi を止める */
const stops: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) store.dispose();
});

async function open(path: string, server = new FakeServer()) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

const COPY = "{Meta>}{Shift>}c{/Shift}{/Meta}";

/**
 * ⇧⌘C を1回、その場で配る（今フォーカスのある要素へ）。キーを奪わなければ（既定の動きを止めなければ）true。
 * user-event と違って配り終えたところで戻るので、キーの処理の中でクリップボードに入れたかも見られる
 */
function pressCopy(target: Element = document.activeElement ?? document.body): boolean {
  return fireEvent.keyDown(target, { key: "c", code: "KeyC", metaKey: true, shiftKey: true });
}

function todayServer() {
  const server = new FakeServer();
  server.putTask(
    makeTask({
      title: "見積もりを確認",
      memo: "先方の金額は 10/3 まで",
      bucket: "today",
      rank: "a0",
    }),
  );
  server.putTask(makeTask({ title: "資料を送る", memo: "", bucket: "today", rank: "a1" }));
  return server;
}

describe("⇧⌘C でコピー", () => {
  it("選んだタスクのタイトルとメモが入り、トーストで知らせる", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("見積もりを確認\n\n先方の金額は 10/3 まで"),
    );
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
  });

  it("メモが空なら、タイトルだけが入り、「タイトルをコピーしました」", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^資料を送る/ }));
    await user.keyboard(COPY);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("資料を送る"));
    expect((await screen.findAllByText("タイトルをコピーしました")).length).toBeGreaterThan(0);
  });

  it("何件か選んでいれば、上から見えている順に --- をはさんで入る", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "見積もりを確認\n\n先方の金額は 10/3 まで\n\n---\n\n資料を送る",
      ),
    );
    expect(
      (await screen.findAllByText("2件のタイトルとメモをコピーしました")).length,
    ).toBeGreaterThan(0);
  });

  it("入力欄の中では効かない（クリップボードは変わらない）", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await navigator.clipboard.writeText("前のもの");
    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "今日に追加" }), "新しい");
    await user.keyboard(COPY);
    expect(await navigator.clipboard.readText()).toBe("前のもの");
    expect(screen.queryAllByText(/コピーしました/)).toHaveLength(0);
  });

  it("入れられなかったら「コピーできませんでした」", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard(COPY);
    expect((await screen.findAllByText("コピーできませんでした")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/コピーしました/)).toHaveLength(0);
  });

  it("⌘K の「タイトルとメモをコピー」からも入る", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^資料を送る/ }));
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "タイトルとメモをコピー{Enter}");
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("資料を送る"));
  });

  it("キーを奪い、押したその処理の中でクリップボードに入れる（ブラウザによっては、操作の中でないと断る）", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    expect(pressCopy()).toBe(false);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("見積もりを確認\n\n先方の金額は 10/3 まで");
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
  });
});

describe("⇧⌘C：ボード・完了ログ・開いたタスク", () => {
  it("今日のボード（v）で選んだカードが入る（進行中の列のカードも）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(
      makeTask({
        title: "B",
        memo: "途中まで書いた",
        bucket: "today",
        rank: "a1",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "今日のボード" });

    await user.keyboard("j{ArrowRight}"); // 未着手の A から、進行中の B へ
    expect(within(board).getByRole("option", { selected: true })).toHaveTextContent(/^B/);
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("B\n\n途中まで書いた"),
    );
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
  });

  it("プロジェクトのボード（v）で選んだカードが入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(
      makeTask({ title: "企画書", memo: "骨子だけ", bucket: "later", projectId: project.id }),
    );
    await open(`/projects/${project.id}`, server);
    await screen.findByRole("listbox", { name: "P" });
    await user.keyboard("v");
    await screen.findByRole("listbox", { name: "Pのボード" });

    await user.keyboard("j");
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("企画書\n\n骨子だけ"),
    );
  });

  it("完了ログで選んだ完了済みのタスクが入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "請求書を送った",
        memo: "控えは共有フォルダ",
        bucket: "later",
        completedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await open("/logbook", server);
    await screen.findByRole("listbox", { name: "完了ログ" });

    await user.keyboard("j");
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("請求書を送った\n\n控えは共有フォルダ"),
    );
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
  });

  it("開いたタスク（フォーカスは一覧）でも入る。メモの欄の中では効かず、書き直して保存したあとは新しいメモが入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "見積もりを確認", memo: "前のメモ", bucket: "today", rank: "a0" }),
    );
    const { store } = await open("/today", server);
    const list = await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j{Enter}");
    expect(screen.getByRole("button", { name: "メモを直す" })).toBeInTheDocument();
    expect(list).toHaveFocus();
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("見積もりを確認\n\n前のメモ"),
    );

    // メモの欄で書き直しているあいだは、⇧⌘C は欄に任せる（ほかのタスクのキーと同じ）
    await user.click(screen.getByRole("button", { name: "メモを直す" }));
    const memo = screen.getByRole("textbox", { name: "メモ" });
    await user.clear(memo);
    await user.type(memo, "新しいメモ");
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    expect(pressCopy(memo)).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    // Esc で保存して閉じ、もう一度開いて ⇧⌘C
    await user.keyboard("{Escape}");
    expect(store.task(task.id)?.memo).toBe("新しいメモ");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "メモを直す" })).toBeInTheDocument();
    expect(list).toHaveFocus();
    await user.keyboard(COPY);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith("見積もりを確認\n\n新しいメモ"),
    );
  });
});

describe("⇧⌘C が効かないとき", () => {
  it("何も選んでいないときはキーを奪わず、クリップボードもトーストも変わらない。⌘K にも出ない", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await screen.findByRole("listbox", { name: "今日" });
    expect(screen.queryAllByRole("option", { selected: true })).toHaveLength(0);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    expect(pressCopy()).toBe(true);
    await user.keyboard(COPY);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryAllByText(/コピー/)).toHaveLength(0);

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    // 一覧が描かれてから絞り込む（描く前に「ない」を確かめてしまわないように）
    await screen.findByText("今日を開く");
    await user.type(input, "タイトルとメモをコピー");
    await waitFor(() => expect(screen.queryByText("今日を開く")).toBeNull());
    expect(screen.queryByText("タイトルとメモをコピー")).toBeNull();
  });

  it("小さな詳細（ポップオーバー）の中では、一覧で選んでいてもキーを奪わず入れない。閉じれば一覧で選んだタスクが入る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", memo: "a のメモ", bucket: "today", rank: "a0" }));
    const b = server.putTask(
      makeTask({ title: "B", memo: "b のメモ", bucket: "today", rank: "a1" }),
    );
    await setupListAndPopover(server, b.id);
    const user = userEvent.setup();

    await user.keyboard("j"); // 一覧の A を選ぶ
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent(/^A/);
    await user.click(screen.getByRole("button", { name: "開く" }));
    const dialog = await screen.findByRole("dialog", { name: "「B」の詳細" });
    await waitFor(() => expect(dialog).toContainElement(document.activeElement as HTMLElement));
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    expect(pressCopy()).toBe(true);
    await user.keyboard(COPY);
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryAllByText(/コピー/)).toHaveLength(0);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.keyboard(COPY);
    await waitFor(() => expect(writeText).toHaveBeenCalledExactlyOnceWith("A\n\na のメモ"));
  });

  it("選択が 500 件を超えると、入れずに「一度に扱えるのは 500 件まで」。500 件ならちょうど入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    for (let i = 0; i < 501; i++) {
      server.putTask(
        makeTask({
          title: `T${i}`,
          bucket: "inbox",
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        }),
      );
    }
    await open("/inbox", server);
    const list = await screen.findByRole("listbox", { name: "受信箱" });
    await user.keyboard("j");
    act(() => {
      for (let i = 0; i < 500; i++) fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(501);
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    await user.keyboard(COPY);
    expect((await screen.findAllByText("一度に扱えるのは 500 件まで")).length).toBeGreaterThan(0);
    expect(writeText).not.toHaveBeenCalled();

    // 一番下を外して 500 件にする
    act(() => {
      fireEvent.keyDown(list, { key: "ArrowUp", shiftKey: true });
    });
    expect(screen.getAllByRole("option", { selected: true })).toHaveLength(500);
    await user.keyboard(COPY);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]?.[0].split("\n\n---\n\n")).toEqual(
      Array.from({ length: 500 }, (_, i) => `T${i}`),
    );
    expect(
      (await screen.findAllByText("500件のタイトルとメモをコピーしました")).length,
    ).toBeGreaterThan(0);
  }, 30000);
});

describe("コピーの知らせと「元に戻す」のトースト", () => {
  function inboxServer() {
    const server = new FakeServer();
    const a = server.putTask(
      makeTask({
        title: "A",
        memo: "a のメモ",
        bucket: "inbox",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "inbox", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    return { server, a };
  }

  it("完了の「元に戻す」のあとにコピーしても、⌘Z で完了を戻せる", async () => {
    const user = userEvent.setup();
    const { server, a } = inboxServer();
    const { store } = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("jx"); // A を完了。選択は B へ
    expect((await screen.findAllByText("完了しました")).length).toBeGreaterThan(0);
    await user.keyboard(COPY);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("B"));
    expect((await screen.findAllByText("タイトルをコピーしました")).length).toBeGreaterThan(0);

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.task(a.id)?.completedAt).toBeNull();
    expect(optionTitles("受信箱")).toEqual(["A", "B"]);
  });

  it("「元に戻す」のトーストは、コピーの知らせが出ているあいだは後ろに下がり、知らせが消えるとまた出て押せる", async () => {
    const { server, a } = inboxServer();
    const { store } = await open("/inbox", server);
    const list = await screen.findByRole("listbox", { name: "受信箱" });
    userEvent.setup(); // クリップボードの偽物を置く
    // トーストの時間を進めるため、キーはその場で配る（user-event はタイマーの偽物と合わせると止まる）
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // 「元に戻す」のボタンがあるトースト（role=dialog）
    const undoToast = () =>
      screen.getByRole("button", { name: "元に戻す" }).closest("[role='dialog']");

    fireEvent.keyDown(list, { key: "j" });
    fireEvent.keyDown(list, { key: "x" }); // A を完了。選択は B へ
    expect(undoToast()).not.toHaveAttribute("inert");
    pressCopy(list);
    await act(async () => {}); // クリップボードに入れ終えるのを待つ
    expect(screen.getAllByText("タイトルをコピーしました").length).toBeGreaterThan(0);
    expect(undoToast()).toHaveAttribute("inert");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(NOTICE_TOAST_MS);
    });
    expect(undoToast()).not.toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(store.task(a.id)?.completedAt).toBeNull();
  });

  it("コピーの知らせが出ているあいだに完了しても、「元に戻す」のトーストが出て、押すと戻る", async () => {
    const user = userEvent.setup();
    const { server, a } = inboxServer();
    const { store } = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j");
    await user.keyboard(COPY);
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
    await user.keyboard("x");
    await user.click(await screen.findByRole("button", { name: "元に戻す" }));
    expect(store.task(a.id)?.completedAt).toBeNull();
    expect(optionTitles("受信箱")).toEqual(["A", "B"]);
  });
});

describe("ショートカットのページ", () => {
  it("「タスク」に「タイトルとメモをコピー」が ⇧⌘C で出る", async () => {
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });
    const tasks = screen.getByRole("region", { name: "タスク" });
    const row = within(tasks).getByText("タイトルとメモをコピー", { exact: true }).closest("li");
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("⇧⌘C")).toBeInTheDocument();
  });
});

/**
 * 一覧（今日）と小さな詳細を並べて描く土台（flows-task-detail-popover.test.tsx と同じ組み方）。キーマップも効かせる。
 * 小さな詳細はカレンダー・タイムラインから開くが、そこには一覧の選択がないので、一覧で選んでいるときに
 * 小さな詳細の中のキーが一覧へ届かないことは、ここで確かめる
 */
async function setupListAndPopover(server: FakeServer, popoverTaskId: string) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  await act(async () => {
    await store.sync();
  });
  const ui = new ListUi(store);
  stops.push(ui.start());
  const view: ListView = {
    key: "today",
    kind: "today",
    sections: () => [{ key: "open", rows: store.lists.today, reorderable: true }],
    addTo: { bucket: "today", label: "今日に追加" },
  };
  const keyContext: KeyContext = { store, ui, navigate: () => {} };

  function Keys() {
    useKeymap(keyContext);
    return null;
  }

  render(
    <StoreProvider store={store}>
      <UiProvider ui={ui}>
        <LazyMotion features={domMax}>
          <ToastHost toaster={ui.toaster}>
            <Keys />
            <TaskList view={view} label="今日" />
            <button
              type="button"
              onClick={(event) => taskDetailPopoverOf(ui).open(popoverTaskId, event.currentTarget)}
            >
              開く
            </button>
            <TaskDetailPopoverHost />
          </ToastHost>
        </LazyMotion>
      </UiProvider>
    </StoreProvider>,
  );
  act(() => ui.setView(view));
  return { store, ui };
}

describe("⇧⌘C：保存できていない文字（レビューの指摘）", () => {
  it("保存できていないタイトルとメモがあれば、開いたときに欄に出るそちらを入れる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "元のタイトル", memo: "元のメモ", bucket: "today", rank: "a0" }),
    );
    // オフラインで閉じたときなどに残る下書き（ListUi の unsavedText。localStorage から読む）
    localStorage.setItem(`nagi:draft:unsaved:${task.id}:title`, "直したタイトル");
    localStorage.setItem(`nagi:draft:unsaved:${task.id}:memo`, "直したメモ");
    await open("/today", server);
    await user.click(await screen.findByRole("option", { name: /^元のタイトル/ }));
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("直したタイトル\n\n直したメモ"),
    );
  });

  it("保存できていないタイトルが空白だけなら、保存したタイトルを入れる（空のタイトルは保存しない決まり）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "元のタイトル", memo: "元のメモ", bucket: "today", rank: "a0" }),
    );
    localStorage.setItem(`nagi:draft:unsaved:${task.id}:title`, "  ");
    await open("/today", server);
    await user.click(await screen.findByRole("option", { name: /^元のタイトル/ }));
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("元のタイトル\n\n元のメモ"),
    );
  });
});
