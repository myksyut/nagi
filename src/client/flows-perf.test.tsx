import { rankAfter } from "@shared/rank";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { AppStore } from "./data";
import { registerRowMeta } from "./tasks/extensions";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 完了の条件4：今日に 100 件ある状態でも、完了や振り分けがもたつかない。
 * 「もたつかない」は、行が描き直される数を数えて確かめる（登録した部品の描画回数）。
 * 時間はゆるい上限だけ（happy-dom では Motion の測定が重く、厳しい時間の条件は置かない）
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

describe("今日に 100 件あっても、描き直される行の数は一定", () => {
  it("完了・移動を繰り返しても、100 件ぶん描き直さない", async () => {
    const renders = new Map<string, number>();
    const off = registerRowMeta({
      id: "test-render-counter",
      order: 99,
      Component: ({ task }) => {
        renders.set(task.id, (renders.get(task.id) ?? 0) + 1);
        return null;
      },
    });

    const server = new FakeServer();
    let rank = "a0";
    for (let i = 0; i < 100; i++) {
      server.putTask(makeTask({ title: `T${i}`, bucket: "today", rank }));
      rank = rankAfter(rank);
    }
    for (let i = 0; i < 30; i++) {
      server.putTask(
        makeTask({
          title: `I${i}`,
          bucket: "inbox",
          createdAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        }),
      );
    }
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });

    try {
      expect(screen.getAllByRole("option")).toHaveLength(100);

      const user = userEvent.setup();
      await user.keyboard("j");

      renders.clear();
      const completeStart = performance.now();
      for (let i = 0; i < 10; i++) await user.keyboard("x");
      const completeMs = performance.now() - completeStart;
      const completeRenders = [...renders.values()].reduce((a, b) => a + b, 0);
      // 数行だけ描き直す（100 件ぶんではない）。緩めの上限で確かめる
      expect(completeRenders).toBeLessThan(100);
      expect(completeMs).toBeLessThan(15000);

      renders.clear();
      const moveStart = performance.now();
      for (let i = 0; i < 10; i++) await user.keyboard("j");
      const moveMs = performance.now() - moveStart;
      const moveRenders = [...renders.values()].reduce((a, b) => a + b, 0);
      expect(moveRenders).toBeLessThan(100);
      expect(moveMs).toBeLessThan(15000);

      await user.keyboard("1");
      await screen.findByRole("listbox", { name: "受信箱" });
      await user.keyboard("j");

      renders.clear();
      const triageStart = performance.now();
      for (let i = 0; i < 10; i++) await user.keyboard("t");
      const triageMs = performance.now() - triageStart;
      const triageRenders = [...renders.values()].reduce((a, b) => a + b, 0);
      expect(triageRenders).toBeLessThan(100);
      expect(triageMs).toBeLessThan(15000);

      expect(store.lists.today).toHaveLength(100);
    } finally {
      off();
    }
  }, 30000);
});
