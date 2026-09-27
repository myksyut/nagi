import { act, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "../../data";
import { FakeServer } from "../../test/fake-server";
import { makeProject, makeTask } from "../../test/fixtures";
import { setupApp } from "../../test/render-app";
import { openCountOfProject, openCountsCalculator } from "./open-counts";

/**
 * 9-修正1：サイドバーのプロジェクトの件数は、行の出入りとプロジェクトの付け替えのときだけ数え直す。
 * タイトル・メモ・チェックリストの保存では数え直さない（サイドバーが見えているあいだ、2 万件を数え直さないように）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

async function open() {
  const server = new FakeServer();
  const project = makeProject({ name: "AIPR" });
  server.putProject(project);
  const a = server.putTask(makeTask({ title: "A", bucket: "today", projectId: project.id }));
  const b = server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "今日" });
  // サイドバーが件数を観測している（リンクの名前は「AIPR （1件）」）
  const nav = screen.getByRole("navigation", { name: "リスト" });
  expect(within(nav).getByRole("link", { name: "AIPR （1件）" })).toBeInTheDocument();
  return { store, project, a, b };
}

describe("プロジェクトの件数の数え直し", () => {
  it("タイトル・メモ・チェックリストの保存では数え直さない", async () => {
    const { store, a } = await open();
    const count = vi.spyOn(openCountsCalculator, "count");

    act(() => {
      store.actions.updateTask(a.id, { title: "A を直した" });
      store.actions.updateTask(a.id, { memo: "メモ" });
      store.actions.updateTask(a.id, {
        checklist: [{ id: "0199a000-0000-7000-8000-00000000c001", title: "手順", done: false }],
      });
    });

    expect(store.task(a.id)?.title).toBe("A を直した");
    expect(count).not.toHaveBeenCalled();
  });

  it("p で付け替えると数え直し、件数が変わる", async () => {
    const { store, project, b } = await open();
    const count = vi.spyOn(openCountsCalculator, "count");

    act(() => {
      store.actions.setProject([b.id], project.id);
    });

    expect(count).toHaveBeenCalledTimes(1);
    expect(openCountOfProject(store, project.id)).toBe(2);
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).getByRole("link", { name: "AIPR （2件）" })).toBeInTheDocument();
  });

  it("完了すると数え直し、件数が減る（0 件なら件数を出さない）", async () => {
    const { store, project, a } = await open();
    const count = vi.spyOn(openCountsCalculator, "count");

    act(() => {
      store.actions.completeTasks([a.id]);
    });

    expect(count).toHaveBeenCalledTimes(1);
    expect(openCountOfProject(store, project.id)).toBe(0);
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(within(nav).getByRole("link", { name: "AIPR" })).toBeInTheDocument();
  });
});
