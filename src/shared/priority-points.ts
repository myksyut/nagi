/**
 * タスクの優先度と工数（3 番目の版で追加）。値の一覧と型はここに1か所だけ置き、
 * D1 のスキーマ（CHECK 制約）・API の検証（zod）・画面側のデータ層と画面が同じものを使う。
 * 値を足したり消したりするときは、migrations の CHECK 制約も変える（表の作り直しになる）
 */

/** 優先度。高い順に並べる。なしは null */
export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** 優先度の表示名 */
export const PRIORITY_LABELS: Readonly<Record<Priority, string>> = {
  high: "高",
  medium: "中",
  low: "低",
};

/** 工数（ポイント）。少ない順に並べる。なしは null */
export const POINTS = [1, 2, 3, 5, 8, 13] as const;
export type Points = (typeof POINTS)[number];

export function isPriority(value: unknown): value is Priority {
  return typeof value === "string" && (PRIORITIES as readonly string[]).includes(value);
}

export function isPoints(value: unknown): value is Points {
  return typeof value === "number" && (POINTS as readonly number[]).includes(value);
}
