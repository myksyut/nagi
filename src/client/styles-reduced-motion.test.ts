import { describe, expect, it } from "vitest";
import stylesCss from "./styles.css?raw";

/**
 * チケット8：prefers-reduced-motion のときに CSS の動きを止める規則が、`@layer base` の中にあり
 * （あとの層の指定より強くするため）、transition-property を色関係だけに絞り、animation を止めることを確かめる。
 * `@layer base` の外に出たり、!important が抜けたりすると、部品ごとの動きの指定に負けて止まらなくなる
 */

function block(source: string, marker: string): string {
  const index = source.indexOf(marker);
  if (index < 0) throw new Error(`${marker} が見つかりません`);
  const start = source.indexOf("{", index);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start + 1, i);
    }
  }
  throw new Error(`${marker} の閉じ括弧が見つかりません`);
}

describe("styles.css の prefers-reduced-motion", () => {
  const mediaBlock = block(stylesCss, "@media (prefers-reduced-motion: reduce)");

  it("@layer base の中にある（utilities の層より優先して止めるため）", () => {
    // @media の直前に @layer base { が続けて出てくる（入れ子の外に出ていない）
    const mediaIndex = stylesCss.indexOf("@media (prefers-reduced-motion: reduce)");
    const before = stylesCss.slice(0, mediaIndex);
    const layerBaseIndex = before.lastIndexOf("@layer base {");
    expect(layerBaseIndex).toBeGreaterThanOrEqual(0);
    // @layer base { のあとに、閉じ括弧をまたがず @media が来る
    expect(before.slice(layerBaseIndex + "@layer base {".length)).not.toContain("}");
  });

  it("transition-property を色関係だけに絞り、!important を付ける", () => {
    expect(mediaBlock).toMatch(
      /transition-property:\s*color, background-color, border-color, outline-color, text-decoration-color, fill, stroke !important;/,
    );
  });

  it("animation を none にし、!important を付ける", () => {
    expect(mediaBlock).toMatch(/animation:\s*none !important;/);
  });

  it("transform や opacity は !important で止めない（色の変化だけ残す）", () => {
    expect(mediaBlock).not.toMatch(/\btransform\b/);
    expect(mediaBlock).not.toMatch(/\bopacity\b/);
  });
});
