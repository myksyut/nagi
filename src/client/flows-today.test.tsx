import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { optionTitles, setupApp } from "./test/render-app";

/**
 * 完了の条件1：キー操作だけで、追加 → 今日を見る → 完了 → 元に戻す → 受信箱から t・l で振り分け →
 * あとでの一覧で見る → 完了ログで見返す、が一通りできる
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("追加 → 今日 → 完了 → 元に戻す", () => {
  it("n → タイトル → Enter（続けて追加）→ Esc → 移動 → x → ⌘Z", async () => {
    const user = userEvent.setup();
    const { store } = await setupApp("/today");
    stores.push(store);
    await screen.findByRole("listbox", { name: "今日" });

    await user.keyboard("n");
    const input = screen.getByRole("textbox", { name: "今日に追加" });
    await user.type(input, "一つ目{Enter}");
    // 追加欄は開いたままなので、続けて次を打てる
    expect(screen.getByRole("textbox", { name: "今日に追加" })).toBeInTheDocument();
    await user.type(input, "二つ目{Enter}");
    expect(store.lists.today.map((t) => t.title)).toEqual(["一つ目", "二つ目"]);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "今日に追加" })).toBeNull();
    // Esc で閉じると、最後に追加したタスクが選ばれる
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("二つ目");

    // ↑↓・j k で選ぶ
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("一つ目");
    await user.keyboard("j");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("二つ目");
    await user.keyboard("k");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("一つ目");

    // x で完了。今日では行が「完了 N件」に収まり、選択は次（下）の行へ
    await user.keyboard("x");
    expect(store.lists.completedTodayCount).toBe(1);
    expect(optionTitles("今日")).toEqual(["二つ目"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("二つ目");
    expect(screen.getByRole("button", { name: /完了 1件/ })).toBeInTheDocument();

    // ⌘Z で元の位置に戻り、戻った行が選ばれる
    await user.keyboard("{Meta>}z{/Meta}");
    expect(store.lists.today.map((t) => t.title)).toEqual(["一つ目", "二つ目"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("一つ目");
  });

  it("下に行がなければ、完了すると上の行が選ばれる", async () => {
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

    await user.keyboard("jj"); // B を選ぶ（一番下）
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
    await user.keyboard("x");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("A");
  });
});

describe("受信箱の振り分け（t・l）とあとで・完了ログ", () => {
  it("受信箱は古い順。t で今日へ、l であとでへ。選択は次へ移り、トーストが出る", async () => {
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
    expect(optionTitles("受信箱")).toEqual(["A", "B", "C"]);

    await user.keyboard("j"); // A を選ぶ
    await user.keyboard("t");
    expect(optionTitles("受信箱")).toEqual(["B", "C"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("B");
    expect(await screen.findByText("「A」を今日へ")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "元に戻す" })).toBeInTheDocument();

    await user.keyboard("l");
    expect(optionTitles("受信箱")).toEqual(["C"]);
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("C");
    expect(await screen.findByText("「B」をあとでへ")).toBeInTheDocument();

    // 2 で今日、4 であとで、1 で受信箱、5 で完了ログ、3 で予定
    await user.keyboard("4");
    await screen.findByRole("listbox", { name: "あとで" });
    expect(optionTitles("あとで")).toEqual(["B"]);

    await user.keyboard("2");
    await screen.findByRole("listbox", { name: "今日" });
    expect(optionTitles("今日")).toEqual(["A"]);

    await user.keyboard("3");
    await screen.findByRole("heading", { name: "予定" });

    await user.keyboard("1");
    await screen.findByRole("listbox", { name: "受信箱" });
    expect(optionTitles("受信箱")).toEqual(["C"]);

    await user.keyboard("5");
    await screen.findByRole("heading", { name: "完了ログ" });
  });

  it("完了ログは昨日までを日ごとに新しい順、見出しは「M月D日 曜日曜日」", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "古い分", bucket: "later", completedAt: "2026-01-05T00:00:00.000Z" }),
    );
    server.putTask(
      makeTask({
        title: "もっと新しい分",
        bucket: "inbox",
        completedAt: "2026-01-06T00:00:00.000Z",
      }),
    );
    const { store } = await setupApp("/logbook", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const list = await screen.findByRole("listbox", { name: "完了ログ" });
    const headings = within(list).getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual(["1月6日 火曜日", "1月5日 月曜日"]);
    expect(optionTitles("完了ログ")).toEqual(["もっと新しい分", "古い分"]);
  });
});
