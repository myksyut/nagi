import "@/features";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { domMax, LazyMotion } from "motion/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppStore, StoreProvider } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import type { KeyContext } from "@/keyboard/keymap";
import { keymap } from "@/keyboard/keymap";
import { useKeymap } from "@/keyboard/use-keymap";
import { TIMELINE } from "@/navigation";
import { ListUi } from "@/tasks/list-ui";
import { taskDetailPopoverOf } from "@/tasks/task-detail-popover";
import { ToastHost } from "@/tasks/toast-host";
import { UiProvider } from "@/tasks/ui-context";
import { FakeServer } from "@/test/fake-server";
import { makeProject, makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";
import { TimelineHeading } from "./lazy";
import { timelineNav } from "./timeline-nav";
import { DAY_WIDTH, TimelineScreen } from "./timeline-screen";

/**
 * チケット14：タイムライン（timeline-screen.tsx）。画面の中の振る舞いは TimelineScreen を自分で描いて確かめ
 * （時刻を固定するため）、サイドバー・7・右下の「＋」と n のつなぎ込みは、最後に setupApp で確かめる
 */

type Harness = { store: AppStore; ui: ListUi; navigate: (path: string) => void; stop?: () => void };

const harnesses: Harness[] = [];
afterEach(() => {
  for (const { store, stop } of harnesses.splice(0)) {
    stop?.();
    store.dispose();
  }
  vi.useRealTimers();
});

async function setupTimeline(server: FakeServer, now?: () => Date) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
    now,
  });
  await store.start();
  await act(async () => {
    await store.sync();
  });
  const ui = new ListUi(store);
  const stop = ui.start();
  const navigate = vi.fn();
  harnesses.push({ store, ui, navigate, stop });

  function Keys() {
    useKeymap({ store, ui, navigate } satisfies KeyContext);
    return null;
  }

  const { unmount } = render(
    <StoreProvider store={store}>
      <UiProvider ui={ui}>
        <LazyMotion features={domMax}>
          <ToastHost toaster={ui.toaster}>
            <Keys />
            <TimelineScreen Heading={TimelineHeading} />
          </ToastHost>
        </LazyMotion>
      </UiProvider>
    </StoreProvider>,
  );

  return { store, ui, navigate, stop, unmount };
}

function section() {
  return screen.getByRole("region", { name: "タイムライン" });
}

/** 棒・◆をドラッグする（pointerdown → pointermove(4px 以上) → pointerup）。dx は px */
function drag(element: HTMLElement, dx: number, pointerId = 1) {
  fireEvent.pointerDown(element, { button: 0, pointerId, clientX: 0 });
  fireEvent.pointerMove(element, { pointerId, clientX: dx });
  fireEvent.pointerUp(element, { pointerId, clientX: dx });
}

function pressEscapeDuringDrag(element: HTMLElement, dx: number, pointerId = 2) {
  fireEvent.pointerDown(element, { button: 0, pointerId, clientX: 0 });
  fireEvent.pointerMove(element, { pointerId, clientX: dx });
  fireEvent.keyDown(window, { key: "Escape" });
  fireEvent.pointerUp(element, { pointerId, clientX: dx });
}

describe("棒と◆の見た目：完了の条件1", () => {
  it("予定だけ（締切なし）は予定の日の1日の棒で◆なし", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "予定のみ", bucket: "scheduled", scheduledOn: "2026-10-01" }));
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「予定のみ」/ });
    expect(b).toHaveAttribute("data-shape", "bar");
    expect(b).toHaveAttribute("data-from", "2026-10-01");
    expect(b).toHaveAttribute("data-to", "2026-10-01");
    expect(b).not.toHaveAttribute("data-end-diamond");
    expect(b.getAttribute("aria-label")).toMatch(/^「予定のみ」 やる日/);
  });

  it("予定＋締切（締切 ≥ 予定）は予定から締切までの棒＋右端◆", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "予定と締切",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        deadlineOn: "2026-10-05",
      }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「予定と締切」/ });
    expect(b).toHaveAttribute("data-from", "2026-10-01");
    expect(b).toHaveAttribute("data-to", "2026-10-05");
    expect(b).toHaveAttribute("data-end-diamond", "true");
    expect(b.getAttribute("aria-label")).toContain("締切");
  });

  it("今日だけ（進行中を含む）は今日の1日の棒", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "今日のみ", bucket: "today" }));
    server.putTask(
      makeTask({ title: "進行中", bucket: "today", startedAt: "2026-09-27T00:00:00.000Z" }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「今日のみ」/ });
    expect(b).toHaveAttribute("data-from", "2026-09-27");
    expect(b).toHaveAttribute("data-to", "2026-09-27");
    const inProgress = await screen.findByRole("button", { name: /^「進行中」/ });
    expect(inProgress).toHaveAttribute("data-from", "2026-09-27");
  });

  it("今日＋未来の締切は今日から締切までの棒＋◆", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "今日＋未来締切", bucket: "today", deadlineOn: "2026-10-03" }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「今日＋未来締切」/ });
    expect(b).toHaveAttribute("data-from", "2026-09-27");
    expect(b).toHaveAttribute("data-to", "2026-10-03");
    expect(b).toHaveAttribute("data-end-diamond", "true");
  });

  it("今日＋過ぎた締切は今日の1日の棒と離れた◆", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "今日＋過ぎた締切", bucket: "today", deadlineOn: "2026-09-20" }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「今日＋過ぎた締切」 やる日/ });
    expect(b).toHaveAttribute("data-from", "2026-09-27");
    expect(b).toHaveAttribute("data-to", "2026-09-27");
    expect(b).not.toHaveAttribute("data-end-diamond");
    const loose = screen.getByRole("button", { name: /^「今日＋過ぎた締切」 締切/ });
    expect(loose).toHaveAttribute("data-shape", "loose-deadline");
    expect(loose).toHaveAttribute("data-on", "2026-09-20");
  });

  it("予定＋予定より前の締切は予定の1日の棒と離れた◆", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "予定＋前の締切",
        bucket: "scheduled",
        scheduledOn: "2026-10-05",
        deadlineOn: "2026-10-01",
      }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「予定＋前の締切」 やる日/ });
    expect(b).toHaveAttribute("data-from", "2026-10-05");
    const loose = screen.getByRole("button", { name: /^「予定＋前の締切」 締切/ });
    expect(loose).toHaveAttribute("data-shape", "loose-deadline");
  });

  it("受信箱・あとで＋締切は◆だけ。締切なしは出ない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱＋締切", bucket: "inbox", deadlineOn: "2026-10-02" }));
    server.putTask(makeTask({ title: "あとで＋締切", bucket: "later", deadlineOn: "2026-10-03" }));
    server.putTask(makeTask({ title: "受信箱のみ", bucket: "inbox" }));
    server.putTask(makeTask({ title: "あとでのみ", bucket: "later" }));
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const d1 = await screen.findByRole("button", { name: /^「受信箱＋締切」/ });
    expect(d1).toHaveAttribute("data-shape", "diamond");
    const d2 = screen.getByRole("button", { name: /^「あとで＋締切」/ });
    expect(d2).toHaveAttribute("data-shape", "diamond");
    expect(screen.queryByRole("button", { name: /^「受信箱のみ」/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^「あとでのみ」/ })).toBeNull();
  });

  it("完了・削除したタスクは出ない", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        completedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    await screen.findByRole("region", { name: "タイムライン" });
    expect(screen.queryByRole("button", { name: /^「完了済み」/ })).toBeNull();
  });

  it("まとまりはプロジェクトの作成順、プロジェクトなしは最後", async () => {
    const server = new FakeServer();
    const p1 = server.putProject(
      makeProject({ name: "先のP", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const p2 = server.putProject(
      makeProject({ name: "後のP", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    server.putTask(makeTask({ title: "後Pのタスク", bucket: "today", projectId: p2.id }));
    server.putTask(makeTask({ title: "先Pのタスク", bucket: "today", projectId: p1.id }));
    server.putTask(makeTask({ title: "プロジェクトなしのタスク", bucket: "today" }));
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    await screen.findByRole("group", { name: "先のP" });
    const groups = screen.getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("aria-label"))).toEqual([
      "先のP",
      "後のP",
      "プロジェクトなし",
    ]);
  });
});

describe("ドラッグ：完了の条件2・3", () => {
  it("左端を引くとやる日が変わり、⌘Z 1回で戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "左端",
        bucket: "scheduled",
        scheduledOn: "2026-10-05",
        deadlineOn: "2026-10-10",
      }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「左端」/ });
    const start = b.querySelector('[data-edge="start"]') as HTMLElement;
    drag(start, 3 * DAY_WIDTH);

    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-08"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-10-10");

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05"));
  });

  it("右端を引くと締切が変わり、⌘Z 1回で戻る。締切のない1日の棒の右端を引くと締切が付く", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "右端", bucket: "scheduled", scheduledOn: "2026-10-05" }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「右端」/ });
    const end = b.querySelector('[data-edge="end"]') as HTMLElement;
    drag(end, 3 * DAY_WIDTH);

    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2026-10-08"));
    expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05");

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBeNull());
  });

  it("真ん中をつかむとやる日と締切が同じ日数動き、1つの操作として送られ⌘Z 1回で両方戻る", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "真ん中",
        bucket: "scheduled",
        scheduledOn: "2026-10-05",
        deadlineOn: "2026-10-10",
      }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「真ん中」/ });
    const before = server.requestsTo("/api/mutate").length;
    drag(b, 3 * DAY_WIDTH);

    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-08"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-10-13");
    // 1つの操作として送る（moveTasks と setDeadline を続けてかけたのではなく、1回の mutate リクエスト）
    await store.idle();
    expect(server.requestsTo("/api/mutate").length).toBe(before + 1);
    const last = server.requestsTo("/api/mutate").at(-1);
    expect((last?.body as { mutations: unknown[] } | undefined)?.mutations).toHaveLength(1);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-10-10");
  });

  it("端は裏返らない：左端は締切の日より右へ行かず、右端はやる日より左へ行かない", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "裏返り",
        bucket: "scheduled",
        scheduledOn: "2026-10-05",
        deadlineOn: "2026-10-08",
      }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「裏返り」/ });
    const start = b.querySelector('[data-edge="start"]') as HTMLElement;
    drag(start, 30 * DAY_WIDTH);
    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-08"));
    expect(store.task(task.id)?.deadlineOn).toBe("2026-10-08");

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05"));

    const b2 = screen.getByRole("button", { name: /^「裏返り」/ });
    const end = b2.querySelector('[data-edge="end"]') as HTMLElement;
    drag(end, -30 * DAY_WIDTH);
    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2026-10-05"));
    expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05");
  });

  it("ドラッグの途中の Esc でやめる（何も送らない）", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "Esc", bucket: "scheduled", scheduledOn: "2026-10-05" }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「Esc」/ });
    pressEscapeDuringDrag(b, 3 * DAY_WIDTH);

    expect(store.task(task.id)?.scheduledOn).toBe("2026-10-05");
  });

  it("ドラッグのあとのクリックで小さな詳細が開かない。動かさずに押しただけなら開く", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "クリック判定", bucket: "scheduled", scheduledOn: "2026-10-05" }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「クリック判定」/ });
    drag(b, 3 * DAY_WIDTH);
    // detail: 1（マウスの本当のクリック）でないと、キーボードの Enter・Space の扱い（detail が 0）に
    // なってしまい、suppressClick が効かず開いてしまう
    fireEvent.click(b, { detail: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();

    const user = userEvent.setup();
    const b2 = await screen.findByRole("button", { name: /^「クリック判定」/ });
    await user.click(b2);
    expect(
      await screen.findByRole("dialog", { name: "「クリック判定」の詳細" }),
    ).toBeInTheDocument();
  });

  it("過去の日へ左端を引くと今日へ入る（予定の棒は今日から）", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "過去へ", bucket: "scheduled", scheduledOn: "2026-10-01" }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const b = await screen.findByRole("button", { name: /^「過去へ」/ });
    const start = b.querySelector('[data-edge="start"]') as HTMLElement;
    drag(start, -60 * DAY_WIDTH);

    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    const b2 = await screen.findByRole("button", { name: /^「過去へ」/ });
    expect(b2).toHaveAttribute("data-from", "2026-09-27");
  });
});

describe("絞り込み：完了の条件4", () => {
  it("すべて・1つのプロジェクト・プロジェクトなしで出すタスクが変わる", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "Pのタスク", bucket: "today", projectId: project.id }));
    server.putTask(makeTask({ title: "なしのタスク", bucket: "today" }));
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    const user = userEvent.setup();

    await screen.findByRole("button", { name: /^「Pのタスク」/ });
    expect(screen.queryByRole("button", { name: /^「なしのタスク」/ })).not.toBeNull();

    await user.click(screen.getByRole("button", { name: /^プロジェクトで絞り込む：/ }));
    await user.click(await screen.findByRole("radio", { name: "AIPR" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^「なしのタスク」/ })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /^「Pのタスク」/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^プロジェクトで絞り込む：/ }));
    await user.click(await screen.findByRole("radio", { name: "プロジェクトなし" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^「Pのタスク」/ })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: /^「なしのタスク」/ })).toBeInTheDocument();
  });
});

describe("小さな詳細の開き直し：完了の条件7", () => {
  it("開いたまま、そのタスクのプロジェクトを変えると、押した要素は消えても dialog は開いたまま", async () => {
    const server = new FakeServer();
    const p1 = server.putProject(
      makeProject({ name: "P1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const p2 = server.putProject(
      makeProject({ name: "P2", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    const task = server.putTask(
      makeTask({ title: "移るタスク", bucket: "today", projectId: p1.id }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^「移るタスク」/ }));
    const dialog = await screen.findByRole("dialog", { name: "「移るタスク」の詳細" });

    act(() => {
      store.actions.setProject([task.id], p2.id);
    });

    // 押した棒は別のまとまりへ移って作り直されるので、新しい棒から開き直している（同じタスクの詳細のまま）
    await waitFor(() => expect(screen.getByRole("group", { name: "P2" })).toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "「移るタスク」の詳細" })).toBeInTheDocument();
    expect(dialog.isConnected).toBe(false);
  });

  it("締切なしのあとでへ移すと、タイムラインから出て小さな詳細も閉じる", async () => {
    const server = new FakeServer();
    const task = server.putTask(makeTask({ title: "出るタスク", bucket: "today" }));
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^「出るタスク」/ }));
    await screen.findByRole("dialog", { name: "「出るタスク」の詳細" });

    act(() => {
      store.actions.moveTasks([task.id], { bucket: "later" });
    });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("そのほか：完了の条件6", () => {
  it("keymap.run('go.timeline', …) で /timeline へ navigate する", async () => {
    const server = new FakeServer();
    const store = new AppStore({
      fetch: server.fetch,
      openLocalDb: async () => createMemoryLocalDb(),
    });
    await store.start();
    const ui = new ListUi(store);
    const navigate = vi.fn();
    harnesses.push({ store, ui, navigate });

    keymap.run("go.timeline", { store, ui, navigate });

    expect(navigate).toHaveBeenCalledWith(TIMELINE.path);
  });

  it("画面が開いているあいだだけ [ ] が効き、横のスクロールが7×36pxずつ動く", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "スクロール確認", bucket: "today" }));
    const { store, ui, navigate } = await setupTimeline(
      server,
      () => new Date("2026-09-27T05:00:00+09:00"),
    );
    await screen.findByRole("region", { name: "タイムライン" });
    expect(timelineNav.active).toBe(true);

    const scroller = section();
    const before = scroller.scrollLeft;
    keymap.run("timeline.nextWeek", { store, ui, navigate });
    await waitFor(() => expect(scroller.scrollLeft).toBe(before + 7 * DAY_WIDTH));

    keymap.run("timeline.previousWeek", { store, ui, navigate });
    await waitFor(() => expect(scroller.scrollLeft).toBeCloseTo(before, 0));
  });

  it("タイムラインを閉じると [ ] は効かなくなる（timelineNav.active が false になる）", async () => {
    const server = new FakeServer();
    const { store, ui, navigate, unmount } = await setupTimeline(
      server,
      () => new Date("2026-09-27T05:00:00+09:00"),
    );
    await screen.findByRole("region", { name: "タイムライン" });
    expect(timelineNav.active).toBe(true);

    // App.tsx が画面を外すのと同じ状況（TimelineGrid の useLayoutEffect の後片付け）を、外して再現する
    unmount();

    expect(timelineNav.active).toBe(false);
    expect(keymap.run("timeline.nextWeek", { store, ui, navigate })).toBe(false);
  });
});

describe("つなぎ込み：サイドバー・7・右下の「＋」と n", () => {
  const stores: AppStore[] = [];
  afterEach(() => {
    for (const store of stores.splice(0)) store.dispose();
  });

  it("7 でタイムラインが開き、サイドバーの「ビュー」の「タイムライン」が選ばれている", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "今日のタスク", bucket: "today" }));
    const { store, location } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });
    const user = userEvent.setup();

    await user.keyboard("7");

    await screen.findByRole("region", { name: "タイムライン" });
    expect(location.history.at(-1)).toBe(TIMELINE.path);
    expect(screen.getByRole("heading", { level: 1, name: "タイムライン" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "タイムライン" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(await screen.findByRole("button", { name: /^「今日のタスク」/ })).toBeInTheDocument();
  });

  it("n と右下の「＋」で小さな追加欄が開き、受信箱に追加される。絞り込み中なら、そのプロジェクトが付く", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "AIPR" }));
    const { store } = await setupApp(TIMELINE.path, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("region", { name: "タイムライン" });
    const user = userEvent.setup();

    // 絞り込みなし：n で開いて受信箱へ（プロジェクトなし）
    await user.keyboard("n");
    await user.type(
      await screen.findByRole("textbox", { name: "受信箱に追加" }),
      "なしの追加{Enter}",
    );
    await waitFor(() => expect(store.lists.inbox.map((row) => row.title)).toContain("なしの追加"));
    expect(store.lists.inbox.find((row) => row.title === "なしの追加")?.projectId).toBeNull();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "受信箱に追加" })).toBeNull());

    // AIPR で絞り込む → 右下の「＋」で開いて追加すると、AIPR が付く
    await user.click(screen.getByRole("button", { name: /^プロジェクトで絞り込む：/ }));
    await user.click(await screen.findByRole("radio", { name: "AIPR" }));
    await user.click(screen.getByRole("button", { name: "タスクを追加" }));
    await user.type(await screen.findByRole("textbox", { name: "受信箱に追加" }), "Pの追加{Enter}");
    await waitFor(() =>
      expect(store.lists.inbox.find((row) => row.title === "Pの追加")?.projectId).toBe(project.id),
    );
  });
});

/**
 * 14-修正1：ドラッグのプレビューと到着、範囲の外の◆。
 * 見えている形は、行の中の data-shape の要素のうち、ドラッグの元として隠しているもの（data-drag-source）を除いたもの
 */
function visibleShapes(taskId: string): Record<string, string | null>[] {
  const row = document.querySelector(`[data-timeline-row="${taskId}"]`);
  if (!row) return [];
  return Array.from(row.querySelectorAll("[data-shape]:not([data-drag-source])"), (element) => ({
    shape: element.getAttribute("data-shape"),
    from: element.getAttribute("data-from"),
    to: element.getAttribute("data-to"),
    on: element.getAttribute("data-on"),
    endDiamond: element.getAttribute("data-end-diamond"),
  })).sort((a, b) => (a.shape ?? "").localeCompare(b.shape ?? ""));
}

/** 押して動かしたところで止める（離さない） */
function pressAndMove(element: HTMLElement, dx: number, pointerId = 5) {
  fireEvent.pointerDown(element, { button: 0, pointerId, clientX: 0 });
  fireEvent.pointerMove(element, { pointerId, clientX: dx });
}

describe("14-修正1：ドラッグ中の形は、締切による今日への到着まで含めて、確定したあとの形と同じ", () => {
  it("あとでの◆だけのタスク：締切を今日へ引くと、ドラッグ中から今日の棒と◆になり、離しても同じ", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "あとで締切", bucket: "later", deadlineOn: "2026-10-01" }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const diamond = await screen.findByRole("button", { name: /^「あとで締切」 締切/ });
    pressAndMove(diamond, -4 * DAY_WIDTH);
    const during = visibleShapes(task.id);
    expect(during).toEqual([
      { shape: "bar", from: "2026-09-27", to: "2026-09-27", on: null, endDiamond: "true" },
    ]);

    fireEvent.pointerUp(diamond, { pointerId: 5, clientX: -4 * DAY_WIDTH });
    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(visibleShapes(task.id)).toEqual(during);
  });

  it("予定の棒と離れた◆：◆を今日より前へ引くと、ドラッグ中から今日の棒と離れた◆になり、離しても同じ", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({
        title: "予定と前の締切",
        bucket: "scheduled",
        scheduledOn: "2026-10-10",
        deadlineOn: "2026-10-01",
      }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const loose = await screen.findByRole("button", { name: /^「予定と前の締切」 締切/ });
    pressAndMove(loose, -5 * DAY_WIDTH);
    const during = visibleShapes(task.id);
    expect(during).toEqual([
      { shape: "bar", from: "2026-09-27", to: "2026-09-27", on: null, endDiamond: null },
      { shape: "loose-deadline", from: null, to: null, on: "2026-09-26", endDiamond: null },
    ]);

    fireEvent.pointerUp(loose, { pointerId: 5, clientX: -5 * DAY_WIDTH });
    await waitFor(() => expect(store.task(task.id)?.bucket).toBe("today"));
    expect(visibleShapes(task.id)).toEqual(during);
  });

  it("押したときに、押した要素がポインタを捕まえる（setPointerCapture）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "捕まえる", bucket: "scheduled", scheduledOn: "2026-10-05" }));
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    const capture = vi.spyOn(HTMLElement.prototype, "setPointerCapture");

    const bar = await screen.findByRole("button", { name: /^「捕まえる」/ });
    fireEvent.pointerDown(bar, { button: 0, pointerId: 9, clientX: 0 });

    expect(capture).toHaveBeenCalledWith(9);
    expect(capture.mock.contexts[0]).toBe(bar);
    fireEvent.pointerUp(bar, { pointerId: 9, clientX: 0 });
    capture.mockRestore();
  });
});

describe("14-修正1：範囲の外の離れた◆", () => {
  it("範囲より前の離れた◆は描かない（Tab で行けない）。棒は出る", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "ずっと前の締切", bucket: "today", deadlineOn: "2026-09-01" }),
    );
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    expect(await screen.findByRole("button", { name: /^「ずっと前の締切」 やる日/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^「ずっと前の締切」 締切/ })).toBeNull();
  });

  it("離れた◆から小さな詳細を開いたまま、締切を範囲より前へ変えると、見えている棒へ付け直す", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "付け直し", bucket: "today", deadlineOn: "2026-09-25" }),
    );
    const { store, ui } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /^「付け直し」 締切/ }));
    await screen.findByRole("dialog", { name: "「付け直し」の詳細" });

    act(() => {
      store.actions.setDeadline([task.id], "2026-09-01");
    });

    const bar = screen.getByRole("button", { name: /^「付け直し」 やる日/ });
    await waitFor(() => expect(taskDetailPopoverOf(ui).request?.anchor).toBe(bar));
    expect(screen.getByRole("dialog", { name: "「付け直し」の詳細" })).toBeInTheDocument();
  });

  it("離れた◆を範囲より前へ引いても、離すまで捕まえたままで、離すと締切が変わる", async () => {
    const server = new FakeServer();
    const task = server.putTask(
      makeTask({ title: "外へ引く", bucket: "today", deadlineOn: "2026-09-25" }),
    );
    const { store } = await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));

    const loose = await screen.findByRole("button", { name: /^「外へ引く」 締切/ });
    pressAndMove(loose, -10 * DAY_WIDTH);
    // 動かしているあいだは、押した要素（ポインタを捕まえている）を残す
    expect(loose.isConnected).toBe(true);
    fireEvent.pointerUp(loose, { pointerId: 5, clientX: -10 * DAY_WIDTH });

    await waitFor(() => expect(store.task(task.id)?.deadlineOn).toBe("2026-09-15"));
    expect(screen.queryByRole("button", { name: /^「外へ引く」 締切/ })).toBeNull();
  });
});

describe("14-修正1：縦は見えている行だけを描く", () => {
  it("300件でも描く行は見えている分と上下の少しだけ。下へスクロールすると先の行を描く", async () => {
    const server = new FakeServer();
    for (let i = 0; i < 300; i++) {
      server.putTask(
        makeTask({
          title: `多い${String(i).padStart(3, "0")}`,
          bucket: "scheduled",
          scheduledOn: "2026-10-05",
          rank: `a${String(i).padStart(3, "0")}`,
        }),
      );
    }
    await setupTimeline(server, () => new Date("2026-09-27T05:00:00+09:00"));
    await screen.findByRole("button", { name: /^「多い000」/ });

    const rendered = () => document.querySelectorAll("[data-timeline-row]").length;
    expect(rendered()).toBeGreaterThan(20);
    expect(rendered()).toBeLessThan(80);
    expect(screen.queryByRole("button", { name: /^「多い299」/ })).toBeNull();

    // 一番下までスクロールすると、最後の行が描かれ、最初の行は外れる
    const scroller = section();
    act(() => {
      scroller.scrollTop = 301 * 32;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(await screen.findByRole("button", { name: /^「多い299」/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^「多い000」/ })).toBeNull();
  });
});
