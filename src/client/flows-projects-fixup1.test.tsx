import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { computed, reaction } from "mobx";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { laterSections } from "./features/projects/later-sections";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { pickerListbox, setupApp } from "./test/render-app";

/**
 * 6-修正1 の2〜6：プロジェクトの名前の変更の失敗、アーカイブをサーバーが断ったとき、
 * あとでのまとまりの観測、p の候補の変換中の Enter、ボタンから開いた候補のフォーカス
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

async function open(path: string, server: FakeServer) {
  const { store, location } = await setupApp(path, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  return { store, location };
}

describe("2：プロジェクトの名前の変更で、打った名前を失わない", () => {
  it("★ オフラインで Enter を押しても、欄を開いたまま文字を残す。つながってから Enter で保存される", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store } = await open(`/projects/${project.id}`, server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "AIPR" }));
    const input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    await user.type(input, "新しい名前");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "プロジェクト名" })).toHaveValue("新しい名前");
    expect(store.project(project.id)?.name).toBe("AIPR");

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await user.click(screen.getByRole("textbox", { name: "プロジェクト名" }));
    await user.keyboard("{Enter}");
    await act(async () => {
      await store.idle();
    });
    expect(screen.queryByRole("textbox", { name: "プロジェクト名" })).toBeNull();
    expect(server.projects.get(project.id)?.name).toBe("新しい名前");
  });

  it("★ 送ったあとに保存できなかったら、次に名前を変えるときに打った名前が欄に入っている", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store } = await open(`/projects/${project.id}`, server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "AIPR" }));
    const input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    server.fail("/api/mutate", 400);
    await user.type(input, "失敗する名前{Enter}");
    await act(async () => {
      await store.idle();
    });
    // 保存できず、名前は元に戻っている
    expect(await screen.findByRole("heading", { level: 1, name: "AIPR" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    expect(screen.getByRole("textbox", { name: "プロジェクト名" })).toHaveValue("失敗する名前");

    // Esc でやめたら、下書きも消える
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    expect(screen.getByRole("textbox", { name: "プロジェクト名" })).toHaveValue("AIPR");
  });
});

describe("3：アーカイブをサーバーが断ったとき", () => {
  it("★ すぐ今日へ移るが、断られたら取り直して、アーカイブできなかったことと残りの件数を知らせる。サイドバーに戻る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store, location } = await open(`/projects/${project.id}`, server);
    const user = userEvent.setup();

    await screen.findByRole("heading", { level: 1, name: "AIPR" });
    const release = server.hold("/api/mutate");
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    expect(location.history.at(-1)).toBe("/today");
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).queryByRole("link", { name: "AIPR" })).toBeNull();

    // 送る前に、ほかの画面がこのプロジェクトに未完了のタスクを付けた
    server.putTask(
      makeTask({ title: "ほかの画面で付けた", bucket: "inbox", projectId: project.id }),
    );
    release();
    await act(async () => {
      await store.idle();
    });

    expect(
      (await screen.findAllByText("「AIPR」をアーカイブできませんでした")).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("未完了のタスクが 1 件残っています").length).toBeGreaterThan(0);
    expect(server.projects.get(project.id)?.archivedAt).toBeNull();
    expect(store.project(project.id)?.archivedAt).toBeNull();
    expect(within(nav).getByRole("link", { name: "AIPR" })).toBeInTheDocument();
  });
});

describe("4：あとでのまとまりは、プロジェクトの付け替えのときだけ計算し直す", () => {
  it("★ タイトルやメモを直しても計算し直さず、付け替えでは1回だけ計算し直す", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const task = server.putTask(makeTask({ title: "あとでのタスク", bucket: "later" }));
    const { store } = await open("/later", server);

    let runs = 0;
    const sections = computed(() => {
      runs += 1;
      return laterSections(store);
    });
    const dispose = reaction(
      () => sections.get(),
      () => {},
    );
    try {
      expect(runs).toBe(1);
      store.actions.updateTask(task.id, { title: "直したタイトル" }, { undoable: false });
      store.actions.updateTask(task.id, { memo: "メモ" }, { undoable: false });
      expect(runs).toBe(1);

      store.actions.setProject([task.id], project.id);
      expect(runs).toBe(2);
      expect(sections.get().map((section) => section.key)).toEqual([
        "none",
        `project:${project.id}`,
      ]);
    } finally {
      dispose();
    }
  });
});

describe("5：p の候補で、変換を確定する Enter では決めない", () => {
  it.each([
    ["keyCode 229", { keyCode: 229, which: 229 }],
    ["isComposing だけが立つ", { keyCode: 13, which: 13, isComposing: true }],
  ])("★ %s の Enter では候補を選ばない", async (_, init) => {
    const server = new FakeServer();
    const project = makeProject({ name: "dev-metrics" });
    server.putProject(project);
    const task = server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    const { store } = await open("/inbox", server);
    const user = userEvent.setup();
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "dev");
    expect(within(pickerListbox()).getByRole("option", { name: "dev-metrics" })).toHaveAttribute(
      "data-highlighted",
    );

    fireEvent.keyDown(input, { key: "Enter", ...init });
    expect(store.task(task.id)?.projectId).toBeNull();
    expect(screen.getByRole("combobox", { name: "プロジェクト" })).toBeInTheDocument();

    // 確定したあとの Enter では決まる
    await user.keyboard("{Enter}");
    expect(store.task(task.id)?.projectId).toBe(project.id);
  });
});

describe("6：開いたタスクのボタンから開いた候補を閉じると、ボタンへフォーカスが戻る", () => {
  it("★ Esc で閉じるとボタンへ戻る", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    await open("/inbox", server);
    const user = userEvent.setup();
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("j{Enter}");
    const button = screen.getByRole("button", { name: "プロジェクトを付ける" });
    await user.click(button);
    await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    expect(screen.getByRole("button", { name: "プロジェクトを付ける" })).toHaveFocus();
  });

  it("p で開いたときは、これまでどおり一覧へ戻る", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    await open("/inbox", server);
    const user = userEvent.setup();
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("jp");
    await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.keyboard("{Escape}");
    expect(screen.getByRole("listbox", { name: "受信箱" })).toHaveFocus();
  });
});

describe("main（チケット 5）を取り込んだあと：プロジェクトの画面でも締切の表示と d が動く", () => {
  it("締切が行に出て、d で日付を決めると予定のまとまりへ移る", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00")); // 月曜
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    server.putTask(
      makeTask({
        title: "締切のあるタスク",
        bucket: "later",
        projectId: project.id,
        deadlineOn: "2026-10-30",
      }),
    );
    const { store } = await open(`/projects/${project.id}`, server);
    const list = await screen.findByRole("listbox", { name: "AIPR" });
    expect(within(list).getByRole("option", { name: /締切のあるタスク/ })).toHaveTextContent(
      "締切 10/30",
    );

    await user.keyboard("jd");
    const input = await screen.findByRole("textbox", { name: "予定の日付" });
    await user.type(input, "明日{Enter}");
    expect(store.lists.project(project.id).scheduled.map((task) => task.title)).toEqual([
      "締切のあるタスク",
    ]);
    const headings = within(list)
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(["予定"]);
  });
});
