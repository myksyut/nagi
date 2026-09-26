/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(new URL(import.meta.url).pathname);
const indexHtml = readFileSync(resolve(here, "../../index.html"), "utf-8");
const stylesCss = readFileSync(resolve(here, "./styles.css"), "utf-8");

/**
 * index.html の外枠の最小限の CSS は、JavaScript が届く前から暗い背景とサイドバーの形で描くための
 * 決め打ちの値。styles.css の .dark トークンとずれると、起動の瞬間だけ違う色・幅になってしまう
 */
function extract(source: string, pattern: RegExp): string {
  const match = source.match(pattern);
  if (!match) throw new Error(`パターンに一致しませんでした: ${pattern}`);
  return match[1]?.trim() ?? "";
}

// 値は :root（ライト）にも同名で出てくるので、.dark { ... } の中だけを見る
const darkBlock = extract(stylesCss, /\.dark\s*\{([^}]*)\}/s);

describe("外枠の値の一致", () => {
  it("背景色（--background）", () => {
    const inHtml = extract(indexHtml, /background:\s*(#[0-9a-fA-F]+);/);
    const inCss = extract(darkBlock, /--background:\s*([^;]+);/);
    expect(inHtml).toBe(inCss);
  });

  it("サイドバーの背景色（--sidebar）", () => {
    const inHtml = extract(indexHtml, /background:\s*(#[0-9a-fA-F]+);\s*\n\s*border-right/);
    const inCss = extract(darkBlock, /--sidebar:\s*([^;]+);/);
    expect(inHtml).toBe(inCss);
  });

  it("サイドバーの幅（--sidebar-width）", () => {
    const inHtml = extract(indexHtml, /width:\s*(\d+px);/);
    const inCss = extract(stylesCss, /--sidebar-width:\s*([^;]+);/);
    expect(inHtml).toBe(inCss);
  });

  it("サイドバーの右の枠線（--sidebar-border）", () => {
    const inHtml = extract(indexHtml, /border-right:\s*1px solid\s*([^;]+);/);
    const inCss = extract(darkBlock, /--sidebar-border:\s*([^;]+);/);
    expect(inHtml).toBe(inCss);
  });
});
