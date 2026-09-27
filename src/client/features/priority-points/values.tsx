import { PRIORITY_LABELS, type Priority } from "@shared/priority-points";

/**
 * 優先度と工数の名前と、優先度の印。起動に要る行の右側（register.tsx）と、後から読み込む候補とボタン（parts.tsx）の
 * 両方が使う（ほかのモジュールを読み込まない小さなモジュールにして、後から読み込む側が起動の JS の分け方を変えないように）
 */

export type ValueKind = "priority" | "points";

/** 候補とボタンの名前（候補の入力欄の読み上げ名。待ちの欄と同じにする） */
export const VALUE_LABELS: Readonly<Record<ValueKind, string>> = {
  priority: "優先度",
  points: "工数",
};

/** 候補の入力欄の、何も打っていないときの案内（複数のタスクにかけるときは件数を添える） */
export function valuePlaceholder(kind: ValueKind, taskIds: readonly string[]): string {
  const label = VALUE_LABELS[kind];
  return taskIds.length > 1 ? `${taskIds.length}件の${label}` : label;
}

/**
 * 優先度の印：3本の棒のうち、高は3本・中は2本・低は1本を塗る（色だけに頼らず、形でも分かるように）。
 * 高だけ琥珀で、中と低は控えめな灰（赤は使わない）。形と色は styles.css の priority-mark
 */
export function PriorityMark({ priority }: { priority: Priority }) {
  const label = `優先度 ${PRIORITY_LABELS[priority]}`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-priority={priority}
      className="priority-mark"
    />
  );
}
