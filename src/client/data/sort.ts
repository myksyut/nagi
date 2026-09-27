import { type Points, PRIORITIES, type Priority } from "@shared/priority-points";

/**
 * 一覧の並び方（今日・あとで・プロジェクト・ボードの見出しの切り替え）。並べ替えは表示だけで、rank は書き換えない
 * - manual：手動（渡された並びのまま。各一覧の並び順キーの順）
 * - priority：優先度の高・中・低・なしの順
 * - points-asc・points-desc：工数の少ない順・多い順。工数のないタスクはどちらの向きでも最後
 * どれも、同じ値の中は渡された並び（手動の順）のまま
 */
export const TASK_SORTS = ["manual", "priority", "points-asc", "points-desc"] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/** 並び方の表示名 */
export const TASK_SORT_LABELS: Readonly<Record<TaskSort, string>> = {
  manual: "手動",
  priority: "優先度",
  "points-asc": "工数が少ない順",
  "points-desc": "工数が多い順",
};

export function isTaskSort(value: unknown): value is TaskSort {
  return typeof value === "string" && (TASK_SORTS as readonly string[]).includes(value);
}

/** 並べ替えに使う項目。TaskRow（priority・points を項目ごとに観測する getter）をそのまま渡せる */
export type SortableTask = {
  readonly priority: Priority | null;
  readonly points: Points | null;
};

/** 小さいほど上。値のないものは一番下 */
function sortKey(task: SortableTask, sort: Exclude<TaskSort, "manual">): number {
  switch (sort) {
    case "priority":
      return task.priority === null ? PRIORITIES.length : PRIORITIES.indexOf(task.priority);
    case "points-asc":
      return task.points ?? Number.POSITIVE_INFINITY;
    case "points-desc":
      return task.points === null ? Number.POSITIVE_INFINITY : -task.points;
  }
}

/**
 * 並んだ行（各一覧の今の並び）を sort の並び方で並べ替えた、新しい配列を返す（純粋な関数。rows は変えない）。
 * manual なら rows をそのまま返す。同じ値の中は rows の並びを保つ。
 * 行ごとに priority か points を1回だけ読む（TaskRow を渡すと、その項目だけを観測する。タイトルなどの変化では
 * 読み直さない）。完了のまとまりなどの区切りは、画面が一覧ごとに分けてから渡す
 */
export function sortTasks<T extends SortableTask>(
  rows: readonly T[],
  sort: TaskSort,
): readonly T[] {
  if (sort === "manual") return rows;
  return rows
    .map((row, index) => ({ row, index, key: sortKey(row, sort) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map((entry) => entry.row);
}
