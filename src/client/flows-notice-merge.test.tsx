import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット8「知らせの重なり」：プロジェクトのアーカイブをサーバーが断ったとき（6-修正1）、
 * 汎用の「ほかの画面で先に変更されていたため、保存できませんでした」と、
 * 操作の側の「「名前」をアーカイブできませんでした」が重ねて出ず、1つだけになることを確かめる
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.useRealTimers();
});

describe("プロジェクトのアーカイブが断られたとき、トーストは1つだけ", () => {
  it("★ 汎用の「保存できませんでした」は出さず、アーカイブできなかったことと残りの件数だけを出す", async () => {
    const user = userEvent.setup();
    const server = new FakeServer();
    const project = makeProject({ name: "AIPR" });
    server.putProject(project);
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { level: 1, name: "AIPR" });

    const release = server.hold("/api/mutate");
    await user.click(screen.getByRole("button", { name: "アーカイブ" }));
    // 送る前に、ほかの画面がこのプロジェクトに未完了のタスクを付けた（衝突を起こす）
    server.putTask(
      makeTask({ title: "ほかの画面で付けた", bucket: "inbox", projectId: project.id }),
    );
    release();
    await act(async () => {
      await store.idle();
    });

    const toasts = await screen.findAllByRole("alertdialog", { hidden: true });
    expect(toasts).toHaveLength(1);
    expect(
      within(toasts[0] as HTMLElement).getByText("「AIPR」をアーカイブできませんでした"),
    ).toBeInTheDocument();
    expect(
      within(toasts[0] as HTMLElement).getByText("未完了のタスクが 1 件残っています"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("ほかの画面で先に変更されていたため、保存できませんでした"),
    ).toBeNull();
  });
});
