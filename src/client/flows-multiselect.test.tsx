import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 7 の複数選択：⇧↑↓ で範囲を広げる・縮める、⌘クリックで1行ずつ足す・外す、
 * ふつうの操作で1行に戻る、Esc で選択が外れる。aria の決まり（aria-selected・aria-multiselectable）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

async function openInboxWithFour() {
  const server = new FakeServer();
  for (const [i, title] of ["A", "B", "C", "D"].entries()) {
    server.putTask(
      makeTask({ title, bucket: "inbox", createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }),
    );
  }
  const { store } = await setupApp("/inbox", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "受信箱" });
  return store;
}

function selectedTitles(): string[] {
  return screen.getAllByRole("option", { selected: true }).map((o) => o.textContent ?? "");
}

describe("⇧↑↓：起点からカーソルまでを選ぶ", () => {
  it("下に広げてから縮める", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();

    await user.keyboard("j"); // A を選ぶ（起点）
    await user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}"); // A,B,C
    expect(selectedTitles()).toEqual(["A", "B", "C"]);

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}"); // A,B に縮む
    expect(selectedTitles()).toEqual(["A", "B"]);

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}"); // A だけ
    expect(selectedTitles()).toEqual(["A"]);
  });

  it("何も選んでいなければ ↑↓ と同じ（1行を選ぶ）", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    expect(selectedTitles()).toEqual(["A"]);
  });

  it("一覧に aria-multiselectable、選んでいる行に aria-selected", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    const listbox = screen.getByRole("listbox", { name: "受信箱" });
    expect(listbox).toHaveAttribute("aria-multiselectable", "true");

    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}");
    const options = within(listbox).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(options[2]).toHaveAttribute("aria-selected", "false");
  });
});

describe("⌘クリック：1行ずつ足す・外す", () => {
  it("⌘クリックで足していける（連続でなくてもよい）", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();

    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("option", { name: /^A/ }));
    await user.click(screen.getByRole("option", { name: /^C/ }));
    await user.keyboard("{/Meta}");
    expect(selectedTitles()).toEqual(["A", "C"]);
  });

  it("もう一度 ⌘クリックすると外れる", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    await user.keyboard("{Meta>}");
    await user.click(screen.getByRole("option", { name: /^A/ }));
    await user.click(screen.getByRole("option", { name: /^B/ }));
    await user.click(screen.getByRole("option", { name: /^A/ }));
    await user.keyboard("{/Meta}");
    expect(selectedTitles()).toEqual(["B"]);
  });
});

describe("ふつうの ↑↓・クリック・Esc", () => {
  it("複数選んでいても、ふつうの ↑↓ で1行に戻る", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(selectedTitles()).toHaveLength(3);
    await user.keyboard("{ArrowDown}");
    expect(selectedTitles()).toHaveLength(1);
  });

  it("複数選んでいても、ふつうのクリックで1行に戻る（クリックは行を開きもする）", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    await user.keyboard("j{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    await user.click(screen.getByRole("option", { name: /^D/ }));
    const selected = screen.getAllByRole("option", { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAttribute("id", expect.stringContaining("task-"));
    expect(
      within(selected[0] as HTMLElement).getByRole("textbox", { name: "タイトル" }),
    ).toHaveValue("D");
  });

  it("Esc で選択が外れる", async () => {
    const user = userEvent.setup();
    await openInboxWithFour();
    await user.keyboard("j{Shift>}{ArrowDown}{/Shift}");
    expect(selectedTitles().length).toBeGreaterThan(0);
    await user.keyboard("{Escape}");
    expect(screen.queryAllByRole("option", { selected: true })).toHaveLength(0);
  });
});
