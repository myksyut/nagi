import { observable, runInAction } from "mobx";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { type LogbookDay, useStore } from "@/data";
import { formatDayHeading } from "@/lib/format-date";
import type { TaskSection } from "@/tasks/list-ui";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/** 一度に描く完了ログの行数。続きは「さらに表示」か、一番下で ↓ を押すと読み込む */
export const LOGBOOK_PAGE_SIZE = 200;

/** 続きを表示したときの上限。全部表示していたら増やさない（一番下で ↓ を押し続けても計算し直さない） */
export function nextLogbookLimit(limit: number, total: number): number {
  return limit >= total ? limit : limit + LOGBOOK_PAGE_SIZE;
}

function countRows(days: readonly LogbookDay[]): number {
  return days.reduce((sum, day) => sum + day.tasks.length, 0);
}

/** 完了した日ごとに新しい順の見出しつきのまとまりを、先頭から limit 行ぶん */
function logbookSections(days: readonly LogbookDay[], limit: number, today: string): TaskSection[] {
  const sections: TaskSection[] = [];
  let remaining = limit;
  for (const day of days) {
    if (remaining <= 0) break;
    const rows = day.tasks.length <= remaining ? day.tasks : day.tasks.slice(0, remaining);
    remaining -= rows.length;
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
  const [limit] = useState(() => observable.box(LOGBOOK_PAGE_SIZE));
  const showMore = () =>
    runInAction(() => {
      const next = nextLogbookLimit(limit.get(), countRows(store.lists.logbook));
      if (next !== limit.get()) limit.set(next);
    });
  const view = useListView(() => ({
    key: "logbook",
    kind: "logbook",
    sections: () => logbookSections(store.lists.logbook, limit.get(), store.today),
    addTo: { bucket: "inbox", label: "受信箱に追加" },
    onReachEnd: showMore,
  }));
  const total = countRows(store.lists.logbook);
  const hidden = total - limit.get();

  return (
    <ListScreen title="完了ログ">
      <TaskList view={view} label="完了ログ" empty={<p>完了したタスクはまだありません</p>} />
      {hidden > 0 && (
        <button
          type="button"
          className="mt-4 rounded-md px-2.5 py-1 text-muted-foreground text-sm hover:text-foreground"
          onClick={showMore}
        >
          さらに表示（残り {hidden} 件）
        </button>
      )}
    </ListScreen>
  );
});
