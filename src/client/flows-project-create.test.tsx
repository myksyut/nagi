import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * チケット17：プロジェクトを作る（Core Flows のフロー3）。features/projects/create-field.test.tsx の続きで、
 * 完了の条件のうち、そこで確かめていない道筋を画面ごと確かめる。
 * - ⌘K から作って使うまで（タスクが1つもない状態から、n であとでに足すまで）
 * - 欄の点の色と、作ったあとのサイドバー・見出しの点の色が同じ
 * - ⌘Z：ボードで見ていても今日へ移る。開いていなければ画面は動かない。作る → n で足す → ⌘Z 2回
 * - 名前の欄：同じ名前の比べ方の幅、空の Enter、Esc のあとのフォーカス、keyCode 229、開き直し、オフライン、
 *   保存できなかったときに打ち直している名前を上書きしないこと
 */

const stores: AppStore[] = [];
afterEach(() => {
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

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "リスト" });
}

function nameField(): HTMLElement {
  return screen.getByRole("textbox", { name: "新しいプロジェクトの名前" });
}

function queryNameField(): HTMLElement | null {
  return screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" });
}

function createButton(): HTMLElement {
  return screen.getByRole("button", { name: "プロジェクトを作成" });
}

/** サイドバーのプロジェクトの行 */
function projectLink(name: string): HTMLElement {
  return within(sidebar()).getByRole("link", { name: new RegExp(`^${name}`) });
}

function colorOf(element: Element | null): string | null {
  return element?.querySelector("[data-project-color]")?.getAttribute("data-project-color") ?? null;
}

async function settle(store: AppStore) {
  await act(async () => {
    await store.idle();
  });
}

describe("⌘K から作って使うまで", () => {
  it("タスクが1つもなくても、⌘K の「プロジェクトを作成」から作れ、その画面が開いて一覧にフォーカスが戻り、n でそのプロジェクトのあとでに足せる", async () => {
    const user = userEvent.setup();
    const { store, server, location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(server.tasks.size).toBe(0);
    expect(server.projects.size).toBe(0);

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "プロジェクトを作成{Enter}");
    await waitFor(() => expect(nameField()).toHaveFocus());
    // ⌘K からは欄を開くだけ（まだ作らない）
    expect(store.lists.projects).toHaveLength(0);

    await user.keyboard("週次の振り返り{Enter}");
    const project = store.lists.projects.find((row) => row.name === "週次の振り返り");
    expect(project).toBeDefined();
    expect(location.history?.at(-1)).toBe(`/projects/${project?.id}`);
    const list = await screen.findByRole("listbox", { name: "週次の振り返り" });
    await waitFor(() => expect(list).toHaveFocus());
    expect(queryNameField()).toBeNull();

    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "あとでに追加" }), "議題を集める{Enter}");
    await user.keyboard("{Escape}");
    const task = store.lists.later.find((row) => row.title === "議題を集める");
    expect(task?.projectId).toBe(project?.id);
    expect(optionTitles("週次の振り返り")).toEqual(["議題を集める"]);

    // サーバーにも、作ったプロジェクトとそのタスクが届いている
    await settle(store);
    expect(server.projects.get(project?.id ?? "")?.name).toBe("週次の振り返り");
    expect([...server.tasks.values()].map((row) => [row.title, row.projectId])).toEqual([
      ["議題を集める", project?.id],
    ]);
  });

  it("同じ名前のプロジェクトの画面を開いているときに同じ名前を打つと、作らずに、その一覧へフォーカスを戻す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const existing = makeProject({ name: "AIPR" });
    server.putProject(existing);
    const { store, location } = await open(`/projects/${existing.id}`, server);
    const list = await screen.findByRole("listbox", { name: "AIPR" });

    await user.click(createButton());
    await user.type(nameField(), "aipr{Enter}");
    expect(queryNameField()).toBeNull();
    expect(store.lists.projects).toHaveLength(1);
    expect(location.history).toEqual([`/projects/${existing.id}`]);
    await waitFor(() => expect(list).toHaveFocus());
  });
});

describe("色の点", () => {
  it("欄の左の点は、作ったあとのサイドバーの点・見出しの点と同じ色（アーカイブ済みは数に入れ、削除済みは入れない）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putProject(makeProject({ name: "A", createdAt: "2026-01-01T00:00:00.000Z" }));
    server.putProject(
      makeProject({
        name: "B",
        createdAt: "2026-01-02T00:00:00.000Z",
        archivedAt: "2026-02-01T00:00:00.000Z",
      }),
    );
    server.putProject(
      makeProject({
        name: "消した",
        createdAt: "2026-01-03T00:00:00.000Z",
        deletedAt: "2026-02-01T00:00:00.000Z",
      }),
    );
    // 色を選び直したプロジェクトも、作成順の数には入る
    server.putProject(
      makeProject({ name: "D", color: "teal", createdAt: "2026-01-04T00:00:00.000Z" }),
    );
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    const shown = colorOf(nameField().closest("li"));
    // A（violet）・B（sky。アーカイブ済み）・D（3 番目。色は teal を選んである）の次の、4 番目の色
    expect(shown).toBe("amber");

    await user.type(nameField(), "新しい{Enter}");
    await screen.findByRole("listbox", { name: "新しい" });
    expect(colorOf(projectLink("新しい"))).toBe(shown);
    // 見出しの左の色のボタン（押すと色を選び直せる）
    expect(colorOf(screen.getByRole("button", { name: /^プロジェクトの色：/ }))).toBe(shown);

    // 同期のあと（サーバーの createdAt に置き換わったあと）も変わらない
    await settle(store);
    await act(async () => {
      await store.sync();
    });
    expect(colorOf(projectLink("新しい"))).toBe(shown);
  });

  it("⌘Z で取り消したあとに開き直すと、点は同じ色に戻る（取り消したプロジェクトは数に入らない）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putProject(makeProject({ name: "A" }));
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    const shown = colorOf(nameField().closest("li"));
    expect(shown).toBe("sky");
    await user.type(nameField(), "取り消す{Enter}");
    await screen.findByRole("listbox", { name: "取り消す" });
    await user.keyboard("{Meta>}z{/Meta}");
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    expect(colorOf(nameField().closest("li"))).toBe(shown);
  });
});

describe("⌘Z", () => {
  it("ボードで見ているプロジェクトでも、⌘Z で消えて今日へ移る（履歴は置き換える）", async () => {
    const user = userEvent.setup();
    const { store, server, location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.click(createButton());
    await user.type(nameField(), "ボードで見る{Enter}");
    const project = store.lists.projects.find((row) => row.name === "ボードで見る");
    await screen.findByRole("listbox", { name: "ボードで見る" });
    await user.keyboard("v");
    const board = await screen.findByRole("listbox", { name: "ボードで見るのボード" });
    await waitFor(() => expect(board).toHaveFocus());

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);
    await screen.findByRole("listbox", { name: "今日" });
    expect(location.history).toEqual(["/inbox", "/today"]);
    expect(within(sidebar()).queryByRole("link", { name: /^ボードで見る/ })).toBeNull();
    // 消えたプロジェクトの画面（「見つかりません」）は出ない
    expect(screen.queryByText("プロジェクトが見つかりません")).toBeNull();

    await settle(store);
    expect(server.projects.get(project?.id ?? "")?.deletedAt).not.toBeNull();
  });

  it("そのプロジェクトの画面を開いていなければ、⌘Z で消えても画面は動かない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱の1件", bucket: "inbox" }));
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "移る前に作る{Enter}");
    await screen.findByRole("listbox", { name: "移る前に作る" });
    await user.keyboard("1");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);
    expect(within(sidebar()).queryByRole("link", { name: /^移る前に作る/ })).toBeNull();
    expect(location.history?.at(-1)).toBe("/inbox");
    expect(optionTitles("受信箱")).toEqual(["受信箱の1件"]);
  });

  it("作る → n で足す → Esc → ⌘Z 2回：1回目で足したタスク、2回目でプロジェクトが消え、今日へ移る。サーバーとも食い違わない", async () => {
    const user = userEvent.setup();
    const { store, server, location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "すぐやめる{Enter}");
    const project = store.lists.projects.find((row) => row.name === "すぐやめる");
    const list = await screen.findByRole("listbox", { name: "すぐやめる" });
    await waitFor(() => expect(list).toHaveFocus());
    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "あとでに追加" }), "足したタスク{Enter}");
    await user.keyboard("{Escape}");
    expect(optionTitles("すぐやめる")).toEqual(["足したタスク"]);

    // 1回目：足したタスクが消え、プロジェクトの画面は残る
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.later).toHaveLength(0);
    expect(store.lists.projects.map((row) => row.name)).toEqual(["すぐやめる"]);
    expect(location.history?.at(-1)).toBe(`/projects/${project?.id}`);

    // 2回目：プロジェクトが消え、今日へ移る
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);
    await screen.findByRole("listbox", { name: "今日" });
    expect(location.history).toEqual(["/today", "/today"]);

    // サーバーは受け付けていて、タスクもプロジェクトも削除済み。どの一覧にも出ない
    await settle(store);
    expect(server.projects.get(project?.id ?? "")?.deletedAt).not.toBeNull();
    const [task] = [...server.tasks.values()];
    expect(task?.deletedAt).not.toBeNull();
    expect(task?.projectId).toBe(project?.id);

    // 次の同期でも変わらない。あとでの画面も空のまま
    await act(async () => {
      await store.sync();
    });
    expect(store.lists.projects).toHaveLength(0);
    expect(store.lists.later).toHaveLength(0);
    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(optionTitles("あとで")).toEqual([]);
    expect(store.canUndo).toBe(false);
  });

  it("作る → n で足す → Esc → 待たずに ⌘Z 2回（送信中に戻す）でも、同じ結果になる", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const release = server.hold("/api/mutate");
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "送信中{Enter}");
    const project = store.lists.projects.find((row) => row.name === "送信中");
    await screen.findByRole("listbox", { name: "送信中" });
    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "あとでに追加" }), "送信中のタスク{Enter}");
    await user.keyboard("{Escape}");
    await user.keyboard("{Meta>}z{/Meta}");
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);
    expect(store.lists.later).toHaveLength(0);
    await screen.findByRole("listbox", { name: "今日" });

    release();
    await settle(store);
    await act(async () => {
      await store.sync();
    });
    expect(server.projects.get(project?.id ?? "")?.deletedAt).not.toBeNull();
    expect([...server.tasks.values()].every((row) => row.deletedAt !== null)).toBe(true);
    expect(store.lists.projects).toHaveLength(0);
    expect(store.lists.later).toHaveLength(0);
    expect(screen.queryByText("保存できませんでした")).toBeNull();
  });

  it("ほかのタブがタスクを付けたあとに作成を ⌘Z で戻すと、プロジェクトは消え、タスクは「プロジェクトなし」として残る（表示は壊れない）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "ほかのタブ");
    await user.keyboard("{Enter}");
    const project = store.lists.projects.find((row) => row.name === "ほかのタブ");
    await screen.findByRole("listbox", { name: "ほかのタブ" });
    await settle(store);

    // ほかのタブで、このプロジェクトのあとでにタスクを足す
    const other = await otherTab(server);
    const added = other.actions.addTask({
      title: "ほかのタブで足した",
      bucket: "later",
      projectId: project?.id ?? null,
    });
    expect(added.ok).toBe(true);
    await act(async () => {
      await other.idle();
      await store.sync();
    });
    expect(optionTitles("ほかのタブ")).toEqual(["ほかのタブで足した"]);

    await user.keyboard("{Meta>}z{/Meta}");
    await screen.findByRole("listbox", { name: "今日" });
    expect(location.history?.at(-1)).toBe("/today");
    await settle(store);
    // サーバーは受け付ける（プロジェクトの削除には、アーカイブのような未完了の確かめがない）
    expect(server.projects.get(project?.id ?? "")?.deletedAt).not.toBeNull();
    expect(screen.queryByText("保存できませんでした")).toBeNull();

    // タスクは消えたプロジェクトを指したまま残り、あとでの「プロジェクトなし」（見出しなし）に出る
    const task = store.lists.later.find((row) => row.title === "ほかのタブで足した");
    expect(task?.projectId).toBe(project?.id);
    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(optionTitles("あとで")).toEqual(["ほかのタブで足した"]);
    expect(screen.queryByRole("heading", { name: "ほかのタブ" })).toBeNull();
    // 行にも消えたプロジェクトの名前は出ない
    const row = screen.getByRole("option", { name: /ほかのタブで足した/ });
    expect(within(row).queryByText("ほかのタブ")).toBeNull();

    // 次の同期でも変わらない
    await act(async () => {
      await store.sync();
    });
    expect(optionTitles("あとで")).toEqual(["ほかのタブで足した"]);

    // p で別のプロジェクトに付け直せる（サーバーも受け付ける）
    await user.keyboard("jp");
    const picker = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(picker, "付け直し先{Enter}");
    await settle(store);
    const next = store.lists.projects.find((row) => row.name === "付け直し先");
    expect(server.tasks.get(task?.id ?? "")?.projectId).toBe(next?.id);
  });
});

describe("名前の欄", () => {
  it.each([
    ["小文字の半角", "aipr"],
    ["大文字と小文字の混ざり", "Aipr"],
    ["全角の大文字", "ＡＩＰＲ"],
    ["前後の空白", "  AIPR  "],
  ])("同じ名前（%s）なら作らずに開く", async (_, typed) => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const existing = makeProject({ name: "AIPR" });
    server.putProject(existing);
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), `${typed}{Enter}`);
    expect(store.lists.projects.map((row) => row.id)).toEqual([existing.id]);
    expect(location.history?.at(-1)).toBe(`/projects/${existing.id}`);
    const list = await screen.findByRole("listbox", { name: "AIPR" });
    await waitFor(() => expect(list).toHaveFocus());
  });

  it("半角カナと全角カナも同じ名前として扱う", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const existing = makeProject({ name: "デザイン" });
    server.putProject(existing);
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "ﾃﾞｻﾞｲﾝ{Enter}");
    expect(store.lists.projects).toHaveLength(1);
    expect(location.history?.at(-1)).toBe(`/projects/${existing.id}`);
  });

  it("削除済みと同じ名前なら、新しく作る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const deleted = makeProject({ name: "消した案件", deletedAt: "2026-02-01T00:00:00.000Z" });
    server.putProject(deleted);
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "消した案件{Enter}");
    const created = store.lists.projects.find((row) => row.name === "消した案件");
    expect(created?.id).not.toBe(deleted.id);
    expect(location.history?.at(-1)).toBe(`/projects/${created?.id}`);
  });

  it("空白だけの Enter では作らず、欄は開いたまま。空白だけで外を押すと閉じる", async () => {
    const user = userEvent.setup();
    const { store } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.keyboard("   {Enter}");
    expect(store.lists.projects).toHaveLength(0);
    expect(nameField()).toHaveFocus();

    await user.click(screen.getByRole("heading", { name: "今日" }));
    expect(queryNameField()).toBeNull();
    expect(store.lists.projects).toHaveLength(0);
  });

  it("Esc で閉じると、フォーカスは一覧へ戻る", async () => {
    const user = userEvent.setup();
    await open("/today");
    const list = await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "やめる{Escape}");
    expect(queryNameField()).toBeNull();
    expect(list).toHaveFocus();
  });

  it("keyCode 229（Safari の変換を確定する Enter）では作らない", async () => {
    const user = userEvent.setup();
    const { store } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(createButton());
    await user.type(nameField(), "かいはつ");
    act(() => {
      nameField().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }),
      );
    });
    expect(store.lists.projects).toHaveLength(0);
    expect(nameField()).toHaveValue("かいはつ");
  });

  it("打った名前が残ったまま ＋ か ⌘K でもう一度開くと、名前はそのままで欄にフォーカスが戻る", async () => {
    const user = userEvent.setup();
    await open("/today");
    const list = await screen.findByRole("listbox", { name: "今日" });

    await user.click(createButton());
    await user.type(nameField(), "残す名前");
    await user.click(screen.getByRole("heading", { name: "今日" }));
    expect(nameField()).not.toHaveFocus();

    await user.click(createButton());
    expect(nameField()).toHaveValue("残す名前");
    expect(nameField()).toHaveFocus();

    list.focus();
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "プロジェクトを作成{Enter}");
    await waitFor(() => expect(nameField()).toHaveFocus());
    expect(nameField()).toHaveValue("残す名前");
    expect(screen.getAllByRole("textbox", { name: "新しいプロジェクトの名前" })).toHaveLength(1);
  });

  it("オフラインのあいだは Enter で作らず、打った名前を残して開いたまま（欄の下に理由を出す）", async () => {
    const user = userEvent.setup();
    const { store, server } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });

    await user.click(createButton());
    expect(screen.getByText("オフラインのため、今は作れません")).toBeInTheDocument();
    await user.type(nameField(), "オフラインで作る{Enter}");
    expect(store.lists.projects).toHaveLength(0);
    expect(nameField()).toHaveValue("オフラインで作る");
    expect(server.requestsTo("/api/mutate")).toHaveLength(0);

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByText("Enter で作って開く ・ Esc でやめる")).toBeInTheDocument();
    await user.click(nameField());
    await user.keyboard("{Enter}");
    expect(store.lists.projects.map((row) => row.name)).toEqual(["オフラインで作る"]);
  });
});

describe("保存できなかったとき", () => {
  it("作ったあとにほかの画面へ移っていれば、断られても画面は動かず、名前は欄に戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱の1件", bucket: "inbox" }));
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    const release = server.hold("/api/mutate");
    server.fail("/api/mutate", 400);
    await user.click(createButton());
    await user.type(nameField(), "断られる名前{Enter}");
    await screen.findByRole("listbox", { name: "断られる名前" });
    await user.keyboard("1");
    await screen.findByRole("listbox", { name: "受信箱" });

    release();
    await settle(store);
    expect(store.lists.projects).toHaveLength(0);
    expect(location.history?.at(-1)).toBe("/inbox");
    expect(
      (await screen.findAllByText("「断られる名前」は、＋ で開く名前の欄に戻しました")).length,
    ).toBeGreaterThan(0);
    await user.click(createButton());
    expect(nameField()).toHaveValue("断られる名前");
  });

  it("断られたときに欄で別の名前を打っていれば、その名前を上書きしない", async () => {
    const user = userEvent.setup();
    const { store, server } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    const release = server.hold("/api/mutate");
    server.fail("/api/mutate", 400);
    await user.click(createButton());
    await user.type(nameField(), "先に作った{Enter}");
    await screen.findByRole("listbox", { name: "先に作った" });
    await user.click(createButton());
    await user.type(nameField(), "打っている途中");

    release();
    await settle(store);
    expect(store.lists.projects).toHaveLength(0);
    await screen.findByRole("listbox", { name: "今日" });
    expect(nameField()).toHaveValue("打っている途中");
    expect(screen.queryByText("「先に作った」は、＋ で開く名前の欄に戻しました")).toBeNull();
    expect((await screen.findAllByText("保存できませんでした")).length).toBeGreaterThan(0);
  });
});
