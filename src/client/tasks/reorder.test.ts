import { describe, expect, it } from "vitest";
import { planDrop, planStep } from "./reorder";

/**
 * 並べ替えの計算（⌥↑↓・ドラッグ）の単体テスト。7 の完了の条件（並べ替えた順が保たれる）を支える計算
 */

describe("planStep（⌥↑↓）", () => {
  it("1件を1つ下へ：隣の行と入れ替わる（ids は動いた行だけ）", () => {
    const placements = planStep(["A", "B", "C"], new Set(["A"]), 1);
    expect(placements).toEqual([{ ids: ["A"], after: "B", before: "C" }]);
  });

  it("1件を1つ上へ", () => {
    const placements = planStep(["A", "B", "C"], new Set(["C"]), -1);
    expect(placements).toEqual([{ ids: ["C"], after: "A", before: "B" }]);
  });

  it("端にある行は動かせない（下端で ⌥↓、上端で ⌥↑）", () => {
    expect(planStep(["A", "B", "C"], new Set(["C"]), 1)).toBeNull();
    expect(planStep(["A", "B", "C"], new Set(["A"]), -1)).toBeNull();
  });

  it("複数選んで ⌥↓：離れて選んだ行は、それぞれ隣の動かさない行を1つ越える", () => {
    // A, [B], C, [D], E → ⌥↓ → A, C, [B], E, [D]
    const placements = planStep(["A", "B", "C", "D", "E"], new Set(["B", "D"]), 1);
    expect(placements).toEqual([
      { ids: ["B"], after: "C", before: "E" },
      { ids: ["D"], after: "E", before: null },
    ]);
  });

  it("選んだ行のどれかがすでに端（進む向き）にあれば、まとめて動かさない", () => {
    // A が先頭のまま ⌥↑ しようとしても、A 自身は上へ動けないので全体を動かさない
    expect(planStep(["A", "B", "C", "D", "E"], new Set(["A", "C"]), -1)).toBeNull();
  });

  it("離れて選んだ行（端に触れていない）は、それぞれ隣の動かさない行を1つ越える", () => {
    // A, [B], C, [D], E → ⌥↑ → [B], A, [D], C, E
    const placements = planStep(["A", "B", "C", "D", "E"], new Set(["B", "D"]), -1);
    expect(placements).toEqual([
      { ids: ["B"], after: null, before: "A" },
      { ids: ["D"], after: "A", before: "C" },
    ]);
  });

  it("隣り合って選んだ行はまとめて1つ動く", () => {
    const placements = planStep(["A", "B", "C", "D"], new Set(["B", "C"]), 1);
    expect(placements).toEqual([{ ids: ["B", "C"], after: "D", before: null }]);
  });

  it("全部選んでいる・何も選んでいないときは null", () => {
    expect(planStep(["A", "B"], new Set(["A", "B"]), 1)).toBeNull();
    expect(planStep(["A", "B"], new Set(), 1)).toBeNull();
  });
});

describe("planDrop（ドラッグで落とす）", () => {
  it("前へ落とす（before）", () => {
    const placements = planDrop(["A", "B", "C", "D"], ["D"], "B", "before");
    expect(placements).toEqual([{ ids: ["D"], after: "A", before: "B" }]);
  });

  it("後ろへ落とす（after）", () => {
    const placements = planDrop(["A", "B", "C", "D"], ["A"], "B", "after");
    expect(placements).toEqual([{ ids: ["A"], after: "B", before: "C" }]);
  });

  it("一番上・一番下へ落とす（端は after/before が null）", () => {
    expect(planDrop(["A", "B", "C"], ["C"], "A", "before")).toEqual([
      { ids: ["C"], after: null, before: "A" },
    ]);
    expect(planDrop(["A", "B", "C"], ["A"], "C", "after")).toEqual([
      { ids: ["A"], after: "C", before: null },
    ]);
  });

  it("複数の行をまとめて運ぶ（今の並びの順で入る）", () => {
    const placements = planDrop(["A", "B", "C", "D", "E"], ["D", "B"], "A", "before");
    // movingIds の指定順ではなく、order 上の並び順（B, D）でまとまる
    expect(placements).toEqual([{ ids: ["B", "D"], after: null, before: "A" }]);
  });

  it("落としても並びが変わらない位置は null（自分の直後に自分を落とす、など）", () => {
    expect(planDrop(["A", "B", "C"], ["A"], "B", "before")).toBeNull();
    expect(planDrop(["A", "B", "C"], ["B"], "B", "before")).toBeNull();
  });

  it("target が動かす行の中、または並びに含まれないときは null", () => {
    expect(planDrop(["A", "B", "C"], ["A", "B"], "A", "after")).toBeNull();
    expect(planDrop(["A", "B", "C"], ["A"], "X", "after")).toBeNull();
  });
});
