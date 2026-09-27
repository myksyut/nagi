import type { TaskRow } from "@/data";
import { defer } from "@/lib/deferred";
import type { ListUi } from "@/tasks/list-ui";
import { RowPicker, RowPickerHost } from "@/tasks/row-picker";
import { useUi } from "@/tasks/ui-context";
import { priorityKeyOf, VALUE_LABELS, type ValueKind, valuePlaceholder } from "./values";

/**
 * ⇧P（優先度）と e（工数）の小さな候補の開閉の状態と、それを描く枠。開閉は p の候補と同じ RowPicker で、
 * 候補の部品（Base UI の Combobox）は parts.tsx にあり、起動に要らないので後から読み込む。
 * 候補は、対象のタスクの行の右側の枠（register.tsx の優先度の印と工数）から描き、行（キーのとき）か押したボタンから広がる
 */

const pickers = new WeakMap<ListUi, Record<ValueKind, RowPicker>>();

/** その一覧の状態に付いた、優先度か工数の候補の開閉（種類ごとに1つ） */
export function valuePickerOf(ui: ListUi, kind: ValueKind): RowPicker {
  let value = pickers.get(ui);
  if (!value) {
    value = { priority: new RowPicker(ui), points: new RowPicker(ui) };
    pickers.set(ui, value);
  }
  return value[kind];
}

const popups = {
  priority: defer(() => import("./parts").then((module) => module.PriorityPickerPopup)),
  points: defer(() => import("./parts").then((module) => module.PointsPickerPopup)),
};

/**
 * 行の右側の枠に置く。そのタスクの優先度か工数の候補を開いているとき（と、閉じる途中）だけ描く。
 * 小さな詳細（カレンダーとタイムラインのポップオーバー）は detached を付けて自分の中に置き、そこから開いた候補だけを描く
 */
export function ValuePickerHosts({ task, detached }: { task: TaskRow; detached?: boolean }) {
  const ui = useUi();
  return (["priority", "points"] as const).map((kind) => (
    <RowPickerHost
      key={kind}
      task={task}
      picker={valuePickerOf(ui, kind)}
      popup={popups[kind]}
      label={VALUE_LABELS[kind]}
      placeholder={(ids) => valuePlaceholder(kind, ids)}
      detached={detached}
      // 優先度は、読み込みを待つあいだに押した 1・2・3・0 も、届いたらその場で決める（工数は打った数字を欄へ移す）
      waitingKey={kind === "priority" ? priorityKeyOf : undefined}
    />
  ));
}
