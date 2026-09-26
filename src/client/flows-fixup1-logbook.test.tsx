import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { LOGBOOK_PAGE_SIZE } from "./screens/logbook-screen";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/** 4-修正1の4：完了ログの一番下で ↓ を押し続けても、上限が際限なく増えない */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("完了ログの続きの表示", () => {
  it("200 行より多いとき、一番下で ↓ を押すと続きが出て、残り件数が合う。全部出たら増えなくなる", async () => {
    const total = LOGBOOK_PAGE_SIZE + 5;
    const server = new FakeServer();
    for (let i = 0; i < total; i++) {
      server.putTask(
        makeTask({
          title: `T${i}`,
          bucket: "later",
          completedAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(
            i % 60,
          ).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const { store } = await setupApp("/logbook", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "完了ログ" });

    expect(screen.getByRole("button", { name: /さらに表示（残り 5 件）/ })).toBeInTheDocument();
    expect(screen.getAllByRole("option")).toHaveLength(LOGBOOK_PAGE_SIZE);

    const user = userEvent.setup();
    // 一番下（LOGBOOK_PAGE_SIZE 件目）まで移動してから、さらに1回 ↓ を押して末尾を超えようとする
    // （onReachEnd が、そのときの選択位置が最後の行かどうかで続きを読み込む）
    for (let i = 0; i < LOGBOOK_PAGE_SIZE + 1; i++) await user.keyboard("j");
    expect(screen.getAllByRole("option")).toHaveLength(total);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();

    // 末尾でさらに ↓ を押し続けても、行数や表示は変わらない（上限が際限なく増えない）
    await user.keyboard("j".repeat(5));
    expect(screen.getAllByRole("option")).toHaveLength(total);
    expect(screen.queryByRole("button", { name: /さらに表示/ })).toBeNull();
  });
});
