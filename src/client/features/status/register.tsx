import { observer } from "mobx-react-lite";
import { type KeyContext, keymap, registerKeyBindings } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { openRowsOf, selectionForOperation } from "@/tasks/commands";
import { DETAIL_ORDER, type DetailFieldProps, registerDetailField } from "@/tasks/extensions";
import { chipClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import { toggleStarted } from "./commands";

/**
 * 11 の登録：s（進行中にする／やめる）と、開いたタスクの状態のボタン。
 * 行の丸の半分を紫にする印は、完了の丸（tasks/complete-button.tsx）が描く。
 * s は、選んでいるすべての未完了の行にかける（7 の複数選択）。未着手が1つでもあれば未着手のものを進行中にし、
 * 全部が進行中のときだけ未着手に戻す
 */

const hasOpenSelected = ({ ui }: KeyContext) =>
  ui.selectedRows.some((row) => row.completedAt === null);

registerKeyBindings({
  id: "task.start",
  label: "進行中にする／やめる",
  group: "タスク",
  keys: ["s"],
  when: hasOpenSelected,
  run: ({ ui }) => {
    const rows = selectionForOperation(ui);
    const ids = openRowsOf(rows ?? []).map((row) => row.id);
    if (ids.length > 0) toggleStarted(ui, ids);
  },
});

/** 状態の小さな丸（未着手は空の丸、進行中は半分が紫）。行の完了の丸と同じ見た目を小さくしたもの */
function StatusGlyph({ inProgress }: { inProgress: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 flex-none rounded-full border-[1.4px]",
        inProgress ? "status-in-progress" : "border-(--circle)",
      )}
    />
  );
}

function keyHint(): string {
  const key = keymap.get("task.start")?.keys[0];
  return key === undefined ? "" : `（${formatKey(key)}）`;
}

/**
 * 開いたタスクの一番下の列の先頭：状態（未着手・進行中）。押すと切り替わる（s と同じ）。
 * 今日以外のタスクを進行中にすると、今日の一番上へ移る。完了したタスクには出さない（いつやるの欄が「完了」と出す）
 */
const StatusChip = observer(function StatusChip({ task }: DetailFieldProps) {
  const ui = useUi();
  const status = task.status;
  if (status === "completed") return null;
  const inProgress = status === "in-progress";
  const label = inProgress ? "進行中" : "未着手";
  return (
    <button
      type="button"
      aria-label={`状態：${label}`}
      title={`${inProgress ? "未着手に戻す" : "進行中にする"}${keyHint()}`}
      data-status={status}
      className={cn(
        chipClassName,
        "gap-1.5 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
        inProgress && "text-primary-text",
      )}
      onClick={(event) => {
        event.stopPropagation();
        toggleStarted(ui, [task.id]);
      }}
    >
      <StatusGlyph inProgress={inProgress} />
      {label}
    </button>
  );
});

registerDetailField({
  id: "status",
  placement: "chip",
  order: DETAIL_ORDER.status,
  Component: StatusChip,
});
