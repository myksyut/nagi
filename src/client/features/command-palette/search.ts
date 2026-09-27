import type { AppStore, TaskRow } from "@/data";
import { formatShortDateWithWeekday } from "@/features/dates/labels";
import { BUCKET_LISTS, type ListKey, LOGBOOK } from "@/navigation";

/**
 * ⌘K のタスクの検索。サーバーには聞かず、メモリ上のデータだけで探す。
 * 対象は削除していないすべてのタスク（完了ログも含む）。タイトルに合うものを先に、メモだけに合うものを後に出す
 */

/** 比べ方：全角と半角、大文字と小文字を区別しない */
export function normalizeQuery(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

/** タスクがあるリスト。⌘K で選ぶと、ここを開いてその行を選ぶ */
export type TaskLocation = {
  list: ListKey;
  path: string;
  /** 結果の横に出す場所（「今日」「予定 10/2(金)」「完了ログ」など） */
  label: string;
};

const LIST_PATHS = new Map([...BUCKET_LISTS, LOGBOOK].map((list) => [list.key, list.path]));

function location(list: ListKey, label: string): TaskLocation {
  return { list, path: LIST_PATHS.get(list) ?? "/", label };
}

/**
 * タスクがあるリスト。未完了なら置き場のリスト（予定は日付つき）。
 * 今日（論理日付）完了したものは今日の「完了 N件」、それより前に完了したものは完了ログ
 */
export function locationOf(store: AppStore, task: TaskRow): TaskLocation {
  const completedAt = task.completedAt;
  if (completedAt !== null) {
    return completedAt >= store.day.startsAt
      ? location("today", "今日・完了")
      : location("logbook", "完了ログ");
  }
  switch (task.bucket) {
    case "inbox":
      return location("inbox", "受信箱");
    case "today":
      return location("today", "今日");
    case "scheduled":
      return location(
        "upcoming",
        task.scheduledOn === null
          ? "予定"
          : `予定 ${formatShortDateWithWeekday(task.scheduledOn, store.today)}`,
      );
    case "later":
      return location("later", "あとで");
  }
}

/** 比べるための文字（行ごとに、タイトルとメモが変わったときだけ作り直す） */
type Normalized = { title: string; memo: string; normalizedTitle: string; normalizedMemo: string };
const normalizedCache = new WeakMap<TaskRow, Normalized>();

function normalizedOf(row: TaskRow): Normalized {
  const { title, memo } = row.peek();
  const cached = normalizedCache.get(row);
  if (cached && cached.title === title && cached.memo === memo) return cached;
  const next = {
    title,
    memo,
    normalizedTitle: normalizeQuery(title),
    normalizedMemo: normalizeQuery(memo),
  };
  normalizedCache.set(row, next);
  return next;
}

/** 未完了を置き場の順に、そのあと完了済み（新しい順） */
const OPEN_PARTITIONS = ["today", "inbox", "scheduled", "later"] as const;

const byCompletedDesc = (a: TaskRow, b: TaskRow) => {
  const x = a.peek().completedAt ?? "";
  const y = b.peek().completedAt ?? "";
  return x < y ? 1 : x > y ? -1 : 0;
};

/** 合うタスク（多すぎるときは limit 件まで） */
export function searchTasks(store: AppStore, query: string, limit = 30): TaskRow[] {
  const q = normalizeQuery(query);
  if (q === "") return [];
  const collect = (rows: Iterable<TaskRow>) => {
    const byTitle: TaskRow[] = [];
    const byMemo: TaskRow[] = [];
    for (const row of rows) {
      const { normalizedTitle, normalizedMemo } = normalizedOf(row);
      if (normalizedTitle.includes(q)) byTitle.push(row);
      else if (normalizedMemo.includes(q)) byMemo.push(row);
    }
    return { byTitle, byMemo };
  };
  const index = store.replica.taskIndex;
  const open = collect(OPEN_PARTITIONS.flatMap((partition) => [...index.rows(partition)]));
  const completed = collect(index.rows("completed"));
  return [
    ...open.byTitle,
    ...completed.byTitle.sort(byCompletedDesc),
    ...open.byMemo,
    ...completed.byMemo.sort(byCompletedDesc),
  ].slice(0, limit);
}
