import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット21：選んでいるタスクのタイトルとメモを、⇧⌘C でクリップボードに入れる。
 * 形の細かいところ（空白・空の行）は features/copy/task-text.test.ts で見る。ここでは画面を通した流れを見る
 * （クリップボードは user-event の setup が navigator.clipboard に置く偽物）。トーストの文字は、読み上げのための
 * 知らせにも同じ文字が出ることがあるので、findAllByText で見る
 */

const stores: AppStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.dispose();
});

async function open(path: string, server = new FakeServer()) {
  const setup = await setupApp(path, server);
  stores.push(setup.store);
  await act(async () => {
    await setup.store.sync();
  });
  return setup;
}

const COPY = "{Meta>}{Shift>}c{/Shift}{/Meta}";

function todayServer() {
  const server = new FakeServer();
  server.putTask(
    makeTask({
      title: "見積もりを確認",
      memo: "先方の金額は 10/3 まで",
      bucket: "today",
      rank: "a0",
    }),
  );
  server.putTask(makeTask({ title: "資料を送る", memo: "", bucket: "today", rank: "a1" }));
  return server;
}

describe("⇧⌘C でコピー", () => {
  it("選んだタスクのタイトルとメモが入り、トーストで知らせる", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe("見積もりを確認\n\n先方の金額は 10/3 まで"),
    );
    expect((await screen.findAllByText("タイトルとメモをコピーしました")).length).toBeGreaterThan(
      0,
    );
  });

  it("メモが空なら、タイトルだけが入り、「タイトルをコピーしました」", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^資料を送る/ }));
    await user.keyboard(COPY);
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("資料を送る"));
    expect((await screen.findAllByText("タイトルをコピーしました")).length).toBeGreaterThan(0);
  });

  it("何件か選んでいれば、上から見えている順に --- をはさんで入る", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard("{Shift>}{ArrowDown}{/Shift}");
    await user.keyboard(COPY);
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe(
        "見積もりを確認\n\n先方の金額は 10/3 まで\n\n---\n\n資料を送る",
      ),
    );
    expect(
      (await screen.findAllByText("2件のタイトルとメモをコピーしました")).length,
    ).toBeGreaterThan(0);
  });

  it("入力欄の中では効かない（クリップボードは変わらない）", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await navigator.clipboard.writeText("前のもの");
    await user.keyboard("n");
    await user.type(screen.getByRole("textbox", { name: "今日に追加" }), "新しい");
    await user.keyboard(COPY);
    expect(await navigator.clipboard.readText()).toBe("前のもの");
    expect(screen.queryAllByText(/コピーしました/)).toHaveLength(0);
  });

  it("入れられなかったら「コピーできませんでした」", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(await screen.findByRole("option", { name: /^見積もりを確認/ }));
    await user.keyboard(COPY);
    expect((await screen.findAllByText("コピーできませんでした")).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/コピーしました/)).toHaveLength(0);
  });

  it("⌘K の「タイトルとメモをコピー」からも入る", async () => {
    const user = userEvent.setup();
    await open("/today", todayServer());
    await user.click(await screen.findByRole("option", { name: /^資料を送る/ }));
    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
    await user.type(input, "タイトルとメモをコピー{Enter}");
    await waitFor(async () => expect(await navigator.clipboard.readText()).toBe("資料を送る"));
  });
});
