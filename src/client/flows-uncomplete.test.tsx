import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * 完了の条件2：完了を外す2通り（⌘Z・「元に戻す」は元の場所・元の位置に戻る／
 * 「完了 N件」や完了ログの行を x・丸で押すと「あとから外す」扱いで今日の一番下に戻る）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("⌘Z・「元に戻す」は元の場所・元の位置に戻る", () => {
  it("受信箱の真ん中を完了 → ⌘Z で受信箱の同じ位置に戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "A", bucket: "inbox", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "B", bucket: "inbox", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({ title: "C", bucket: "inbox", createdAt: "2026-01-03T00:00:00.000Z" }),
    );
    const { store } = await setupApp("/inbox", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "受信箱" });

    await user.keyboard("jj"); // B（真ん中）を選ぶ
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
    await user.keyboard("x");
    expect(optionTitles("受信箱")).toEqual(["A", "C"]);
    expect(await screen.findByText("完了しました")).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
  });

  it("今日の真ん中を完了 → 画面下の「元に戻す」で今日の同じ位置に戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a2" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("jj"); // B（真ん中）を選ぶ
    await user.keyboard("x");
    expect(optionTitles("今日")).toEqual(["A", "C"]);
    // 今日で完了したときはトーストが出ない
    expect(screen.queryByText("完了しました")).toBeNull();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.map((t) => t.title)).toEqual(["A", "B", "C"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
  });

  it("あとでで完了 → ⌘Z であとでに戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "later", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "later", rank: "a1" }));
    const { store } = await setupApp("/later", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "あとで" });

    await user.keyboard("j");
    await user.keyboard("x");
    expect(optionTitles("あとで")).toEqual(["B"]);
    expect(await screen.findByText("完了しました")).toBeInTheDocument();

    await user.keyboard("{Meta>}z{/Meta}");
    expect(optionTitles("あとで")).toEqual(["A", "B"]);
  });
});

describe("あとから完了を外す：今日の一番下に戻る", () => {
  it("「完了 N件」を開いて ↑↓ で選び、x で今日の一番下へ（元の位置ではない。選択はその行のまま）", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    server.putTask(makeTask({ title: "C", bucket: "today", rank: "a2" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("j"); // A（一番上）を選ぶ
    await user.keyboard("x"); // A を完了
    expect(optionTitles("今日")).toEqual(["B", "C"]);

    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    expect(optionTitles("今日")).toEqual(["B", "C", "A"]);
    // 完了 N件 の中の行も ↑↓ で選べる
    await user.keyboard("jj");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("A");

    await user.keyboard("x");
    // 元の位置（一番上）ではなく、今日の一番下に戻り、選択はその行のまま
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "C", "A"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("A");
    expect(store.lists.completedTodayCount).toBe(0);
  });

  it("「完了 N件」の中の行は、丸のクリックでも外れ、今日の一番下に戻る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(makeTask({ title: "A", bucket: "today", rank: "a0" }));
    server.putTask(makeTask({ title: "B", bucket: "today", rank: "a1" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("jx"); // A（一番上）を完了
    await user.click(screen.getByRole("button", { name: /完了 1件/ }));
    await user.click(screen.getByRole("button", { name: "「A」の完了を外す" }));
    expect(store.lists.today.map((t) => t.title)).toEqual(["B", "A"]);
    expect(store.lists.completedTodayCount).toBe(0);
  });

  it("完了ログの行で x を押すと、今日の一番下へ移り、完了ログから抜けてトーストが出る", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "昔", bucket: "later", completedAt: "2026-01-05T00:00:00.000Z" }),
    );
    server.putTask(makeTask({ title: "今日の", bucket: "today", rank: "a0" }));
    const { store } = await setupApp("/logbook", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: /1月5日/ });

    await user.keyboard("jx");
    expect(store.lists.today.map((t) => t.title)).toEqual(["今日の", "昔"]);
    expect(await screen.findByText("「昔」を今日に戻しました")).toBeInTheDocument();
    expect(screen.getByText("完了したタスクはまだありません")).toBeInTheDocument();
  });
});
