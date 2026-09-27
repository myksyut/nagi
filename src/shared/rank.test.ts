import { describe, expect, it } from "vitest";
import { mutationSchema } from "./mutations";
import {
  arrivalRanks,
  compareRank,
  isValidRank,
  rankAfter,
  rankBefore,
  rankBetween,
  ranksBetween,
} from "./rank";

/** 配列の index 番目を返す。存在しなければ投げる（noUncheckedIndexedAccess 用） */
function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`index ${index} が存在しません`);
  return value;
}

describe("isValidRank", () => {
  it("fractional-indexingのキーとして正しければtrue", () => {
    expect(isValidRank(rankAfter(null))).toBe(true);
    expect(isValidRank(rankBefore(null))).toBe(true);
  });

  it("空・記号・長すぎる文字列はfalse", () => {
    expect(isValidRank("")).toBe(false);
    expect(isValidRank("!!")).toBe(false);
    expect(isValidRank("a".repeat(1025))).toBe(false);
  });

  // 7-修正1の3：同じ隙間に入れ続けても足りるよう、上限は 1024 文字（画面とサーバーで共通）
  it("1024 文字ちょうどは通り、1025 文字は断る", () => {
    const ofLength = (length: number) => `a0${"0".repeat(length - 3)}1`;
    expect(ofLength(1024)).toHaveLength(1024);
    expect(isValidRank(ofLength(1024))).toBe(true);
    expect(isValidRank(ofLength(1025))).toBe(false);
    expect(mutationSchema.safeParse(taskUpdate(ofLength(1024))).success).toBe(true);
    expect(mutationSchema.safeParse(taskUpdate(ofLength(1025))).success).toBe(false);
  });

  it("同じ隙間の直後へ別々の行を入れ続けても、1000 回までは上限に届かない", () => {
    let upper = "a1";
    for (let i = 0; i < 1000; i++) {
      upper = rankBetween("a0", upper);
      expect(isValidRank(upper)).toBe(true);
    }
  });
});

function taskUpdate(rank: string) {
  return { type: "task.update", id: "0199a000-0000-7000-8000-000000000001", changes: { rank } };
}

describe("compareRank", () => {
  it("rankの順に並ぶ", () => {
    const a = { id: "a", rank: "a1" };
    const b = { id: "b", rank: "a2" };
    expect(compareRank(a, b)).toBeLessThan(0);
    expect(compareRank(b, a)).toBeGreaterThan(0);
  });

  it("rankが同じならidの順", () => {
    const a = { id: "a", rank: "a1" };
    const b = { id: "b", rank: "a1" };
    expect(compareRank(a, b)).toBeLessThan(0);
    expect(compareRank(b, a)).toBeGreaterThan(0);
    expect(compareRank(a, a)).toBe(0);
  });
});

describe("ranksBetween", () => {
  it("beforeとafterの間にn個のキーを昇順で作る", () => {
    const before = rankAfter(null);
    const after = rankAfter(before);
    const keys = ranksBetween(before, after, 3);
    expect(keys).toHaveLength(3);
    const all = [before, ...keys, after];
    for (let i = 0; i + 1 < all.length; i++) {
      expect(at(all, i) < at(all, i + 1)).toBe(true);
    }
  });

  it("afterがbefore以下のとき（rankが重なっているとき）は、beforeの後ろに作る", () => {
    const before = rankAfter(null);
    const after = before; // 重なっている
    const keys = ranksBetween(before, after, 2);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key > before).toBe(true);
    expect(at(keys, 0) < at(keys, 1)).toBe(true);
  });
});

describe("rankAfter / rankBefore", () => {
  it("一番下・一番上に入るキーを作る", () => {
    const first = rankAfter(null);
    const second = rankAfter(first);
    expect(second > first).toBe(true);

    const beforeFirst = rankBefore(first);
    expect(beforeFirst < first).toBe(true);
  });
});

describe("arrivalRanks", () => {
  it("今日来たタスクの後ろ、それ以外の前にn個入る", () => {
    const arrived = { id: "arrived", rank: rankAfter(null), arrivedOn: "2026-09-28" };
    const other = { id: "other", rank: rankAfter(arrived.rank), arrivedOn: "2026-09-01" };
    const keys = arrivalRanks([arrived, other], "2026-09-28", 2);
    expect(keys).toHaveLength(2);
    expect(at(keys, 0) > arrived.rank).toBe(true);
    expect(at(keys, 1) > at(keys, 0)).toBe(true);
    expect(at(keys, 1) < other.rank).toBe(true);
  });

  it("今日来たタスクがなければ一番上に入る", () => {
    const other = { id: "other", rank: rankAfter(null), arrivedOn: "2026-09-01" };
    const keys = arrivalRanks([other], "2026-09-28", 1);
    expect(keys).toHaveLength(1);
    expect(at(keys, 0) < other.rank).toBe(true);
  });

  it("nが0なら空配列", () => {
    expect(arrivalRanks([], "2026-09-28", 0)).toEqual([]);
  });
});
