import type { ChecklistItem } from "@shared/model";
import { describe, expect, it } from "vitest";
import {
  checklistProgress,
  moveItem,
  orderItems,
  removeItem,
  renameItem,
  sameOrder,
  toggleItem,
} from "./checklist";

/** 6：チェックリストの計算（純粋な関数） */

function item(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: "i1", title: "項目", done: false, ...overrides };
}

describe("checklistProgress", () => {
  it("チェック済みの件数と全体の件数", () => {
    const items = [item({ id: "a", done: true }), item({ id: "b" }), item({ id: "c", done: true })];
    expect(checklistProgress(items)).toEqual({ done: 2, total: 3 });
  });
});

describe("toggleItem / renameItem / removeItem", () => {
  it("id で指した項目だけ変わる", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(toggleItem(items, "a").map((i) => [i.id, i.done])).toEqual([
      ["a", true],
      ["b", false],
    ]);
    expect(renameItem(items, "b", "新しい名前").map((i) => [i.id, i.title])).toEqual([
      ["a", "項目"],
      ["b", "新しい名前"],
    ]);
    expect(removeItem(items, "a").map((i) => i.id)).toEqual(["b"]);
  });
});

describe("moveItem", () => {
  it("上下に1つ動かす", () => {
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    expect(moveItem(items, "a", 1).map((i) => i.id)).toEqual(["b", "a", "c"]);
    expect(moveItem(items, "c", -1).map((i) => i.id)).toEqual(["a", "c", "b"]);
  });

  it("端なら動かさない", () => {
    const items = [item({ id: "a" }), item({ id: "b" })];
    expect(moveItem(items, "a", -1).map((i) => i.id)).toEqual(["a", "b"]);
    expect(moveItem(items, "b", 1).map((i) => i.id)).toEqual(["a", "b"]);
  });
});

describe("orderItems / sameOrder", () => {
  it("ids の順に並べ、ids にない項目は元の順のまま後ろに付ける", () => {
    const items = [item({ id: "a" }), item({ id: "b" }), item({ id: "c" })];
    const ordered = orderItems(items, ["c", "a"]);
    expect(ordered.map((i) => i.id)).toEqual(["c", "a", "b"]);
  });

  it("sameOrder は id の並びだけを比べる", () => {
    const a = [item({ id: "a" }), item({ id: "b" })];
    const b = [item({ id: "a", title: "違う名前" }), item({ id: "b" })];
    const c = [item({ id: "b" }), item({ id: "a" })];
    expect(sameOrder(a, b)).toBe(true);
    expect(sameOrder(a, c)).toBe(false);
  });
});
