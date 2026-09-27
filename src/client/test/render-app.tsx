import { render, screen, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../app";
import { AppStore, StoreProvider } from "../data";
import { createMemoryLocalDb } from "../data/local-db";
import { preloadDeferred } from "../lib/deferred";
import { FakeServer } from "./fake-server";

/**
 * 画面をまるごと描くテスト用の土台。チケット4のキーの流れのテストはこれに乗せる
 * （個々の画面や部品を分けて描くと、キーマップや ListUi の配線が実際と変わってしまうため）。
 * 後から読み込む部品（⌘K・完了ログ・カレンダー・p の候補など）は、本番では起動のあとの空いた時間に先読みするので、
 * ここでも描く前に読み込んでおく（読み込みの前に使ったときの振る舞いは、それを確かめるテストで別に見る）
 */
export async function setupApp(path: string, server = new FakeServer(), { preload = true } = {}) {
  if (preload) await preloadDeferred();
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  const location = memoryLocation({ path, record: true });
  await store.start();
  render(
    <StoreProvider store={store}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <App />
      </Router>
    </StoreProvider>,
  );
  return { store, server, location };
}

/** 一覧（listbox）の中の行のタイトルを、上から出ている順で */
export function optionTitles(name: string): (string | null)[] {
  return within(screen.getByRole("listbox", { name }))
    .queryAllByRole("option")
    .map((option) => option.textContent);
}

/**
 * p（プロジェクト）の候補の listbox（coss ui の Combobox）。行の一覧も role=listbox なので、
 * 名前（aria-label）が付いていないほうを候補として探す
 */
export function pickerListbox(): HTMLElement {
  const listbox = screen
    .getAllByRole("listbox")
    .find((element) => element.getAttribute("aria-label") === null);
  if (!listbox) throw new Error("p の候補（listbox）が見つかりません");
  return listbox;
}
