import { PROJECT_COLORS } from "@shared/palette";
import { describe, expect, it } from "vitest";
import stylesCss from "./styles.css?raw";

/**
 * 見た目の直し「色は意味のあるところにだけ使う」のトークン（styles.css の .dark）：
 * - サイドバーのアイコンの灰（--nav-icon）と今いる場所の紫（--nav-icon-current）、目を向けてほしい印の琥珀（--attention）。
 *   リストごとの色のトークンはなくした
 * - 見出しの台（list-tile）は、--tile を渡さなければ選択の紫
 * - プロジェクトの 8 色（--project-*）は彩度を落として明るさをそろえた。カレンダーの締切の文字にも使うので、
 *   暗い下地の上で文字として読める強さ（4.5:1 以上）を保ち、8 色どうしも見分けられる距離を保つ
 * 画面での使われ方は flows-quiet-colors.test.tsx で見る
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

// 色は :root（ライト）にも同名で出てくるので、ダークの .dark の中だけを見る
const dark = block(stylesCss, ".dark");
const token = (name: string) => declaration(dark, name);

// ---- 色の計算（sRGB・WCAG 2 のコントラスト比・OKLab） ----

type Rgb = readonly [number, number, number];
type Rgba = { rgb: Rgb; alpha: number };

/** #rrggbb か rgb(r g b / a%) を読む（styles.css のトークンの書き方） */
function parseColor(value: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex?.[1]) {
    const n = Number.parseInt(hex[1], 16);
    return { rgb: [(n >> 16) & 255, (n >> 8) & 255, n & 255], alpha: 1 };
  }
  const rgb = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)%)?\s*\)$/.exec(value);
  if (rgb) {
    const [r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number) as [number, number, number];
    return { rgb: [r, g, b], alpha: rgb[4] === undefined ? 1 : Number(rgb[4]) / 100 };
  }
  throw new Error(`色として読めません：${value}`);
}

/** 不透明の色（#rrggbb） */
function solid(value: string): Rgb {
  const { rgb, alpha } = parseColor(value);
  if (alpha !== 1) throw new Error(`不透明の色ではありません：${value}`);
  return rgb;
}

/** 半透明の色を下地に重ねた色 */
function over(layer: string, base: Rgb): Rgb {
  const { rgb, alpha } = parseColor(layer);
  return rgb.map((c, i) => c * alpha + (base[i] ?? 0) * (1 - alpha)) as unknown as Rgb;
}

/** 値の中の最初の rgb(…)（グラデーションの一番濃いところ） */
function firstRgb(value: string): string {
  const match = /rgb\([^)]*\)/.exec(value);
  if (!match) throw new Error(`rgb() が見つかりません：${value}`);
  return match[0];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [light, darkL] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (darkL + 0.05);
}

/** OKLab（Björn Ottosson）。[L, a, b] */
function oklab([r, g, b]: Rgb): [number, number, number] {
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabDistance(a: Rgb, b: Rgb): number {
  const [p, q] = [oklab(a), oklab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// ---- 下地（トークンから組み立てる） ----

const ground = solid(token("--background"));
const surface = solid(token("--surface"));
const sidebar = over(token("--sidebar"), ground);
/** サイドバーのホバーの行（hover:bg-sidebar-accent） */
const sidebarHover = over(token("--sidebar-accent"), sidebar);
/** サイドバーの選んでいる行（--sidebar-active の一番濃い、左の端） */
const sidebarActive = over(firstRgb(token("--sidebar-active")), sidebar);
/**
 * カレンダーの締切の文字の、一番明るくなる下地の見積もり：地に、上からの紫の光（--glow）を一番濃いまま重ね、
 * 今日のマス（--selection）と、締切のホバー（--accent）を重ねたもの。
 * 光の中心は画面の上の外にあるので、実際の画面ではここまで明るくならない（厳しめの見積もり）
 */
const calendarBrightest = over(
  token("--accent"),
  over(token("--selection"), over(firstRgb(token("--glow")), ground)),
);

const TEXT_CONTRAST = 4.5;
/** 文字でない図形（アイコン）の基準（WCAG 1.4.11） */
const GRAPHIC_CONTRAST = 3;
/**
 * 8 色どうしの OKLab の距離の下限。OKLab でおよそ見分けが付く差（0.02）の 2 倍。
 * 今の 8 色で一番近い組は黄（amber）と橙（orange）で、およそ 0.050
 */
const MIN_PROJECT_COLOR_DISTANCE = 0.04;

const projectColors = PROJECT_COLORS.map((name) => ({
  name,
  rgb: solid(token(`--project-${name}`)),
}));

describe("サイドバーのアイコンと、目を向けてほしい印のトークン", () => {
  it("--nav-icon（灰）・--nav-icon-current（紫）・--attention（琥珀）があり、灰と紫は別の色", () => {
    const quiet = solid(token("--nav-icon"));
    const current = solid(token("--nav-icon-current"));
    solid(token("--attention"));
    expect(oklabDistance(quiet, current)).toBeGreaterThan(0.1);
    // 今いる場所の紫は、灰より明るく目に入る
    expect(luminance(current)).toBeGreaterThan(luminance(quiet));
  });

  it("サイドバーのアイコンは、灰はふだんの行とホバーの行、紫は選んでいる行の上で 3:1 以上（文字でない図形の基準）", () => {
    const quiet = solid(token("--nav-icon"));
    const current = solid(token("--nav-icon-current"));
    expect(contrast(quiet, sidebar)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
    expect(contrast(quiet, sidebarHover)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
    expect(contrast(current, sidebarActive)).toBeGreaterThanOrEqual(GRAPHIC_CONTRAST);
  });

  it("--attention の琥珀は、地と面の上で 4.5:1 以上（「今日来た」の文字に使う）", () => {
    const attention = solid(token("--attention"));
    for (const base of [ground, surface]) {
      expect(contrast(attention, base)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    }
  });

  it("リストごとの色のトークンは、CSS にもコードにも残っていない", () => {
    const sources = import.meta.glob<string>(
      ["/src/**/*.{ts,tsx,css}", "/index.html", "/README.md"],
      { query: "?raw", import: "default", eager: true },
    );
    const files = Object.keys(sources);
    // 見ているファイルが少なすぎないこと（glob が何も拾わず素通りしないように）
    expect(files).toContain("/src/client/styles.css");
    expect(files).toContain("/src/client/shell/list-icons.ts");
    expect(files.length).toBeGreaterThan(100);
    const needle = ["--", "list-"].join("");
    const found = files.filter((path) => sources[path]?.includes(needle));
    expect(found).toEqual([]);
  });
});

describe("見出しの台（list-tile）", () => {
  it("--tile を渡さなければ、文字・敷く色・光のどれも選択の紫（--nav-icon-current）になる", () => {
    const body = block(stylesCss, "@utility list-tile");
    for (const property of ["color", "background-color", "box-shadow"]) {
      expect(declaration(body, property)).toContain("var(--tile, var(--nav-icon-current))");
    }
    // 既定の色のない var(--tile) を残していない
    const uses = body.match(/var\(--tile\b/g) ?? [];
    const withFallback = body.match(/var\(--tile, var\(--nav-icon-current\)\)/g) ?? [];
    expect(uses).toHaveLength(3);
    expect(withFallback).toHaveLength(uses.length);
  });
});

describe("プロジェクトの 8 色（--project-*）", () => {
  it("palette.ts の PROJECT_COLORS と同じ名前と順で、すべて不透明の色がある", () => {
    const declared = [...dark.matchAll(/--project-([a-z]+)\s*:/g)].map((m) => m[1]);
    expect(declared).toEqual([...PROJECT_COLORS]);
    for (const { name } of projectColors) {
      expect(token(`--project-${name}`)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(PROJECT_COLORS)(
    "%s は、地・面（--surface）・サイドバーの上で 4.5:1 以上（カレンダーの締切の文字に使う）",
    (name) => {
      const rgb = solid(token(`--project-${name}`));
      for (const base of [ground, surface, sidebar]) {
        expect(contrast(rgb, base)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
      }
    },
  );

  it("カレンダーの一番明るくなる下地（上からの光・今日のマス・ホバーを重ねた厳しめの見積もり）でも、どの色も 4.5:1 以上", () => {
    for (const { rgb } of projectColors) {
      expect(contrast(rgb, calendarBrightest)).toBeGreaterThanOrEqual(TEXT_CONTRAST);
    }
  });

  it("暗い地の上では 8:1 以上（styles.css のコメントのとおり）", () => {
    for (const { rgb } of projectColors) {
      expect(contrast(rgb, ground)).toBeGreaterThanOrEqual(8);
    }
  });

  it("明るさをそろえ、彩度を落としてある（OKLCH の L は 0.76±0.01、C は 0.085±0.01。slate だけ 0.03 未満）", () => {
    for (const { name, rgb } of projectColors) {
      const [L, a, b] = oklab(rgb);
      const C = Math.hypot(a, b);
      expect(Math.abs(L - 0.76)).toBeLessThanOrEqual(0.01);
      if (name === "slate") expect(C).toBeLessThan(0.03);
      else expect(Math.abs(C - 0.085)).toBeLessThanOrEqual(0.01);
    }
  });

  it(`8 色どうしが見分けられる（どの2色も OKLab の距離が ${MIN_PROJECT_COLOR_DISTANCE} 以上）`, () => {
    const close: string[] = [];
    projectColors.forEach((a, i) => {
      for (const b of projectColors.slice(i + 1)) {
        const distance = oklabDistance(a.rgb, b.rgb);
        if (distance < MIN_PROJECT_COLOR_DISTANCE)
          close.push(`${a.name}–${b.name}: ${distance.toFixed(4)}`);
      }
    });
    expect(close).toEqual([]);
  });
});
