import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 完了の条件2・3：未完了のタスクがあるプロジェクトはアーカイブできない／
 * あとでがプロジェクトごとに分かれて並ぶ（プロジェクトの画面での並びと追加・p での付け替えも含む）
 * サーバーの project_has_open_tasks の検証は src/worker/sync/mutate.test.ts に既存のテストがある
 * （「同じまとまりで最後のタスクを完了にしてからアーカイブすると通る」も含めて確認済み）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openProject(server: FakeServer, projectId: string) {
  const { store, location } = await setupApp(`/projects/${projectId}`, server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  return { store, location };
}

describe("アーカイブ", () => {
  it("未完了のタスクがあると押してもアーカイブされず、件数のトーストが出る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    server.putTask(makeTask({ title: "未完了", bucket: "today", projectId: project.id }));
    server.putTask(
      makeTask({
        title: "完了済み",
        bucket: "today",
        projectId: project.id,
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const { store } = await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "AIPR" });
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));

    expect((await screen.findAllByText("アーカイブできません")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("未完了のタスクが 1 件残っています").length).toBeGreaterThan(0);
    expect(store.project(project.id)?.archivedAt).toBeNull();
    // サイドバーにまだ出ている（未完了の件数が付くので、名前の先頭で探す）
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).getByRole("link", { name: /^AIPR/ })).toBeInTheDocument();
  });

  it("未完了を完了させるとアーカイブでき、サイドバーから消えて /today へ移り、⌘Z で戻る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "R&D" });
    server.putProject(project);
    server.putTask(makeTask({ title: "最後の1つ", bucket: "today", projectId: project.id }));
    const { store, location } = await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "R&D" });
    // 未完了が残っているとアーカイブできない
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    expect((await screen.findAllByText("アーカイブできません")).length).toBeGreaterThan(0);
    expect(store.project(project.id)?.archivedAt).toBeNull();

    // 完了させてからなら通る
    await user.keyboard("jx");
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));

    expect((await screen.findAllByText(/「R&D」をアーカイブしました/)).length).toBeGreaterThan(0);
    expect(store.project(project.id)?.archivedAt).not.toBeNull();
    await act(async () => {
      await store.idle();
    });
    expect(location.history?.at(-1)).toBe("/today");
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).queryByRole("link", { name: "R&D" })).toBeNull();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.project(project.id)?.archivedAt).toBeNull();
    expect(within(nav).getByRole("link", { name: "R&D" })).toBeInTheDocument();
  });

  it("アーカイブ済みのプロジェクトの画面（URL で直接）は「アーカイブ済み」と「アーカイブを解除」", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "旧AIPR", archivedAt: "2026-01-01T00:00:00.000Z" });
    server.putProject(project);
    const { store } = await openProject(server, project.id);

    await screen.findByRole("heading", { name: "旧AIPR" });
    expect(screen.getByText("アーカイブ済み")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "アーカイブを解除" }));
    expect(store.project(project.id)?.archivedAt).toBeNull();
  });

  it("なければ「プロジェクトが見つかりません」", async () => {
    const server = new FakeServer();
    await openProject(server, "no-such-project");
    expect(await screen.findByText("プロジェクトが見つかりません")).toBeInTheDocument();
  });
});

describe("名前の変更", () => {
  it("見出しを押す → 直して Enter → サイドバーの名前も変わる", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "元の名前" });
    server.putProject(project);
    await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "元の名前" });
    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    const input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    await user.type(input, "新しい名前{Enter}");

    expect(await screen.findByRole("heading", { name: "新しい名前" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).getByRole("link", { name: "新しい名前" })).toBeInTheDocument();
  });

  it("Esc でやめる。空は保存しない", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "元の名前" });
    server.putProject(project);
    await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "元の名前" });
    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    let input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    await user.type(input, "捨てる文字{Escape}");
    expect(screen.getByRole("heading", { name: "元の名前" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "名前を変更" }));
    input = screen.getByRole("textbox", { name: "プロジェクト名" });
    await user.clear(input);
    await user.click(document.body);
    expect(screen.getByRole("heading", { name: "元の名前" })).toBeInTheDocument();
  });
});

describe("プロジェクトの画面の並び", () => {
  it("今日／予定／あとで／受信箱の順、一番下に全期間の「完了 N件」（閉じている）", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "今日のタスク", bucket: "today", projectId: project.id }));
    server.putTask(
      makeTask({
        title: "予定のタスク",
        bucket: "scheduled",
        scheduledOn: "2026-02-01",
        projectId: project.id,
      }),
    );
    server.putTask(makeTask({ title: "あとでのタスク", bucket: "later", projectId: project.id }));
    server.putTask(makeTask({ title: "受信箱のタスク", bucket: "inbox", projectId: project.id }));
    server.putTask(
      makeTask({
        title: "ずっと前に完了",
        bucket: "today",
        projectId: project.id,
        completedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    await openProject(server, project.id);

    await screen.findByRole("heading", { name: "P" });
    const list = screen.getByRole("listbox", { name: "P" });
    const headings = within(list)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["今日", "予定", "あとで", "受信箱"]);
    expect(within(list).getByText("完了 1件")).toBeInTheDocument();
    // 閉じている：完了済みの行は出ない
    expect(screen.queryByText("ずっと前に完了")).toBeNull();
  });

  it("プロジェクトの画面での n の追加は、そのプロジェクトの「あとで」に入る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    const { store } = await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "P" });
    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "あとでに追加" });
    await user.type(input, "新しいタスク{Enter}");
    await act(async () => {
      await store.idle();
    });

    const added = store.lists.later.find((t) => t.title === "新しいタスク");
    expect(added).toBeDefined();
    expect(added?.projectId).toBe(project.id);
  });

  it("p で別のプロジェクトに変えると、行がプロジェクトの画面から抜けてトーストが出る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "元のP" });
    const other = makeProject({ name: "別のP" });
    server.putProject(project);
    server.putProject(other);
    const task = server.putTask(
      makeTask({ title: "移すタスク", bucket: "today", projectId: project.id }),
    );
    const { store } = await openProject(server, project.id);
    const user = userEvent.setup();

    await screen.findByRole("option", { name: /移すタスク/ });
    await user.keyboard("jp");
    const comboInput = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(comboInput, "別のP{Enter}");

    expect((await screen.findAllByText(/「移すタスク」を「別のP」へ/)).length).toBeGreaterThan(0);
    expect(screen.queryByText("移すタスク")).toBeNull();
    expect(store.task(task.id)?.projectId).toBe(other.id);
  });
});
