import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { sectionsByDate } from "@/features/dates/labels";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/**
 * 予定：日付ごとのまとまり（明日、10/2(金)、…）で、日付の順に並ぶ。t・d・l で置き場を変えられる。
 * ここで n を押すと受信箱に入る（予定への追加は Core Flows にない）ので、追加欄は一覧の一番上に開く
 */
export const UpcomingScreen = observer(function UpcomingScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "upcoming",
    kind: "upcoming",
    sections: () => sectionsByDate(store.lists.scheduled, store.today),
    addTo: { bucket: "inbox", label: "受信箱に追加" },
  }));

  return (
    <ListScreen title="予定">
      <TaskList view={view} label="予定" empty={<p>予定のタスクはありません</p>} />
    </ListScreen>
  );
});
