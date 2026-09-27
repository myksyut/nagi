import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット8：保存できなかったタイトルとメモの文字（4-修正1 の ListUi の unsavedText）は localStorage にも残り、
 * 再読み込みしても（ここではストアとアプリを作り直して）、そのタスクを開くと欄に戻る
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

it("オフラインで閉じたタイトルの打ちかけは、作り直したあとにそのタスクを開くと欄に戻る", async () => {
  const user = userEvent.setup();
  const server = new FakeServer();
  const task = server.putTask(makeTask({ title: "元のタイトル", bucket: "today" }));
  const first = await setupApp("/today", server);
  stores.push(first.store);
  await act(async () => first.store.sync());
  await screen.findByRole("listbox", { name: "今日" });

  await user.keyboard("j{Enter}{Enter}");
  const title = screen.getByRole("textbox", { name: "タイトル" });
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
  });
  fireEvent.change(title, { target: { value: "オフラインで直したタイトル" } });
  // Esc で閉じる。オフラインなので保存できず、打った文字が残る
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("textbox", { name: "タイトル" })).toBeNull();
  expect(first.store.task(task.id)?.title).toBe("元のタイトル");
  expect(localStorage.getItem(`nagi:draft:unsaved:${task.id}:title`)).toBe(
    "オフラインで直したタイトル",
  );

  // 再読み込みの代わりに、ストアとアプリを作り直す（localStorage はそのまま）
  first.store.dispose();
  stores.splice(0);
  cleanup();
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  const second = await setupApp("/today", server);
  stores.push(second.store);
  await act(async () => second.store.sync());
  await screen.findByRole("listbox", { name: "今日" });

  await user.keyboard("j{Enter}");
  expect(screen.getByRole("textbox", { name: "タイトル" })).toHaveValue(
    "オフラインで直したタイトル",
  );
});
