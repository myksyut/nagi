import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "@/data";
import { fieldKeyScenes, registerFieldKeys } from "@/keyboard/field-keys";
import { KEY_GROUP_ORDER, keymap, registerKeyBindings } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";

/**
 * 17：ショートカットのページ（`/shortcuts`）。キーマップのすべての割り当てと、候補や欄の中のキーが並び（手で書き写さない）、
 * 絞り込める。`?`・⌘K・サイドバーから開き、Esc か `?` で前の画面に戻る
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function open(path: string) {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "A", bucket: "today" }));
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

function filterInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "ショートカットを絞り込む" });
}

describe("開き方と戻り方", () => {
  it("? で開き、絞り込みの欄にフォーカスがある。欄の外で ? を押すと前の画面に戻る", async () => {
    const user = userEvent.setup();
    const { location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("?");
    await screen.findByRole("heading", { name: "ショートカット" });
    expect(location.history?.at(-1)).toBe("/shortcuts");
    expect(filterInput()).toHaveFocus();

    // 欄の中の ? は文字として入る
    await user.keyboard("?");
    expect(filterInput()).toHaveValue("?");
    await user.clear(filterInput());
    filterInput().blur();

    await user.keyboard("?");
    expect(location.history?.at(-1)).toBe("/today");
    expect(await screen.findByRole("listbox", { name: "今日" })).toBeInTheDocument();
  });

  it("欄に文字があるときの Esc は先に文字を消し、もう一度の Esc で前の画面に戻る（ページの履歴は置き換える）", async () => {
    const user = userEvent.setup();
    const { location } = await open("/inbox");
    await screen.findByRole("listbox", { name: "受信箱" });
    await user.keyboard("?");
    await screen.findByRole("heading", { name: "ショートカット" });

    await user.type(filterInput(), "締切");
    await user.keyboard("{Escape}");
    expect(filterInput()).toHaveValue("");
    expect(location.history?.at(-1)).toBe("/shortcuts");

    await user.keyboard("{Escape}");
    expect(location.history).toEqual(["/inbox", "/inbox"]);
  });

  it("直接開いたときは、Esc で今日へ", async () => {
    const user = userEvent.setup();
    const { location } = await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });
    await user.keyboard("{Escape}");
    expect(location.history?.at(-1)).toBe("/today");
  });

  it("サイドバーの一番下の「ショートカット」と、⌘K の「ショートカット一覧」から開ける", async () => {
    const user = userEvent.setup();
    const { location } = await open("/today");
    await screen.findByRole("listbox", { name: "今日" });

    const nav = screen.getByRole("navigation", { name: "リスト" });
    await user.click(within(nav).getByRole("link", { name: "ショートカット" }));
    await screen.findByRole("heading", { name: "ショートカット" });
    expect(within(nav).getByRole("link", { name: "ショートカット" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.keyboard("{Escape}");
    expect(location.history?.at(-1)).toBe("/today");
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "ショートカット一覧{Enter}");
    await screen.findByRole("heading", { name: "ショートカット" });
    expect(location.history?.at(-1)).toBe("/shortcuts");
  });
});

describe("並ぶもの", () => {
  it("キーマップのすべての割り当てが、まとまりごとに、すべてのキー付きで並ぶ（キーのない操作は「キーなし」）", async () => {
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });

    for (const group of KEY_GROUP_ORDER) {
      const bindings = keymap.list().filter((binding) => binding.group === group);
      if (bindings.length === 0) continue;
      const section = screen.getByRole("region", { name: group });
      for (const binding of bindings) {
        const row = within(section).getByText(binding.label, { exact: true }).closest("li");
        expect(row, binding.label).not.toBeNull();
        const inRow = within(row as HTMLElement);
        if (binding.keys.length === 0) expect(inRow.getByText("キーなし")).toBeInTheDocument();
        for (const key of binding.keys) {
          expect(inRow.getAllByText(formatKey(key)).length).toBeGreaterThan(0);
        }
        if (binding.where !== undefined) expect(inRow.getByText(binding.where)).toBeInTheDocument();
      }
    }
  });

  it("候補や欄の中のキーが、一番下に場面ごとに並ぶ（p の候補・日付の入力・追加欄・開いたタスク・チェックリスト・⌘K・名前の欄）", async () => {
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });
    const bottom = screen.getByRole("region", { name: "候補や欄の中" });

    const scenes = fieldKeyScenes();
    expect(scenes.map((scene) => scene.id)).toEqual(
      expect.arrayContaining([
        "project-picker",
        "date-entry",
        "add-row",
        "task-detail",
        "checklist",
        "palette",
        "project-name",
      ]),
    );
    for (const scene of scenes) {
      const section = within(bottom).getByRole("region", { name: scene.label });
      for (const fieldKey of scene.keys) {
        const row = within(section).getByText(fieldKey.label, { exact: true }).closest("li");
        expect(row, fieldKey.label).not.toBeNull();
        for (const key of fieldKey.keys) {
          expect(within(row as HTMLElement).getAllByText(formatKey(key)).length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("操作の名前かキーの一部で絞り込め、当てはまらなければ「見つかりません」", async () => {
    const user = userEvent.setup();
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });

    await user.type(filterInput(), "締切");
    expect(screen.getByText("締切", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("完了（もう一度で戻す）")).toBeNull();

    await user.clear(filterInput());
    await user.type(filterInput(), "d");
    expect(screen.getByText("日付を決めて予定へ")).toBeInTheDocument();
    expect(screen.getByText("締切", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("今日へ")).toBeNull();

    await user.clear(filterInput());
    await user.type(filterInput(), "ぴったり合わない言葉");
    expect(screen.getByText("見つかりません")).toBeInTheDocument();
  });

  it("開いているあいだに割り当てや欄のキーを登録すると、そのまま出る", async () => {
    await open("/shortcuts");
    await screen.findByRole("heading", { name: "ショートカット" });

    let unregister: () => void = () => {};
    let unregisterField: () => void = () => {};
    act(() => {
      unregister = registerKeyBindings({
        id: "test.new",
        label: "テストで足した操作",
        group: "タスク",
        keys: ["Shift+q"],
        run: () => {},
      });
      unregisterField = registerFieldKeys({
        id: "test-scene",
        label: "テストの欄",
        order: 999,
        keys: [{ label: "テストで足した欄のキー", keys: ["Tab"] }],
      });
    });
    try {
      const row = screen.getByText("テストで足した操作").closest("li") as HTMLElement;
      expect(within(row).getByText("⇧Q")).toBeInTheDocument();
      expect(screen.getByRole("region", { name: "テストの欄" })).toBeInTheDocument();
      expect(screen.getByText("テストで足した欄のキー")).toBeInTheDocument();
    } finally {
      act(() => {
        unregister();
        unregisterField();
      });
    }
    expect(screen.queryByText("テストで足した操作")).toBeNull();
    expect(screen.queryByText("テストで足した欄のキー")).toBeNull();
  });
});
