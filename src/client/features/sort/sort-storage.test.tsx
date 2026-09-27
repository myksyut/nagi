import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import type { AppStore } from "@/data";
import { FakeServer } from "@/test/fake-server";
import { makeTask } from "@/test/fixtures";
import { setupApp } from "@/test/render-app";

/**
 * 16-修正1 の R3：並び方を変えて覚えるとき、localStorage（nagi:task-sorts）の最新を読み、変えた画面の分だけを書く。
 * ほかのタブがほかの画面の並び方を変えていても上書きせず、読んだ最新はこのタブの表示にも合わせる
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

it("ほかのタブが変えたほかの画面の並び方を上書きせず、このタブの表示にも合わせる", async () => {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "工数5", bucket: "later", rank: "a0", points: 5 }));
  server.putTask(makeTask({ title: "工数1", bucket: "later", rank: "a1", points: 1 }));
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => store.sync());
  await screen.findByRole("listbox", { name: "今日" });
  const user = userEvent.setup();

  // このタブが開いたあとで、ほかのタブが「あとで」を工数が少ない順にした
  localStorage.setItem("nagi:task-sorts", JSON.stringify({ later: "points-asc" }));

  // このタブで今日を優先度にする：あとでの分は消さない
  await user.click(screen.getByRole("button", { name: "並び：手動" }));
  await screen.findByRole("combobox", { name: "並び方" });
  await user.keyboard("2");
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      later: "points-asc",
      today: "priority",
    }),
  );

  // 読んだ最新は、このタブの表示にも合わせる（あとでを開くと工数が少ない順）
  await user.keyboard("4");
  const later = await screen.findByRole("listbox", { name: "あとで" });
  expect(screen.getByRole("button", { name: "並び：工数が少ない順" })).toBeInTheDocument();
  const titles = within(later)
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
  expect(titles).toHaveLength(2);
  expect(titles[0]).toContain("工数1");
  expect(titles[1]).toContain("工数5");

  // 手動に戻すと、その画面の分だけを消す
  await user.click(screen.getByRole("button", { name: "並び：工数が少ない順" }));
  await screen.findByRole("combobox", { name: "並び方" });
  await user.keyboard("1");
  await waitFor(() =>
    expect(JSON.parse(localStorage.getItem("nagi:task-sorts") ?? "{}")).toEqual({
      today: "priority",
    }),
  );
});
