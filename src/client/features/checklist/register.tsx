import { observer } from "mobx-react-lite";
import { defer, useDeferred } from "@/lib/deferred";
import {
  DETAIL_ORDER,
  ROW_META_ORDER,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { checklistProgress } from "./checklist";

/**
 * 6 の登録：行の右側のチェックリストの進み具合（2/4）と、開いたタスクのチェックリスト（メモの下）。
 * 全部チェックしても、タスクは自動では完了にしない。
 * チェックリストの編集（ドラッグの並べ替えに Motion の Reorder、チェックに Base UI の Checkbox を使う）は、
 * 起動に要らないので後から読み込む（ふだんは起動のあとの空いた時間に先読みしてある）
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

const editor = defer(() => import("./checklist-editor"));

function LazyChecklistEditor({ task }: TaskSlotProps) {
  const module = useDeferred(editor);
  return module ? <module.ChecklistEditor task={task} /> : null;
}

registerDetailField({
  id: "checklist",
  placement: "section",
  order: DETAIL_ORDER.checklist,
  Component: LazyChecklistEditor,
});
