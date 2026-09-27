import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "@/app";
import { AppStore, StoreProvider } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { DraftStorage } from "@/tasks/draft-storage";
import { ListUi } from "@/tasks/list-ui";
import { FakeServer } from "@/test/fake-server";
import { makeProject } from "@/test/fixtures";
import { optionTitles, setupApp } from "@/test/render-app";
import { projectCreatorOf, submitProjectName } from "./create-field";

/**
 * 17：サイドバーの ＋ と ⌘K からプロジェクトを作る（タスクがなくても作れる）。
 * Enter で作ってその画面を開き、n でそのプロジェクトの「あとで」に足せる。同じ名前なら作らずに開く。
 * Esc と外のクリックの決まり、⌘Z で消えて今日へ移ること
 */

const stores: AppStore[] = [];
/** 画面を描かないタブの ProjectCreator を止める */
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
});

/** 同じストアのまま画面を作り直して、今日を開く（部品は新しく作られ、ストアと送信はそのまま） */
async function rerenderWithStore(store: AppStore) {
  cleanup();
  const location = memoryLocation({ path: "/today", record: true });
  render(
    <StoreProvider store={store}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <App />
      </Router>
    </StoreProvider>,
  );
  await screen.findByRole("listbox", { name: "今日" });
}

/** ⌘K の「ログアウト」（POST /auth/logout だけを受ける。ストアは server.fetch を使う） */
async function logoutFromPalette(user: ReturnType<typeof userEvent.setup>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(
    await screen.findByRole("combobox", { name: "検索とコマンド" }),
    "ログアウト{Enter}",
  );
}

/** 控えの列（localStorage）の中身 */
function returnedNames(): string[] {
  return new DraftStorage().loadProjectNames();
}

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

    reload();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("打ちかけ");
  });
});

/** 画面を読み込み直す（画面を離れる知らせ pagehide を出してから、画面を消す。ストアと画面は open で作り直す） */
function reload() {
  act(() => {
    window.dispatchEvent(new Event("pagehide"));
  });
  cleanup();
}

/** 画面を描かない、もう1つのタブ（同じサーバー・同じ localStorage）。名前の欄は ProjectCreator を直接動かす */
async function otherTab(server: FakeServer) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  await store.start();
  const ui = new ListUi(store);
  const context = { store, ui, navigate: vi.fn() };
  const creator = projectCreatorOf(ui);
  // 描いた画面では名前の欄の部品が動かす（ProjectCreateField）。ここでは直接動かす
  stops.push(creator.start());
  return {
    store,
    creator,
    /** ＋ で開き、name を打って Enter（空なら何もしない） */
    create(name: string) {
      act(() => {
        creator.show();
        creator.setName(name);
        submitProjectName(context);
      });
    },
    /** ＋ で開き、name を打って Esc（空の欄なら、外を押して閉じるのと同じ） */
    cancel(name = "") {
      act(() => {
        creator.show();
        creator.setName(name);
        creator.close();
      });
    },
  };
}

describe("ほかのタブ（17-修正2 の R1）", () => {
  it("ほかのタブで空の欄を閉じても（Esc・外のクリック）、こちらで打っている名前は消えず、読み込み直すと欄に入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    await open("/today", server);
    const b = await otherTab(server);
    await screen.findByRole("listbox", { name: "今日" });

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "タブAで残す名前");
    b.cancel();
    b.cancel("タブBでやめた名前");
    expect(nameField()).toHaveValue("タブAで残す名前");

    reload();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("タブAで残す名前");
  });

  it("ほかのタブで別の名前を作っても、こちらの名前は消えない。こちらで作ったら、読み込み直しても欄は空", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    await open("/today", server);
    const b = await otherTab(server);
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    await create();
    await user.type(nameField(), "Aの名前");
    b.create("Bの名前");
    await act(async () => {
      await b.store.idle();
    });
    expect(nameField()).toHaveValue("Aの名前");

    // ほかのタブが作ったあとに読み込み直しても、こちらの名前は残っている
    reload();
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await create();
    expect(nameField()).toHaveValue("Aの名前");

    await user.keyboard("{Enter}");
    await act(async () => {
      await store.idle();
      await store.sync();
    });
    expect(store.lists.projects.map((project) => project.name).sort()).toEqual([
      "Aの名前",
      "Bの名前",
    ]);

    // こちらで作ったら、読み込み直しても欄は空
    reload();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await create();
    expect(nameField()).toHaveValue("");
  });

  it("控えの列から欄に入れた名前は、ほかのタブが別の名前を作る・やめるでも消えず、読み込み直しても入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store } = await open("/today", server);
    const b = await otherTab(server);
    await screen.findByRole("listbox", { name: "今日" });
    const create = () => user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));

    server.fail("/api/mutate", 400);
    await create();
    await user.type(nameField(), "断られたA{Enter}");
    await act(async () => {
      await store.idle();
    });
    await create();
    expect(nameField()).toHaveValue("断られたA");

    b.cancel("Bでやめた");
    b.create("Bで作った");
    await act(async () => {
      await b.store.idle();
    });
    expect(nameField()).toHaveValue("断られたA");

    reload();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await create();
    expect(nameField()).toHaveValue("断られたA");
    expect(screen.queryByText(/ほかに/)).toBeNull();
  });

  it("ログインが切れた（401）ときは、欄に打っている途中の名前も控えの列へ移り、ログインし直すと入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "打っている途中");

    server.fail("/api/mutate", 401);
    act(() => {
      store.actions.addTask({ title: "401 のきっかけ", bucket: "inbox" });
    });
    await act(async () => {
      await store.idle();
    });
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));

    cleanup();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("打っている途中");
  });

  it("ほかのタブが控えの列に足したら、「ほかに N件」の数が合う（storage の知らせ）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    await open("/today", server);
    const b = await otherTab(server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "打っている途中");

    server.fail("/api/mutate", 400);
    b.create("Bで断られた");
    await act(async () => {
      await b.store.idle();
    });
    // ほかのタブの書き込みは、このタブには storage の知らせで届く（同じ window では出ないので、ここで出す）
    const key = Object.keys(localStorage).find((name) =>
      name.startsWith("nagi:draft:project-names:"),
    );
    expect(key).toBeDefined();
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key,
          newValue: key === undefined ? null : localStorage.getItem(key),
          storageArea: localStorage,
        }),
      );
    });
    expect(screen.getByText(/ほかに 1件/)).toBeInTheDocument();
    expect(nameField()).toHaveValue("打っている途中");

    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("Bで断られた");
  });
});

describe("名前の欄がなくなるとき（17-修正3 の R1-a・R1-c）", () => {
  it("名前を打っている途中に ⌘K でログアウトしても、ログインし直すと欄に名前が入っている", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    // ログアウトの POST /auth/logout だけを受ける（ストアは server.fetch を使う）
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );

    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "ログアウト前の名前");
    await user.keyboard("{Meta>}k{/Meta}");
    await user.type(
      await screen.findByRole("combobox", { name: "検索とコマンド" }),
      "ログアウト{Enter}",
    );
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));
    expect(returnedNames()).toEqual(["ログアウト前の名前"]);

    cleanup();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("ログアウト前の名前");
    expect(returnedNames()).toEqual([]);
  });

  it("画面を離れて（pagehide）控えへ移したあとに名前の欄がなくなっても、二重に積まない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "1回だけ");

    reload();
    expect(returnedNames()).toEqual(["1回だけ"]);
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("1回だけ");
    expect(screen.queryByText(/ほかに/)).toBeNull();
  });

  it("ログインが切れて（401）控えへ移したあとに名前の欄がなくなっても、二重に積まない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "401でも1回だけ");

    server.fail("/api/mutate", 401);
    act(() => {
      store.actions.addTask({ title: "401 のきっかけ", bucket: "inbox" });
    });
    await act(async () => {
      await store.idle();
    });
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));
    // ログイン画面へ移って名前の欄はもうない
    expect(screen.queryByRole("button", { name: "プロジェクトを作成" })).toBeNull();
    expect(returnedNames()).toEqual(["401でも1回だけ"]);
  });

  it("同じストアで画面を作り直してから1件が断られても、控えには1つだけ入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    // 同じストアのまま画面を作り直す（ログアウトしてログインし直した、などと同じ）
    await rerenderWithStore(store);

    server.fail("/api/mutate", 400);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), "1件だけ断られる{Enter}");
    await act(async () => {
      await store.idle();
    });
    expect(returnedNames()).toEqual(["1件だけ断られる"]);
  });
});

describe("送った作成の返事を待つあいだに部品がなくなる（17-修正4）", () => {
  /** 作成を送って返事を止めておく。fail を渡すと、止めを外したときにその返事になる */
  async function createAndHold(
    user: ReturnType<typeof userEvent.setup>,
    server: FakeServer,
    name: string,
    fail?: 400,
  ) {
    const release = server.hold("/api/mutate");
    if (fail !== undefined) server.fail("/api/mutate", fail);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    await user.type(nameField(), `${name}{Enter}`);
    await screen.findByRole("listbox", { name });
    return release;
  }

  it("作成の返事を待つあいだに ⌘K でログアウトし、ログイン画面で断られても、作り直すと名前が控えから出る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    const release = await createAndHold(user, server, "送信待ちの名前", 400);
    await logoutFromPalette(user);
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));
    expect(screen.queryByRole("button", { name: "プロジェクトを作成" })).toBeNull();
    expect(returnedNames()).toEqual([]);

    // ログイン画面になってから断られる（ストアと送信はログイン画面でも動いている）
    release();
    await act(async () => {
      await store.idle();
    });
    expect(returnedNames()).toEqual(["送信待ちの名前"]);

    cleanup();
    await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("送信待ちの名前");
  });

  it("同じ順で作成が通ったときは、控えに何も入らない", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store, location } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    const release = await createAndHold(user, server, "通る名前");
    await logoutFromPalette(user);
    await waitFor(() => expect(location.history?.at(-1)).toBe("/login"));

    release();
    await act(async () => {
      await store.idle();
    });
    expect(returnedNames()).toEqual([]);
    expect([...server.projects.values()].map((project) => project.name)).toEqual(["通る名前"]);
  });

  it("断られる前に部品を何回作り直しても、控えには1件だけ入る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const { store } = await open("/today", server);
    await screen.findByRole("listbox", { name: "今日" });

    const release = await createAndHold(user, server, "作り直しても1件", 400);
    for (let i = 0; i < 3; i++) await rerenderWithStore(store);

    release();
    await act(async () => {
      await store.idle();
    });
    expect(returnedNames()).toEqual(["作り直しても1件"]);
    await user.click(screen.getByRole("button", { name: "プロジェクトを作成" }));
    expect(nameField()).toHaveValue("作り直しても1件");
    expect(screen.queryByText(/ほかに/)).toBeNull();
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
