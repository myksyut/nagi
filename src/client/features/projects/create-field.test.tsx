import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeProject } from "@/test/fixtures";
import { optionTitles, setupApp } from "@/test/render-app";

/**
 * 17：サイドバーの ＋ と ⌘K からプロジェクトを作る（タスクがなくても作れる）。
 * Enter で作ってその画面を開き、n でそのプロジェクトの「あとで」に足せる。同じ名前なら作らずに開く。
 * Esc と外のクリックの決まり、⌘Z で消えて今日へ移ること
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

function sidebar() {
  return screen.getByRole("navigation", { name: "リスト" });
}

function nameField(): HTMLElement {
  return screen.getByRole("textbox", { name: "新しいプロジェクトの名前" });
}

describe("＋ で作る", () => {
  it("タスクがなくても作れ、その画面が開き、一覧にフォーカスが移って n であとでに足せる", async () => {
    const user = userEvent.setup();
    const { store, location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveFocus();
    await user.type(nameField(), "社内勉強会{Enter}");

    const project = store.lists.projects.find((row) => row.name === "社内勉強会");
    expect(project).toBeDefined();
    expect(location.history?.at(-1)).toBe(`/projects/${project?.id}`);
    expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull();
    const list = await screen.findByRole("listbox", { name: "社内勉強会" });
    await waitFor(() => expect(list).toHaveFocus());
    expect(within(sidebar()).getByRole("link", { name: /^社内勉強会/ })).toBeInTheDocument();

    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "あとでに追加" }), "資料を作る{Enter}");
    const task = store.lists.later.find((row) => row.title === "資料を作る");
    expect(task?.projectId).toBe(project?.id);
  });

  it("欄の左に、作ると付く色の点（作成順。アーカイブ済みも数に入る）", async () => {
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
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    const field = nameField().closest("li") as HTMLElement;
    // A（violet）・B（sky。アーカイブ済み）の次の、3 番目の色
    expect(field.querySelector("[data-project-color]")).toHaveAttribute(
      "data-project-color",
      "pink",
    );
  });

  it("同じ名前（全角半角・大文字小文字を区別しない）があれば作らずに開く。アーカイブ済みとは比べない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const existing = makeProject({ name: "AIPR" });
    const archived = makeProject({ name: "旧案件", archivedAt: "2026-02-01T00:00:00.000Z" });
    server.putProject(existing);
    server.putProject(archived);
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "ａｉｐｒ{Enter}");
    expect(location.history?.at(-1)).toBe(`/projects/${existing.id}`);
    expect(store.lists.projects.filter((row) => row.name.toLowerCase() === "aipr")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "旧案件{Enter}");
    const created = store.lists.projects.find((row) => row.name === "旧案件");
    expect(created).toBeDefined();
    expect(created?.id).not.toBe(archived.id);
    expect(location.history?.at(-1)).toBe(`/projects/${created?.id}`);
  });
});

describe("閉じ方", () => {
  it("Esc で閉じる。何も打たずに外を押すと閉じ、打った名前があるまま外を押すと残る", async () => {
    const user = userEvent.setup();
    const { store } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    await create();
    await user.type(nameField(), "やめる名前");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull();

    // Esc で閉じたら、打った名前は残らない
    await create();
    expect(nameField()).toHaveValue("");
    await user.click(screen.getByRole("heading", { name: "今日" }));
    expect(screen.queryByRole("textbox", { name: "新しいプロジェクトの名前" })).toBeNull();

    await create();
    await user.type(nameField(), "残す名前");
    await user.click(screen.getByRole("heading", { name: "今日" }));
    expect(nameField()).toHaveValue("残す名前");
    expect(store.lists.projects).toHaveLength(0);
  });

  it("変換中の Enter では作らない", async () => {
    const user = userEvent.setup();
    const { store } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "かいはつ");
    act(() => {
      nameField().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }),
      );
    });
    expect(store.lists.projects).toHaveLength(0);
    expect(nameField()).toHaveValue("かいはつ");
  });
});

describe("保存できなかったとき", () => {
  it("サーバーに断られたら、プロジェクトは消えて今日へ移り、打った名前は欄に戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/inbox", server);
    await screen.findByRole("listbox", { name: "受信箱" });

    server.fail("/api/mutate", 400);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "断られる{Enter}");
    await act(async () => {
      await store.idle();
    });

    expect(store.lists.projects).toHaveLength(0);
    await waitFor(() => expect(location.history?.at(-1)).toBe("/today"));
    expect(
      (await screen.findAllByText("作れなかったプロジェクトの名前は、＋ で開く欄に戻しました"))
        .length,
    ).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("断られる");
  });

  it("2件続けて作って両方断られたら、どちらの名前も失わず、欄を開くたびに古い順に入る", async () => {
    const user = userEvent.setup();
    const { store, server } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    const release = server.hold("/api/mutate");
    server.fail("/api/mutate", 400);
    await create();
    await user.type(nameField(), "1つ目{Enter}");
    await create();
    await user.type(nameField(), "2つ目{Enter}");
    release();
    await act(async () => {
      await store.idle();
    });
    expect(store.lists.projects).toHaveLength(0);

    await create();
    expect(nameField()).toHaveValue("1つ目");
    expect(screen.getByText(/ほかに 1件/)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await create();
    expect(nameField()).toHaveValue("2つ目");
    expect(screen.queryByText(/ほかに/)).toBeNull();
    await user.keyboard("{Enter}");
    await act(async () => {
      await store.idle();
    });
    expect(store.lists.projects.map((project) => project.name)).toEqual(["1つ目", "2つ目"]);
  });

  it("断られたときに次の名前を打っている途中なら、その名前は上書きせず、断られた名前は次に開いたときに入る", async () => {
    const user = userEvent.setup();
    const { store, server } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    const release = server.hold("/api/mutate");
    server.fail("/api/mutate", 400);
    await create();
    await user.type(nameField(), "先に作った{Enter}");
    await create();
    await user.type(nameField(), "打っている途中");
    release();
    await act(async () => {
      await store.idle();
    });

    expect(nameField()).toHaveValue("打っている途中");
    expect(screen.getByText(/ほかに 1件/)).toBeInTheDocument();
    await user.keyboard("{Enter}");
    await create();
    expect(nameField()).toHaveValue("先に作った");
  });

  it("ログインが切れた（401）ときも、名前は残り、ログインし直したあとに欄を開くと入っている", async () => {
    const user = userEvent.setup();
    const { store, server, location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    server.fail("/api/mutate", 401);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "401で消える{Enter}");
    await act(async () => {
      await store.idle();
    });
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));
    expect(store.stoppedBy).toBe("unauthorized");

    // ログインし直す（ページを読み込み直すので、画面とストアを作り直す）
    cleanup();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("401で消える");
  });

  it("欄に打っている名前は、読み込み直しても残る", async () => {
    const user = userEvent.setup();
    const { server } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "打ちかけ");

    cleanup();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("打ちかけ");
  });
});

describe("⌘K と ⌘Z", () => {
  it("⌘K の「プロジェクトを作成」は欄を開くだけ（キーはなし）", async () => {
    const user = userEvent.setup();
    await open("/today");
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "プロジェクトを作成");
    const option = screen.getByRole("option", { name: /プロジェクトを作成/ });
    expect(option.querySelector("kbd")).toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(nameField()).toHaveFocus());
  });

  it("⌘Z で作成が消え、その画面を開いていれば今日へ移る。トーストは出さない", async () => {
    const user = userEvent.setup();
    const { store, location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "すぐ消す{Enter}");
    const list = await screen.findByRole("listbox", { name: "すぐ消す" });
    await waitFor(() => expect(list).toHaveFocus());
    expect(screen.queryByText(/元に戻す/)).toBeNull();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.projects).toHaveLength(0);
    await waitFor(() => expect(location.history?.at(-1)).toBe("/today"));
    await screen.findByRole("listbox", { name: "今日" });
    expect(within(sidebar()).queryByRole("link", { name: /^すぐ消す/ })).toBeNull();
    expect(optionTitles("今日")).toEqual([]);
  });
});
