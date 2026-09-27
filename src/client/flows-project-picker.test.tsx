import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { pickerListbox, setupApp } from "./test/render-app";

/**
 * 完了の条件1：p でプロジェクトを付けられ、その場で新しいプロジェクトも作れる。アーカイブ済みは候補に出ない
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openInbox(server: FakeServer) {
  const { store } = await setupApp("/inbox", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "受信箱" });
  return store;
}

describe("p で候補を開いて、名前で絞り込んで付ける", () => {
  it("名前の一部を打って Enter で付く。受信箱に残り、行にプロジェクト名が出る", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "田中さんに確認", bucket: "inbox" }));
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "aipr");
    await user.keyboard("{Enter}");

    // 候補は閉じ、受信箱に残る
    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    expect(store.lists.inbox).toHaveLength(1);
    expect(store.lists.inbox[0]?.projectId).not.toBeNull();
    const row = screen.getByRole("option", { selected: true });
    expect(within(row).getByText("AIPR")).toBeInTheDocument();
  });

  it("ちょうど合う名前がなければ「作成」が出て、Enter でその場で作って付ける（1つの操作。⌘Z 1回で両方戻る）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "新しい案件の下調べ", bucket: "inbox" }));
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "新プロジェクト");
    expect(
      within(pickerListbox()).getByRole("option", { name: "「新プロジェクト」を作成" }),
    ).toBeInTheDocument();
    await user.keyboard("{Enter}");

    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    const project = store.lists.projects.find((p) => p.name === "新プロジェクト");
    expect(project).toBeDefined();
    expect(store.lists.inbox[0]?.projectId).toBe(project?.id);
    // サイドバーにも出る
    const sidebarNav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(sidebarNav).getByRole("link", { name: /^新プロジェクト/ })).toBeInTheDocument();

    // 作成と付けるが1つの操作：⌘Z 1回で両方戻る
    expect(store.lists.inbox[0]?.projectId).not.toBeNull();
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.inbox[0]?.projectId).toBeNull();
    expect(store.lists.projects.some((p) => p.name === "新プロジェクト")).toBe(false);
  });

  it("送られたのは1つのまとまり（mutate は1回だけ）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    const store = await openInbox(server);
    const user = userEvent.setup();
    const before = server.requestsTo("/api/mutate").length;

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "作成テスト{Enter}");
    await act(async () => {
      await store.idle();
    });
    expect(server.requestsTo("/api/mutate").length).toBe(before + 1);
  });

  it("アーカイブ済みのプロジェクトは候補に出ない（同じ名前を打つと「作成」が出る）", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "旧AIPR", archivedAt: "2026-01-01T00:00:00.000Z" }));
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "旧AIPR");
    const listbox = pickerListbox();
    expect(within(listbox).queryByRole("option", { name: "旧AIPR" })).toBeNull();
    expect(within(listbox).getByRole("option", { name: "「旧AIPR」を作成" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(store.lists.inbox[0]?.projectId).toBeNull();
  });

  it("Esc で閉じて何も変わらない", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "何か打つ");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
    expect(store.lists.inbox[0]?.projectId).toBeNull();
    // 一覧にフォーカスが戻る
    expect(screen.getByRole("listbox", { name: "受信箱" })).toHaveFocus();
  });

  it("何も打っていないとき、付いていれば「プロジェクトを外す」が出る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    server.putTask(makeTask({ title: "タスク", bucket: "inbox", projectId: project.id }));
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    await screen.findByRole("combobox", { name: "プロジェクト" });
    const clear = within(pickerListbox()).getByRole("option", { name: "プロジェクトを外す" });
    await user.click(clear);
    expect(store.lists.inbox[0]?.projectId).toBeNull();
  });

  it("開いたタスクの一番下のボタンからも同じ候補が開く", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "AIPR" }));
    server.putTask(makeTask({ title: "タスク", bucket: "inbox" }));
    await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("j{Enter}");
    await user.click(screen.getByRole("button", { name: "プロジェクトを付ける" }));
    const input = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(input, "aipr{Enter}");
    expect(await screen.findByRole("button", { name: "プロジェクト：AIPR" })).toBeInTheDocument();
  });
});

describe("data/actions.setProject の単体（アーカイブ済みを invalid に）", () => {
  it("同じ挙動をストア越しに確認：付けた瞬間はアーカイブされていないプロジェクトのみ許可", async () => {
    const server = new FakeServer();
    const archived = makeProject({ name: "旧", archivedAt: "2026-01-01T00:00:00.000Z" });
    server.putProject(archived);
    const task = makeTask({ title: "タスク", bucket: "inbox" });
    server.putTask(task);
    const store = await openInbox(server);
    const result = store.actions.setProject([task.id], archived.id);
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("p の候補は、そのタスクが一覧から消えると自分で閉じる", () => {
  it("開いたまま、そのタスクがほかのタブで削除されたように同期で消える → 候補も閉じる", async () => {
    const server = new FakeServer();
    const task = makeTask({ title: "タスク", bucket: "inbox" });
    server.putTask(task);
    const store = await openInbox(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    expect(await screen.findByRole("combobox", { name: "プロジェクト" })).toBeInTheDocument();

    // ほかのタブで削除されたことにする（サーバー側で削除して同期）
    server.putTask({ ...task, deletedAt: "2026-01-02T00:00:00.000Z" });
    await act(async () => {
      await store.sync();
    });

    expect(screen.queryByRole("combobox", { name: "プロジェクト" })).toBeNull();
  });
});
