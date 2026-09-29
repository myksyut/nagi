import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import stylesCss from "./styles.css?raw";

/**
 * index.html の外枠の最小限の CSS は、JavaScript が届く前から暗い背景とサイドバーの形で描くための
 * 決め打ちの値。styles.css のトークンとずれると、起動の瞬間だけ違う色・幅になってしまう
 */
function block(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (match?.[1] === undefined) throw new Error(`${selector} のブロックが見つかりません`);
  return match[1];
}

function declaration(body: string, property: string): string {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = body.match(new RegExp(`(?:^|[;\\s])${escaped}\\s*:\\s*([^;]+);`));
  if (match?.[1] === undefined) throw new Error(`${property} が見つかりません`);
  return match[1].trim();
}

const htmlStyle = indexHtml.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const shellRoot = block(htmlStyle, ":root");
const shellSidebar = block(htmlStyle, "#root:empty::before");
// 色は :root（ライト）にも同名で出てくるので、ダークの .dark の中だけを見る
const darkTokens = block(stylesCss, ".dark");

describe("外枠の値の一致", () => {
  it("背景色（--background）", () => {
    expect(declaration(shellRoot, "background")).toBe(declaration(darkTokens, "--background"));
  });

  it("文字色（--foreground）", () => {
    expect(declaration(shellRoot, "color")).toBe(declaration(darkTokens, "--foreground"));
  });

  it("サイドバーの背景色（--sidebar）", () => {
    expect(declaration(shellSidebar, "background")).toBe(declaration(darkTokens, "--sidebar"));
  });

  it("サイドバーの幅（--sidebar-width）", () => {
    expect(declaration(shellSidebar, "width")).toBe(declaration(stylesCss, "--sidebar-width"));
  });

  it("畳んだサイドバー（帯）の幅（--sidebar-rail-width）", () => {
    const shellRail = block(htmlStyle, ':root[data-sidebar="rail"] #root:empty::before');
    expect(declaration(shellRail, "width")).toBe(declaration(stylesCss, "--sidebar-rail-width"));
  });

  it("サイドバーの右の枠線（--sidebar-border）", () => {
    expect(declaration(shellSidebar, "border-right")).toBe(
      `1px solid ${declaration(darkTokens, "--sidebar-border")}`,
    );
  });
});
