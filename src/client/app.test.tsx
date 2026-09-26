import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";
import { BUCKET_LISTS, LOGBOOK } from "./navigation";

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <App />
    </Router>,
  );
  return location;
}

describe("各リストの URL", () => {
  it.each([...BUCKET_LISTS, LOGBOOK])(
    "$path は見出しと document.title に「$label」が出る",
    async ({ path, label }) => {
      renderAt(path);
      expect(await screen.findByRole("heading", { level: 1, name: label })).toBeInTheDocument();
      expect(document.title).toBe(`${label} — nagi`);
    },
  );

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

    for (const list of [...BUCKET_LISTS, LOGBOOK]) {
      const link = screen.getByRole("link", { name: list.label });
      expect(link).toHaveAttribute("href", list.path);
      if (list.key === "today") {
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
