import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";

/**
 * 7 のそのほかの振る舞い：既存の StrictMode でも ⌘K のフォーカスが崩れないこと。
 * StrictMode は開閉時の副作用を1回多く走らせるので、⌘K のフォーカスの受け渡し（overlays・finalFocus）が
 * その付け直しに巻き込まれないことを確かめる
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

it("StrictMode でも ⌘K のフォーカスが崩れない", async () => {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "A", bucket: "inbox" }));
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  const location = memoryLocation({ path: "/inbox", record: true });
  await store.start();
  render(
    <StrictMode>
      <StoreProvider store={store}>
        <Router hook={location.hook} searchHook={location.searchHook}>
          <App />
        </Router>
      </StoreProvider>
    </StrictMode>,
  );
  await act(async () => store.sync());
  await screen.findByRole("listbox", { name: "受信箱" });
  const user = userEvent.setup();

  await user.keyboard("j{Meta>}k{/Meta}");
  const input = await screen.findByRole("combobox", { name: "検索とコマンド" });
  await waitFor(() => expect(input).toHaveFocus());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(input).toHaveFocus();

  await user.type(input, "日付を決めて");
  await user.keyboard("{Enter}");
  const date = await screen.findByRole("textbox", { name: "予定の日付" });
  await waitFor(() => expect(date).toHaveFocus());
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(date).toHaveFocus();

  await user.keyboard("{Escape}");
  await user.keyboard("{Meta>}k{/Meta}");
  const input2 = await screen.findByRole("combobox", { name: "検索とコマンド" });
  await waitFor(() => expect(input2).toHaveFocus());
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.getByRole("listbox", { name: "受信箱" })).toHaveFocus());
});
