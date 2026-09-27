import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { formatDayHeading } from "@/lib/format-date";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/**
 * 今日：自分で決めた順（rank。⌥↑↓ とドラッグで並べ替える）。日付の到来や締切で入ったものは一番上に印付きで並ぶ（並びはサーバーが振る）。
 * 一番下に、今日完了したものの「完了 N件」（最初は閉じている）
 */
export const TodayScreen = observer(function TodayScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "today",
    kind: "today",
    sections: () => [
      { key: "open", rows: store.lists.today, reorderable: true },
      {
        key: "completed",
        rows: store.lists.completedToday,
        fold: { label: `完了 ${store.lists.completedTodayCount}件` },
      },
    ],
    addTo: { bucket: "today", label: "今日に追加" },
    addInSection: "open",
  }));

  return (
    <ListScreen title="今日" subtitle={formatDayHeading(store.today)}>
      <TaskList view={view} label="今日" empty={<TodayEmpty />} />
    </ListScreen>
  );
});

const TodayEmpty = observer(function TodayEmpty() {
  const { lists } = useStore();
  if (lists.completedTodayCount > 0) return <p>今日のタスクはすべて完了しました</p>;
  return (
    <>
      <p>今日のタスクはまだありません</p>
      {lists.inboxCount > 0 && <p className="mt-1 text-xs">受信箱に {lists.inboxCount} 件</p>}
    </>
  );
});
