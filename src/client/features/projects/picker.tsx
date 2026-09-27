import type { ProjectRow, TaskRow } from "@/data";
import { defer } from "@/lib/deferred";
import type { ListUi } from "@/tasks/list-ui";
import { type PickerSession, RowPicker, RowPickerHost } from "@/tasks/row-picker";
import { useUi } from "@/tasks/ui-context";
import { normalizeName } from "./commands";

/**
 * p（プロジェクト）の候補の開閉の状態と、それを描く枠。候補そのもの（coss ui の Combobox）は picker-popup.tsx にあり、
 * 起動に要らないので後から読み込む（Base UI の Combobox を最初の JS から外す）。
 * 名前を打って絞り込み、Enter で決める。当てはまる名前がなければ「「◯◯」を作成」が出て、その場で作って付けられる。
 * アーカイブ済みのプロジェクトは候補に出さない。付けても置き場は変わらない（受信箱なら受信箱に残る）。
 * 候補は、対象のタスクの行の右側の枠（register.tsx）から描き、行（p のとき）か押したボタンから広がる。
 * 小さな詳細（tasks/task-detail-popover.tsx）の中のボタンから開いたときは detached にし、小さな詳細が自分の中に描く
 * （一覧に行がなくてよい）
 */

/** 候補の1つ */
export type PickerItem =
  | { kind: "project"; id: string; label: string }
  | { kind: "create"; name: string; label: string }
  | { kind: "clear"; label: string };

/**
 * 打った文字に合う候補。プロジェクトは作成順で、名前の一部が合うもの（全角と半角、大文字と小文字は区別しない）。
 * 名前がちょうど同じものがなければ、最後に「「◯◯」を作成」。付いているプロジェクトを外す候補は、何も打っていないときだけ
 * （複数のタスクにかけるときは、どれかにプロジェクトが付いていれば canClear）
 */
export function pickerItems(
  projects: readonly ProjectRow[],
  query: string,
  currentProjectId: string | null,
  canClear = currentProjectId !== null,
): PickerItem[] {
  const q = normalizeName(query);
  const items: PickerItem[] = projects
    .filter((project) => normalizeName(project.name).includes(q))
    .map((project) => ({ kind: "project", id: project.id, label: project.name }));
  const name = query.trim();
  if (q !== "" && !projects.some((project) => normalizeName(project.name) === q)) {
    items.push({ kind: "create", name, label: `「${name}」を作成` });
  }
  if (q === "" && canClear) {
    items.push({ kind: "clear", label: "プロジェクトを外す" });
  }
  return items;
}

/**
 * 候補の開閉の状態（行から広がる候補で共通の RowPicker。⇧P の優先度と e の工数も同じものを使う）。
 * 複数のタスクにかけるとき（7 の複数選択）は、候補を1回だけ開き、決めたものをすべてに付ける
 */
export { type PickerSession, RowPicker as ProjectPicker };

const pickers = new WeakMap<ListUi, RowPicker>();

export function projectPickerOf(ui: ListUi): RowPicker {
  let picker = pickers.get(ui);
  if (!picker) {
    picker = new RowPicker(ui);
    pickers.set(ui, picker);
  }
  return picker;
}

const popup = defer(() => import("./picker-popup").then((module) => module.ProjectPickerPopup));

/** 候補の入力欄の読み上げ名と、何も打っていないときの案内（待ちの欄と同じにする） */
export const PICKER_LABEL = "プロジェクト";

export function pickerPlaceholder(taskIds: readonly string[]): string {
  return taskIds.length > 1 ? `${taskIds.length}件のプロジェクト` : "プロジェクト名";
}

/** 行の右側の枠に置く。そのタスクの候補を開いているとき（と、閉じる途中）だけ描く（tasks/row-picker.tsx） */
export function ProjectPickerHost({
  task,
  detached,
}: {
  task: TaskRow;
  /** 小さな詳細の中に置いた枠（小さな詳細から開いた候補だけを描く） */
  detached?: boolean;
}) {
  return (
    <RowPickerHost
      task={task}
      picker={projectPickerOf(useUi())}
      popup={popup}
      label={PICKER_LABEL}
      placeholder={pickerPlaceholder}
      detached={detached}
    />
  );
}
