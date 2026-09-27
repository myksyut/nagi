import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";

/**
 * 16 の実装担当の確かめ（最小限）：⇧P と e の候補、行の印、見出しの合計、並び方と ⌥↑↓ の止め方。
 * 完了の条件の確かめは、別のテストで行う
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openToday(server: FakeServer) {
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "今日" });
  return store;
}

function titles(): string[] {
  const list = screen.getByRole("listbox", { name: "今日" });
  return within(list)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

describe("⇧P と e", () => {
  it("⇧P の 1 で2件まとめて高になり、トーストが出て、⌘Z で戻る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const store = await openToday(server);
    const user = userEvent.setup();

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}{Shift>}P{/Shift}");
    await screen.findByRole("combobox", { name: "優先度" });
    await user.keyboard("1");

    expect(store.lists.today.map((row) => row.priority)).toEqual(["high", "high"]);
    expect(screen.getAllByRole("img", { name: "優先度 高" })).toHaveLength(2);
    expect((await screen.findAllByText("2件の優先度を高に")).length).toBeGreaterThan(0);
    expect(screen.getByRole("listbox", { name: "今日" })).toHaveFocus();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.map((row) => row.priority)).toEqual([null, null]);
  });

  it("e で 1・3 と打つと 13 に絞られ、Enter で付く。見出しに工数の合計が出る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1", points: 2 }));
    const store = await openToday(server);
    const user = userEvent.setup();
    expect(screen.getByText("2 件 ・ 工数 2", { exact: false })).toBeInTheDocument();

    await user.keyboard("je");
    const input = await screen.findByRole("combobox", { name: "工数" });
    await user.type(input, "1");
    const listbox = screen.getByRole("listbox", { name: "" });
    expect(
      within(listbox)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["1", "13"]);
    await user.type(input, "3{Enter}");

    expect(store.lists.today[0]?.points).toBe(13);
    expect(screen.getByRole("img", { name: "工数 13" })).toBeInTheDocument();
    expect(screen.getByText("2 件 ・ 工数 15", { exact: false })).toBeInTheDocument();
  });
});

describe("並び方", () => {
  it("優先度で並べると表示だけが変わり、⌥↑↓ は止まって知らせる。手動に戻すと元の並び", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0", priority: "low" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a2", priority: "high" }));
    const store = await openToday(server);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "並び：手動" }));
    await screen.findByRole("combobox", { name: "並び方" });
    await user.keyboard("2");
    await waitFor(() => expect(titles()).toEqual(["C", "A", "B"]));
    expect(screen.getByRole("button", { name: "並び：優先度" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      today: "priority",
    });

    // 選択は表示の並びのとおり（↓ で一番上の C）。⌥↓ は並べ替えずに知らせる
    await user.keyboard("j");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("C");
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}");
    expect((await screen.findAllByText("手動の並びのときに使えます")).length).toBeGreaterThan(0);
    expect(titles()).toEqual(["C", "A", "B"]);
    expect(store.lists.today.map((row) => row.title)).toEqual(["A", "B", "C"]);

    await user.click(screen.getByRole("button", { name: "並び：優先度" }));
    await screen.findByRole("combobox", { name: "並び方" });
    await user.keyboard("1");
    await waitFor(() => expect(titles()).toEqual(["A", "B", "C"]));
    localStorage.removeItem("nagi:task-sorts");
  });
});
