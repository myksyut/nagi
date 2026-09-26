import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/** あとで：自分で決めた順（rank）の平らな一覧（6 でプロジェクトごとのまとまりに変える） */
export const LaterScreen = observer(function LaterScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "later",
    kind: "later",
    sections: () => [{ key: "open", rows: store.lists.later }],
    addTo: { bucket: "later", label: "あとでに追加" },
    addInSection: "open",
  }));

  return (
    <ListScreen title="あとで">
      <TaskList view={view} label="あとで" empty={<p>あとでのタスクはありません</p>} />
    </ListScreen>
  );
});
