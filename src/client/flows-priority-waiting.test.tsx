import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 16-修正1 の R1：⇧P の候補が届く前（先読みの前・遅い回線・読み込み直し）に待ちの欄で押した 1・2・3・0 は、
 * 届いたら、候補の中で押したときと同じようにその場で決まる（最初の1回分だけ）。変換中・修飾キー付き・待ちのあいだに
 * Esc で閉じた候補には渡さない。候補のモジュールの読み込みを止めておける門（gate）を挟み、先読みはしない
 */

const gate = vi.hoisted(() => {
  (globalThis as { NAGI_NO_PRELOAD?: boolean }).NAGI_NO_PRELOAD = true;
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open: () => open() };
});

vi.mock("./features/priority-points/parts", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  // 起動のあとの空いた時間の先読みを止める（候補の読み込みを、門を開けるまで待たせるため）
  vi.stubGlobal("requestIdleCallback", () => 0);
  vi.stubGlobal("cancelIdleCallback", () => {});
});

it("待ちの欄で押した最初の数字だけが、届くとその場で決まる。Esc で閉じた候補・変換中・修飾キー付きは渡さない", async () => {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "付ける先", bucket: "today" }));
  const { store } = await setupApp("/today", server, { preload: false });
  stores.push(store);
  await act(async () => store.sync());
  const list = await screen.findByRole("listbox", { name: "今日" });
  const user = userEvent.setup();

  // 待ちのあいだに 1 を押してから Esc で閉じる：届いても何も変わらない
  await user.keyboard("j{Shift>}P{/Shift}");
  const first = await screen.findByRole("textbox", { name: "優先度" });
  expect(first).toHaveFocus();
  await user.keyboard("1");
  expect(first).toHaveValue("1");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("textbox", { name: "優先度" })).toBeNull());
  expect(list).toHaveFocus();

  // 開き直す：変換中と修飾キー付きの数字は持たず、最初の有効な数字（全角の ２）だけを持つ。あとの 3 と Enter では決めない
  await user.keyboard("{Shift>}P{/Shift}");
  const waiting = await screen.findByRole("textbox", { name: "優先度" });
  expect(waiting).toHaveValue("");
  fireEvent.keyDown(waiting, { key: "1", isComposing: true });
  fireEvent.keyDown(waiting, { key: "1", keyCode: 229 });
  fireEvent.keyDown(waiting, { key: "1", altKey: true });
  expect(waiting).toHaveValue("");
  fireEvent.keyDown(waiting, { key: "２" });
  expect(waiting).toHaveValue("2");
  await user.keyboard("3{Enter}");
  expect(waiting).toHaveValue("2");
  expect(store.lists.today[0]?.priority).toBeNull();
  const mutatesBefore = server.requestsTo("/api/mutate").length;

  // 届く：押した 2（中）で決まり、候補は閉じて一覧へ戻る（1回だけ送る）
  await act(async () => {
    gate.open();
  });
  await waitFor(() => expect(store.lists.today[0]?.priority).toBe("medium"));
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "優先度" })).toBeNull());
  expect(screen.queryByRole("textbox", { name: "優先度" })).toBeNull();
  expect(list).toHaveFocus();
  await act(async () => {
    await store.idle();
  });
  expect(server.requestsTo("/api/mutate").length).toBe(mutatesBefore + 1);

  // 届いたあとの ⇧P はふだんどおり（開いたまま待ち、押したキーで決まる）
  await user.keyboard("{Shift>}P{/Shift}");
  await screen.findByRole("combobox", { name: "優先度" });
  await user.keyboard("1");
  expect(store.lists.today[0]?.priority).toBe("high");
});
