import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { LATER_NO_PROJECT, laterSections } from "@/features/projects/later-sections";
import { SortButton } from "@/features/sort/sort-button";
import { sortSections } from "@/features/sort/state";
import { AddHint } from "@/tasks/add-hint";
import { TaskList } from "@/tasks/task-list";
import { useListView, useUi } from "@/tasks/ui-context";
import { ListScreen } from "./list-screen";

const LATER = "later";

/**
 * あとで：プロジェクトごとのまとまり（プロジェクトなしが先頭）。まとまりの中は自分で決めた順（rank）で、
 * 見出しの右の並び方（features/sort）で、まとまりの中を優先度や工数の順に並べて見られる
 */
export const LaterScreen = observer(function LaterScreen() {
  const store = useStore();
  const ui = useUi();
  const view = useListView(() => ({
    key: LATER,
    kind: "later",
    sections: () => sortSections(ui, LATER, laterSections(store)),
    addTo: { bucket: "later", label: "あとでに追加" },
    addInSection: LATER_NO_PROJECT,
  }));

  return (
    <ListScreen
      title="あとで"
      list="later"
      count={() => store.lists.later.length}
      actions={<SortButton screen={LATER} />}
    >
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
