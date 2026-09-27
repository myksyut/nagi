import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { type LogbookDay, useStore } from "@/data";
import { formatDayHeading } from "@/lib/format-date";
import type { TaskSection } from "@/tasks/list-ui";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/**
 * 一度に描く完了ログの行数。続きは「さらに表示」か、一番下で ↓ を押すと読み込む。
 * ⌘K の検索で深い位置のタスクを選んだときは、そのタスクを含むこの行数ほどの窓だけを描き、
 * 窓より新しい側は「新しい完了を表示」か、一番上で ↑ を押すと読み込む（2 万件目へ飛んでも 2 万行は描かない）
 */
export const LOGBOOK_PAGE_SIZE = 200;

/** 描く範囲。新しい順に数えた行の [start, end) */
export type LogbookWindow = { start: number; end: number };

/** 続きを表示したときの上限。全部表示していたら増やさない（一番下で ↓ を押し続けても計算し直さない） */
export function nextLogbookLimit(limit: number, total: number): number {
  return limit >= total ? limit : limit + LOGBOOK_PAGE_SIZE;
}

/** 窓より新しい側を1ページぶん足したときの start（先頭まで出ていれば 0 のまま） */
export function previousLogbookStart(start: number): number {
  return Math.max(0, start - LOGBOOK_PAGE_SIZE);
}

/**
 * index 番目の行を描く窓。今の窓に入っていれば今の窓のまま。入っていなければ、その行が真ん中あたりに来る
 * 1ページぶんの窓にする（一番古い側では、終わりまで1ページぶん）
 */
export function logbookWindowFor(
  current: LogbookWindow,
  index: number,
  total: number,
): LogbookWindow {
  if (index < 0 || (index >= current.start && index < current.end)) return current;
  const start = Math.max(0, Math.min(index - LOGBOOK_PAGE_SIZE / 2, total - LOGBOOK_PAGE_SIZE));
  return { start, end: start + LOGBOOK_PAGE_SIZE };
}

function countRows(days: readonly LogbookDay[]): number {
  return days.reduce((sum, day) => sum + day.tasks.length, 0);
}

/** 完了した日ごとに新しい順の見出しつきのまとまりのうち、[start, end) 行目だけ（窓にかかる日の見出しは出す） */
function logbookSections(
  days: readonly LogbookDay[],
  { start, end }: LogbookWindow,
  today: string,
): TaskSection[] {
  const sections: TaskSection[] = [];
  let offset = 0;
  for (const day of days) {
    if (offset >= end) break;
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, day.tasks.length);
    offset += day.tasks.length;
    if (from >= to) continue;
    const rows = from === 0 && to === day.tasks.length ? day.tasks : day.tasks.slice(from, to);
    sections.push({ key: day.date, heading: formatDayHeading(day.date, today), rows });
  }
  return sections;
}

/**
 * 完了ログ：昨日までに完了したものを、完了した日ごとに新しい順で（今日の分は今日の「完了 N件」）。
 * 丸か x で完了を外すと、今日の一番下に戻る
 */
export const LogbookScreen = observer(function LogbookScreen() {
  const store = useStore();
  const [range] = useState(() =>
    observable.box<LogbookWindow>({ start: 0, end: LOGBOOK_PAGE_SIZE }, { deep: false }),
  );
  const showMore = () =>
    runInAction(() => {
      const { start, end } = range.get();
      const next = nextLogbookLimit(end, countRows(store.lists.logbook));
      if (next !== end) range.set({ start, end: next });
    });
  const showNewer = () =>
    runInAction(() => {
      const { start, end } = range.get();
      if (start > 0) range.set({ start: previousLogbookStart(start), end });
    });
  // ⌘K の検索で選んだタスクが描いていないところにあれば、そのタスクを含む窓に移す
  const reveal = (taskId: string) =>
    runInAction(() => {
      const rows = store.lists.logbook.flatMap((day) => day.tasks);
      const index = rows.findIndex((task) => task.id === taskId);
      const next = logbookWindowFor(range.get(), index, rows.length);
      if (next !== range.get()) range.set(next);
    });
  const view = useListView(() => ({
    key: "logbook",
    kind: "logbook",
    sections: () => logbookSections(store.lists.logbook, range.get(), store.today),
    addTo: { bucket: "inbox", label: "受信箱に追加" },
    onReachEnd: showMore,
    onReachStart: showNewer,
    reveal,
    // 窓の始まりが変わったら、行の動きなしで描き直す（上に足した行の分だけ、残りの行が動いて見えないように）
    layoutKey: () => String(range.get().start),
  }));
  const total = countRows(store.lists.logbook);
  const { start, end } = range.get();
  const hidden = total - end;
  const buttonClassName =
    "rounded-md px-2.5 py-1 text-muted-foreground text-sm hover:text-foreground";

  return (
    <ListScreen title="完了ログ">
      {start > 0 && (
        <button type="button" className={`mt-4 ${buttonClassName}`} onClick={showNewer}>
          新しい完了を表示（ほかに {start} 件）
        </button>
      )}
      <TaskList view={view} label="完了ログ" empty={<p>完了したタスクはまだありません</p>} />
      {hidden > 0 && (
        <button type="button" className={`mt-4 ${buttonClassName}`} onClick={showMore}>
          さらに表示（残り {hidden} 件）
        </button>
      )}
    </ListScreen>
  );
});
