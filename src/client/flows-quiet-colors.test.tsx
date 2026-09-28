import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeProject, makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * 見た目の直し「色は意味のあるところにだけ使う」（サイドバーの色の案1）：
 * - サイドバーのアイコンにはリストごとの色を付けない。ふだんは控えめな灰（--nav-icon）、
 *   今いる場所（選んでいるリスト・ビュー・ショートカットのページ）だけ選択の紫（--nav-icon-current）。
 *   プロジェクトの行は色の点のまま
 * - 見出しの台（list-tile）は --tile を渡さず、選択の紫になる。プロジェクトの画面の見出しだけ、
 *   --tile にそのプロジェクトの色
 * - 目を向けてほしい印（今日来たタスク）は --attention
 * トークンの値（コントラスト・8 色の見分け・list-tile の既定の色）は styles-quiet-colors.test.ts で見る
 */

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
});

const CURRENT = "var(--nav-icon-current)";
const QUIET = "var(--nav-icon)";

/** サイドバーのアイコンのある行（上から）と、その画面の URL。見出しの名前は行の名前と同じ */
const PLACES = [
  { label: "受信箱", path: "/inbox" },
  { label: "今日", path: "/today" },
  { label: "予定", path: "/upcoming" },
  { label: "あとで", path: "/later" },
  { label: "カレンダー", path: "/calendar" },
  { label: "タイムライン", path: "/timeline" },
  { label: "完了ログ", path: "/logbook" },
  { label: "ショートカット", path: "/shortcuts" },
] as const;

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "リスト" });
}

function navLink(label: string): HTMLElement {
  return within(sidebar()).getByRole("link", { name: new RegExp(`^${label}`) });
}

/** サイドバーのアイコンのある行ごとの、アイコンの色（行の名前 → 色） */
function navIconColors(): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const link of within(sidebar()).getAllByRole("link")) {
    const icon = link.querySelector("svg");
    if (!icon) continue;
    const label = link.querySelector(".truncate")?.textContent ?? "";
    colors[label] = icon.style.color;
  }
  return colors;
}

/** current の行のアイコンだけ紫、ほかの行はすべて灰（null なら、どの行も灰） */
function expectCurrentIcon(current: string | null) {
  expect(navIconColors()).toEqual(
    Object.fromEntries(
      PLACES.map(({ label }) => [label, label === current ? CURRENT : QUIET] as const),
    ),
  );
}

/** 見出し（h1）と同じ並びにある、アイコンの台 */
function tileOf(heading: HTMLElement): HTMLElement {
  const tile = heading.closest(".flex")?.querySelector<HTMLElement>(".list-tile");
  if (!tile) throw new Error("見出しの台（list-tile）が見つかりません");
  return tile;
}

function dotOf(element: Element): HTMLElement {
  const dot = element.querySelector<HTMLElement>("[data-project-color]");
  if (!dot) throw new Error("色の点が見つかりません");
  return dot;
}

describe("サイドバーのアイコンの色（色は今いる場所にだけ）", () => {
  it.each(PLACES)(
    "$label を開くと、$label のアイコンだけ選択の紫（--nav-icon-current）、ほかはすべて控えめな灰（--nav-icon）",
    async ({ label, path }) => {
      const { store } = await setupApp(path);
      stores.push(store);
      await screen.findByRole("heading", { name: label, level: 1 });

      expectCurrentIcon(label);
      expect(navLink(label)).toHaveAttribute("aria-current", "page");
    },
  );

  it("サイドバーの行を押して画面を移ると、紫のアイコンも移る。プロジェクトの画面では、どのアイコンも灰", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "P" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "今日", level: 1 });
    expectCurrentIcon("今日");
    const user = userEvent.setup();

    for (const label of [
      "受信箱",
      "予定",
      "カレンダー",
      "あとで",
      "タイムライン",
      "完了ログ",
      "ショートカット",
      "今日",
    ]) {
      await user.click(navLink(label));
      await screen.findByRole("heading", { name: label, level: 1 });
      expectCurrentIcon(label);
    }

    await user.click(navLink("P"));
    await screen.findByRole("heading", { name: "P", level: 1 });
    expect(navLink("P")).toHaveAttribute("aria-current", "page");
    expectCurrentIcon(null);

    await user.click(navLink("受信箱"));
    await screen.findByRole("heading", { name: "受信箱", level: 1 });
    expectCurrentIcon("受信箱");
  });

  it("プロジェクトの行はアイコンではなく色の点のまま。開いている行の点もプロジェクトの色（紫にならない）", async () => {
    const server = new FakeServer();
    server.putProject(makeProject({ name: "作成順の色" }));
    const chosen = server.putProject(makeProject({ name: "選んだ色", color: "teal" }));
    const { store } = await setupApp(`/projects/${chosen.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("heading", { name: "選んだ色", level: 1 });

    const auto = navLink("作成順の色");
    const open = navLink("選んだ色");
    expect(open).toHaveAttribute("aria-current", "page");
    for (const link of [auto, open]) expect(link.querySelector("svg")).toBeNull();
    expect(dotOf(auto)).toHaveAttribute("data-project-color", "violet");
    expect(dotOf(auto).style.getPropertyValue("--dot")).toBe("var(--project-violet)");
    expect(dotOf(open)).toHaveAttribute("data-project-color", "teal");
    expect(dotOf(open).style.getPropertyValue("--dot")).toBe("var(--project-teal)");
  });
});

describe("見出しの台（list-tile）", () => {
  it.each(PLACES)(
    "$label の見出しの台には --tile を渡さない（既定の選択の紫になる）",
    async ({ label, path }) => {
      const { store } = await setupApp(path);
      stores.push(store);
      const heading = await screen.findByRole("heading", { name: label, level: 1 });

      const tile = tileOf(heading);
      expect(tile.style.getPropertyValue("--tile")).toBe("");
      expect(tile.getAttribute("style") ?? "").not.toContain("--tile");
      // 見出しの台は画面に1つだけ（ほかの場所で --tile を渡していない）
      expect(document.querySelectorAll(".list-tile")).toHaveLength(1);
    },
  );

  it("プロジェクトの画面の見出しの台は、--tile にそのプロジェクトの色。色を選び直すと変わり、⌘Z で戻る", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P" }));
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const heading = await screen.findByRole("heading", { name: "P", level: 1 });
    const user = userEvent.setup();

    const tile = tileOf(heading);
    expect(tile).toBe(screen.getByRole("button", { name: "プロジェクトの色：紫" }));
    expect(tile.style.getPropertyValue("--tile")).toBe("var(--project-violet)");

    await user.click(tile);
    const palette = await screen.findByRole("radiogroup", { name: "プロジェクトの色" });
    await user.click(within(palette).getByRole("radio", { name: "緑" }));
    await waitFor(() => expect(screen.queryByRole("radiogroup")).toBeNull());
    expect(
      screen.getByRole("button", { name: "プロジェクトの色：緑" }).style.getPropertyValue("--tile"),
    ).toBe("var(--project-emerald)");

    await user.keyboard("{Meta>}z{/Meta}");
    expect(
      (await screen.findByRole("button", { name: "プロジェクトの色：紫" })).style.getPropertyValue(
        "--tile",
      ),
    ).toBe("var(--project-violet)");
  });

  it("色を選んであるプロジェクトの見出しの台は、その色（作成順の色ではない）", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P", color: "amber" }));
    const { store } = await setupApp(`/projects/${project.id}`, server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    const heading = await screen.findByRole("heading", { name: "P", level: 1 });
    expect(tileOf(heading).style.getPropertyValue("--tile")).toBe("var(--project-amber)");
  });
});

describe("目を向けてほしい印（--attention）", () => {
  it("今日来たタスクの印は、枠と文字が --attention の琥珀", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-28T10:00:00+09:00"));
    const server = new FakeServer();
    server.putTask(makeTask({ title: "来た", bucket: "today", arrivedOn: "2026-09-28" }));
    const { store } = await setupApp("/today", server);
    stores.push(store);
    await act(async () => {
      await store.sync();
    });
    await screen.findByRole("listbox", { name: "今日" });

    const mark = screen.getByRole("img", { name: "今日来たタスク" });
    const classes = mark.className.split(/\s+/);
    expect(classes).toContain("text-(--attention)");
    expect(classes).toContain("border-(--attention)/35");
  });
});
