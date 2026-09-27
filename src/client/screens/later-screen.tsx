import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { LATER_NO_PROJECT, laterSections } from "@/features/projects/later-sections";
import { AddHint } from "@/tasks/add-hint";
import { TaskList } from "@/tasks/task-list";
import { useListView } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

/** あとで：プロジェクトごとのまとまり（プロジェクトなしが先頭）。まとまりの中は自分で決めた順（rank） */
export const LaterScreen = observer(function LaterScreen() {
  const store = useStore();
  const view = useListView(() => ({
    key: "later",
    kind: "later",
    sections: () => laterSections(store),
    addTo: { bucket: "later", label: "あとでに追加" },
    addInSection: LATER_NO_PROJECT,
  }));

  return (
    <ListScreen title="あとで" list="later" count={() => store.lists.later.length}>
      <TaskList view={view} label="あとで" empty={<Empty />} />
    </ListScreen>
  );
});

function Empty() {
  return (
    <>
      <p>あとでのタスクはありません</p>
      <AddHint />
    </>
  );
}
