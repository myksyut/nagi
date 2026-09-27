import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * 完了の条件3（あとでの画面）：あとでがプロジェクトごとに分かれて並ぶ。
 * later-sections.test.ts は laterSections（純粋な関数）の単体、こちらは screens/later-screen.tsx の配線を通した確認
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openLater(server: FakeServer) {
  const { store } = await setupApp("/later", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "あとで" });
  return store;
}

describe("あとでの並び", () => {
  it("プロジェクトなしが先頭（見出しなし）、そのあとプロジェクトの作成順（見出しは名前）、中は rank 順", async () => {
    const server = new FakeServer();
    const p1 = makeProject({ name: "先に作った", createdAt: "2026-01-01T00:00:00.000Z" });
    const p2 = makeProject({ name: "あとで作った", createdAt: "2026-01-02T00:00:00.000Z" });
    server.putProject(p1);
    server.putProject(p2);
    server.putTask(makeTask({ title: "なし1", bucket: "later", rank: "a0" }));
    server.putTask(makeTask({ title: "p2の1", bucket: "later", rank: "a0", projectId: p2.id }));
    server.putTask(makeTask({ title: "p1の1", bucket: "later", rank: "b0", projectId: p1.id }));
    server.putTask(makeTask({ title: "p1の2", bucket: "later", rank: "a0", projectId: p1.id }));
    await openLater(server);

    expect(optionTitles("あとで")).toEqual(["なし1", "p1の2", "p1の1", "p2の1"]);

    // サイドバーの「プロジェクト」の見出しと区別するため、あとでの listbox の中だけを見る
    const list = screen.getByRole("listbox", { name: "あとで" });
    const headings = within(list)
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual(["先に作った", "あとで作った"]);
  });

  it("あとでの行にはプロジェクト名が出ない（今日の行には出ることと対比：flows-project-picker.test.tsx で確認済み）", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    server.putTask(makeTask({ title: "あとでのタスク", bucket: "later", projectId: project.id }));
    await openLater(server);

    const laterList = screen.getByRole("listbox", { name: "あとで" });
    // 見出し（h2「AIPR」）はまとまりの名前として出るのでそれ自体は正しい。行（option）の中に出ないことを確かめる
    const rows = within(laterList).getAllByRole("option");
    for (const row of rows) {
      expect(within(row).queryByText("AIPR")).toBeNull();
    }
  });
});

describe("あとでの画面での p の付け替え", () => {
  it("別のプロジェクトを付けると、そのまとまり（見出しの下）へ移る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "移し先" });
    server.putProject(project);
    server.putTask(makeTask({ title: "移すタスク", bucket: "later", rank: "a0" }));
    const store = await openLater(server);
    const user = userEvent.setup();

    await user.keyboard("jp");
    const comboInput = await screen.findByRole("combobox", { name: "プロジェクト" });
    await user.type(comboInput, "移し先{Enter}");
    await act(async () => {
      await store.idle();
    });
    const list = screen.getByRole("listbox", { name: "あとで" });
    await within(list).findByRole("heading", { level: 2, name: "移し先" });
    // 見出しのあとに行が続く（同じまとまりに入っている）。包み（Motion の div）に依存せず、
    // 見出しと行（option）を文書の順に並べて確かめる
    const items = Array.from(list.querySelectorAll<HTMLElement>('h2, [role="option"]'));
    const headingIndex = items.findIndex((el) => el.textContent === "移し先");
    const rowIndex = items.findIndex((el) => el.textContent?.includes("移すタスク"));
    expect(headingIndex).toBeGreaterThanOrEqual(0);
    expect(rowIndex).toBe(headingIndex + 1);
  });
});

describe("あとでの画面での n の追加", () => {
  it("追加欄はプロジェクトなしのまとまりの下に開き、足したタスクはプロジェクトなしに入る", async () => {
    const server = new FakeServer();
    const project = makeProject({ name: "P" });
    server.putProject(project);
    server.putTask(makeTask({ title: "既存のなし", bucket: "later", rank: "a0" }));
    server.putTask(
      makeTask({ title: "既存のP", bucket: "later", rank: "a0", projectId: project.id }),
    );
    const store = await openLater(server);
    const user = userEvent.setup();

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "あとでに追加" });
    await user.type(input, "新しいタスク{Enter}");
    await act(async () => {
      await store.idle();
    });

    const added = store.lists.later.find((t) => t.title === "新しいタスク");
    expect(added).toBeDefined();
    expect(added?.projectId).toBeNull();
    // 追加欄はプロジェクトなしのまとまり（一番上）の下に開いている
    expect(optionTitles("あとで").indexOf("新しいタスク")).toBeLessThan(
      optionTitles("あとで").indexOf("既存のP"),
    );
  });
});
