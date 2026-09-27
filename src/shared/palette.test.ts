import { describe, expect, it } from "vitest";
import {
  autoProjectColor,
  isProjectColor,
  orderForAutoColor,
  PROJECT_COLORS,
  type ProjectColor,
  resolveProjectColors,
} from "./palette";

function project(overrides: {
  id: string;
  color?: ProjectColor | null;
  createdAt: string;
  deletedAt?: string | null;
}) {
  return { color: null, deletedAt: null, ...overrides };
}

describe("autoProjectColor", () => {
  it("0〜7 はパレットの順そのまま", () => {
    expect(PROJECT_COLORS.map((_, i) => autoProjectColor(i))).toEqual(PROJECT_COLORS);
  });

  it("8 以上は 8 で割った余り、負の数も同じ色に巡る", () => {
    expect(autoProjectColor(8)).toBe(autoProjectColor(0));
    expect(autoProjectColor(9)).toBe(autoProjectColor(1));
    expect(autoProjectColor(-1)).toBe(autoProjectColor(7));
    expect(autoProjectColor(-8)).toBe(autoProjectColor(0));
  });
});

describe("isProjectColor", () => {
  it("パレットの名前だけ true", () => {
    expect(isProjectColor("violet")).toBe(true);
    expect(isProjectColor("red")).toBe(false);
    expect(isProjectColor("")).toBe(false);
    expect(isProjectColor("Violet")).toBe(false);
    expect(isProjectColor(null)).toBe(false);
  });
});

describe("orderForAutoColor / resolveProjectColors", () => {
  it("削除済みを除き、createdAt の順（同じなら id の順）に並べる。アーカイブは数に入る（この型に archivedAt はないので、渡す側で除かない）", () => {
    const a = project({ id: "a", createdAt: "2026-01-02T00:00:00.000Z" });
    const b = project({ id: "b", createdAt: "2026-01-01T00:00:00.000Z" });
    const c = project({ id: "c", createdAt: "2026-01-01T00:00:00.000Z" });
    const ordered = orderForAutoColor([a, b, c]);
    expect(ordered.map((p) => p.id)).toEqual(["b", "c", "a"]);
  });

  it("削除済みは並びにも色の解決にも入らない", () => {
    const alive = project({ id: "alive", createdAt: "2026-01-01T00:00:00.000Z" });
    const deleted = project({
      id: "deleted",
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(orderForAutoColor([deleted, alive]).map((p) => p.id)).toEqual(["alive"]);
    const colors = resolveProjectColors([deleted, alive]);
    expect(colors.has("deleted")).toBe(false);
    expect(colors.get("alive")).toBe(autoProjectColor(0));
  });

  it("color があればその色、なければ作成順の i 番目の自動の色", () => {
    const first = project({ id: "first", createdAt: "2026-01-01T00:00:00.000Z" });
    const second = project({
      id: "second",
      createdAt: "2026-01-02T00:00:00.000Z",
      color: "pink",
    });
    const colors = resolveProjectColors([first, second]);
    expect(colors.get("first")).toBe(autoProjectColor(0));
    expect(colors.get("second")).toBe("pink");
  });
});
