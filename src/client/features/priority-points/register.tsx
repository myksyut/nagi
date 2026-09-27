import { PRIORITY_LABELS } from "@shared/priority-points";
import { observer } from "mobx-react-lite";
import { registerKeyBindings } from "@/keyboard/keymap";
import { cn } from "@/lib/utils";
import { selectionForOperation } from "@/tasks/commands";
import { useDetailSurface } from "@/tasks/detail-surface";
import {
  DETAIL_ORDER,
  type DetailFieldProps,
  ROW_META_ORDER,
  registerDetachedHost,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { chipClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import { ValuePickerHosts, valuePickerOf } from "./picker";
import { PriorityMark, VALUE_LABELS, type ValueKind } from "./values";

/**
 * 16 の登録：⇧P（優先度）と e（工数）のキー、行の右側（ボードのカードの下にも出る）の優先度の印と工数、
 * 開いたタスクの優先度と工数のボタン。
 * ⇧P と e は p と同じく、選んでいるすべての行に候補を1回だけ開く（完了した行にも付けられる）。
 * カレンダーのマスとタイムラインの棒には印を出さない（行の右側の項目はそこに出ない）。そこで押すと開く小さな詳細には、
 * リストで開く詳細と同じくボタンを出し、候補は小さな詳細の中に開く（カレンダーとタイムラインでは、ここが唯一の入口）
 */

registerKeyBindings(
  (["priority", "points"] as const).map((kind) => ({
    id: `task.${kind}`,
    label: VALUE_LABELS[kind],
    group: "タスク" as const,
    keys: [kind === "priority" ? "Shift+p" : "e"],
    when: ({ ui }) => ui.selected !== undefined,
    // 選択が 500 件を超えていたら、開かずに知らせる
    run: ({ ui }) => {
      const rows = selectionForOperation(ui);
      if (rows && rows.length > 0) valuePickerOf(ui, kind).open(rows.map((row) => row.id));
    },
  })),
);

/** 行の右側の一番右：優先度の印と工数の数字（なしなら出さない）。⇧P と e の候補も、対象の行ではここから描く */
const PriorityPointsMeta = observer(function PriorityPointsMeta({ task }: TaskSlotProps) {
  const { priority, points } = task;
  return (
    <>
      {priority !== null && <PriorityMark priority={priority} />}
      {points !== null && (
        <span
          role="img"
          aria-label={`工数 ${points}`}
          title="工数"
          className="rounded-[5px] border px-1 text-[11px] text-faint-foreground tabular-nums leading-4"
        >
          {points}
        </span>
      )}
      <ValuePickerHosts task={task} />
    </>
  );
});

registerRowMeta({
  id: "priority-points",
  order: ROW_META_ORDER.priorityPoints,
  Component: PriorityPointsMeta,
});

/**
 * 開いたタスクの一番下の列：優先度（「優先度 高」と印）と工数（「工数 3」）。なしなら点線の「優先度」「工数」。
 * 押すと ⇧P・e と同じ候補が、このボタンから広がる。リストで開いた詳細と、小さな詳細（カレンダーとタイムラインの
 * ポップオーバー。候補は小さな詳細の中に開く）の両方に出る
 */
const ValueChip = observer(function ValueChip({
  task,
  kind,
}: DetailFieldProps & { kind: ValueKind }) {
  const ui = useUi();
  const { detached } = useDetailSurface();
  const label = VALUE_LABELS[kind];
  const priority = kind === "priority" ? task.priority : null;
  const value =
    priority !== null ? PRIORITY_LABELS[priority] : kind === "points" ? task.points : null;
  return (
    <button
      type="button"
      aria-label={value === null ? `${label}を付ける` : `${label}：${value}`}
      className={cn(
        chipClassName,
        "outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
        value === null && "border-dashed text-muted-foreground/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        valuePickerOf(ui, kind).open(task.id, event.currentTarget, detached);
      }}
    >
      {priority !== null && <PriorityMark priority={priority} />}
      {value === null ? label : `${label} ${value}`}
    </button>
  );
});

for (const kind of ["priority", "points"] as const) {
  registerDetailField({
    id: kind,
    placement: "chip",
    order: DETAIL_ORDER[kind],
    Component: (props) => <ValueChip {...props} kind={kind} />,
  });
}

// 小さな詳細（カレンダーとタイムラインのポップオーバー）の中の優先度と工数のボタンから開いた候補は、
// 小さな詳細の中に描く（一覧に行がなくてよい）
registerDetachedHost({
  id: "priority-points-picker",
  order: 30,
  Component: ({ task }) => <ValuePickerHosts task={task} detached />,
});
