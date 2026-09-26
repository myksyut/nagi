import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/**
 * 予定：日付の順の平らな一覧（5 で日付ごとのまとまりにし、日付を出す）。
 * ここで n を押すと受信箱に入る（予定への追加は Core Flows にない）ので、追加欄は一覧の一番上に開く
 */
export const UpcomingScreen = observer(function UpcomingScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "upcoming",
    kind: "upcoming",
    sections: () => [{ key: "open", rows: store.lists.scheduled }],
    addTo: { bucket: "inbox", label: "受信箱に追加" },
  }));

  return (
    <ListScreen title="予定">
      <TaskList view={view} label="予定" empty={<p>予定のタスクはありません</p>} />
    </ListScreen>
  );
});
