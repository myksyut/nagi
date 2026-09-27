import { observer } from "mobx-react-lite";
import { registerKeyBindings } from "@/keyboard/keymap";
import { useDeferred } from "@/lib/deferred";
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
import { useUi } from "@/tasks/ui-context";
import { parts, ValuePickerHosts, valuePickerOf } from "./picker";
import { PriorityMark, VALUE_LABELS, type ValueKind } from "./values";

/**
 * 16 の登録：⇧P（優先度）と e（工数）のキー、行の右側（ボードのカードの下にも出る）の優先度の印と工数、
 * 開いたタスクの優先度と工数のボタン（parts.tsx。後から読み込む）。
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
 * 開いたタスクの一番下の列の優先度と工数のボタン（parts.tsx。届くまでは出さない）。
 * 押すと、このボタンから候補が広がる（小さな詳細の中では、候補を小さな詳細の中に開く）
 */
function LazyValueChip({ task, kind }: DetailFieldProps & { kind: ValueKind }) {
  const ui = useUi();
  const { detached } = useDetailSurface();
  const { module } = useDeferred(parts);
  if (!module) return null;
  return (
    <module.ValueChip
      task={task}
      kind={kind}
      onOpen={(anchor) => valuePickerOf(ui, kind).open(task.id, anchor, detached)}
    />
  );
}

for (const kind of ["priority", "points"] as const) {
  registerDetailField({
    id: kind,
    placement: "chip",
    order: DETAIL_ORDER[kind],
    Component: (props) => <LazyValueChip {...props} kind={kind} />,
  });
}

// 小さな詳細（カレンダーとタイムラインのポップオーバー）の中の優先度と工数のボタンから開いた候補は、
// 小さな詳細の中に描く（一覧に行がなくてよい）
registerDetachedHost({
  id: "priority-points-picker",
  order: 30,
  Component: ({ task }) => <ValuePickerHosts task={task} detached />,
});
