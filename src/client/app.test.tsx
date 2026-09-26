import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";
import { AppStore, StoreProvider } from "./data";
import { createMemoryLocalDb } from "./data/local-db";

/**
 * チケット 1 で決めたリストの URL と表示名（サイドバーの上からの順）。
 * 実装の定数（navigation.ts）から作らず、ここに書いておく。実装から消えたり変わったりしたら気づけるように
 */
const LISTS = [
  { path: "/inbox", label: "受信箱" },
  { path: "/today", label: "今日" },
  { path: "/upcoming", label: "予定" },
  { path: "/later", label: "あとで" },
  { path: "/logbook", label: "完了ログ" },
] as const;

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  // 動かさない（start() を呼ばない）ストア。ルーティングの確認には通信も手元の控えも要らない
  const store = new AppStore({ openLocalDb: async () => createMemoryLocalDb() });
  render(
    <StoreProvider store={store}>
      <Router hook={location.hook} searchHook={location.searchHook}>
        <App />
      </Router>
    </StoreProvider>,
  );
  return location;
}

describe("各リストの URL", () => {
  it.each(LISTS)("$path は見出しと document.title に「$label」が出る", async ({ path, label }) => {
    renderAt(path);
    expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
    expect(document.title).toBe(`${label} — nagi`);
  });

  it("/projects/:id は「プロジェクト」の見出しが出る", async () => {
    renderAt("/projects/abc-123");
    expect(
      await screen.findByRole("heading", { level: 1, name: "プロジェクト" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("プロジェクト — nagi");
  });
});

describe("/ と知らない URL", () => {
  it.each(["/", "/no-such-page"])("%s は /today へ移る（replace）", async (path) => {
    const location = renderAt(path);
    expect(await screen.findByRole("heading", { name: "今日" })).toBeInTheDocument();
    expect(location.history.at(-1)).toBe("/today");
    // replace なので履歴は増えず1件のまま
    expect(location.history).toHaveLength(1);
  });
});

describe("サイドバー", () => {
  it("各リストのリンクの href と、今いるリストの aria-current", async () => {
    renderAt("/today");
    await screen.findByRole("heading", { name: "今日" });

    // サイドバーのリンクは、この順でこれだけ
    const nav = screen.getByRole("navigation", { name: "リスト" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(LISTS.map((list) => list.label));

    for (const list of LISTS) {
      const link = within(nav).getByRole("link", { name: list.label });
      expect(link).toHaveAttribute("href", list.path);
      if (list.path === "/today") {
        expect(link).toHaveAttribute("aria-current", "page");
      } else {
        expect(link).not.toHaveAttribute("aria-current");
      }
    }
  });

  it("クリックで画面が切り替わる", async () => {
    const user = userEvent.setup();
    const location = renderAt("/today");
    await screen.findByRole("heading", { name: "今日" });

    await user.click(screen.getByRole("link", { name: "受信箱" }));

    expect(await screen.findByRole("heading", { name: "受信箱" })).toBeInTheDocument();
    expect(document.title).toBe("受信箱 — nagi");
    expect(screen.getByRole("link", { name: "受信箱" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "今日" })).not.toHaveAttribute("aria-current");
    // 通常のリンク遷移は push なので履歴が増える
    expect(location.history).toHaveLength(2);
  });
});
