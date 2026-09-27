import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "@/data";
import { KEY_GROUP_ORDER, keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";

/**
 * `?`：ショートカット一覧。keymap.list() から、group ごとにすべてのキー付きで並ぶ（手で書き写さない）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("?：ショートカット一覧", () => {
  it("キーマップのすべての割り当てが、group ごとに、すべてのキー付きで並ぶ", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("?");
    const dialog = await screen.findByRole("dialog");

    for (const group of KEY_GROUP_ORDER) {
      const bindings = keymap.list().filter((binding) => binding.group === group);
      if (bindings.length === 0) continue;
      const section = within(dialog).getByRole("region", { name: group });
      for (const binding of bindings) {
        // ラベルが出ている
        expect(within(section).getByText(binding.label)).toBeInTheDocument();
        // そのラベルの行の dt/dd 構造から、割り当てたキーがすべて出ている
        const row = within(section).getByText(binding.label).closest("div");
        expect(row).not.toBeNull();
        for (const key of binding.keys) {
          expect(within(row as HTMLElement).getByText(formatKey(key))).toBeInTheDocument();
        }
      }
    }
  });

  it("⌘K の「ショートカット一覧」からも開ける", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    await setupApp("/today", server);
    await screen.findByRole("listbox", { name: "今日" });
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "ショートカット{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("ショートカット")).toBeInTheDocument();
  });
});
