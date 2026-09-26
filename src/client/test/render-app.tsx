import { render, screen, within } from "@testing-library/react";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "../app";
import { AppStore, StoreProvider } from "../data";
import { createMemoryLocalDb } from "../data/local-db";
import { FakeServer } from "./fake-server";

/**
 * 画面をまるごと描くテスト用の土台。チケット4のキーの流れのテストはこれに乗せる
 * （個々の画面や部品を分けて描くと、キーマップや ListUi の配線が実際と変わってしまうため）
 */
export async function setupApp(path: string, server = new FakeServer()) {
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
