import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/** 受信箱：古いものが上。t（今日）・l（あとで）で振り分けると、行が抜けて選択は次へ移る */
export const InboxScreen = observer(function InboxScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "inbox",
    kind: "inbox",
    sections: () => [{ key: "open", rows: store.lists.inbox }],
    addTo: { bucket: "inbox", label: "受信箱に追加" },
    addInSection: "open",
  }));
  const count = store.lists.inboxCount;

  return (
    <ListScreen title="受信箱" subtitle={count > 0 ? `${count}件` : undefined}>
      <TaskList view={view} label="受信箱" empty={<p>受信箱は空です</p>} />
    </ListScreen>
  );
});
