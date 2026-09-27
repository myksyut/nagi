import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { AddHint } from "@/tasks/add-hint";
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
  return (
    <ListScreen title="受信箱" list="inbox" count={() => store.lists.inboxCount}>
      <TaskList view={view} label="受信箱" empty={<Empty />} />
    </ListScreen>
  );
});

function Empty() {
  return (
    <>
      <p>受信箱は空です</p>
      <AddHint />
    </>
  );
}
