import { observer } from "mobx-react-lite";
import {
  DETAIL_ORDER,
  ROW_META_ORDER,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { checklistProgress } from "./checklist";
import { ChecklistEditor } from "./checklist-editor";

/**
 * 6 の登録：行の右側のチェックリストの進み具合（2/4）と、開いたタスクのチェックリスト（メモの下）。
 * 全部チェックしても、タスクは自動では完了にしない
 */

const ChecklistProgress = observer(function ChecklistProgress({ task }: TaskSlotProps) {
  const { done, total } = checklistProgress(task.checklist);
  if (total === 0) return null;
  return (
    <span className="tabular-nums">
      <span className="sr-only">チェックリスト </span>
      {done}/{total}
    </span>
  );
});

registerRowMeta({ id: "checklist", order: ROW_META_ORDER.checklist, Component: ChecklistProgress });

registerDetailField({
  id: "checklist",
  placement: "section",
  order: DETAIL_ORDER.checklist,
  Component: ChecklistEditor,
});
