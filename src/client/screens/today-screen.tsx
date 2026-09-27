import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { LazyBoard } from "@/features/board/lazy-board";
import { useScreenLayout, ViewToggle } from "@/features/board/view-toggle";
import { formatDayHeading } from "@/lib/format-date";
import { AddHint } from "@/tasks/add-hint";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/** 今日の画面の名前（一覧の名前と、リスト｜ボードの切り替えを覚える名前） */
const TODAY = "today";

/**
 * 今日：自分で決めた順（rank。⌥↑↓ とドラッグで並べ替える）。日付の到来や締切で入ったものは一番上に印付きで並ぶ（並びはサーバーが振る）。
 * 一番下に、今日完了したものの「完了 N件」（最初は閉じている）。
 * 見出しの右の「リスト｜ボード」か v で、状態の列（未着手・進行中・完了）のボードに切り替わる（どちらで見ていたかは覚える）
 */
export const TodayScreen = observer(function TodayScreen() {
  const store = useStore();
  const layout = useScreenLayout(TODAY);

  return (
    <ListScreen
      title="今日"
      list="today"
      date={formatDayHeading(store.today)}
      count={() => store.lists.todayCount}
      actions={<ViewToggle screen={TODAY} />}
    >
      {layout === "board" ? <LazyBoard target={{ kind: "today" }} /> : <TodayList />}
    </ListScreen>
  );
});

const TodayList = observer(function TodayList() {
  const store = useStore();
  const view = useListView(() => ({
    key: TODAY,
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
  return <TaskList view={view} label="今日" empty={<TodayEmpty />} />;
});

const TodayEmpty = observer(function TodayEmpty() {
  const { lists } = useStore();
  if (lists.completedTodayCount > 0) return <p>今日のタスクはすべて完了しました</p>;
  return (
    <>
      <p>今日のタスクはまだありません</p>
      <AddHint />
      {lists.inboxCount > 0 && <p className="mt-1 text-xs">受信箱に {lists.inboxCount} 件</p>}
    </>
  );
});
