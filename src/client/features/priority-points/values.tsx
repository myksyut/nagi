import { PRIORITY_LABELS, type Priority } from "@shared/priority-points";
import { isComposingKey } from "@/keyboard/keys";

/**
 * 優先度と工数の名前と、優先度の印。行の右側と開いたタスクのボタン（register.tsx）、候補の開閉（picker.tsx）、
 * 後から読み込む候補（parts.tsx）が使う
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

/** 優先度の候補でその場で決めるキー（1 高・2 中・3 低・0 なし） */
export const PRIORITY_KEYS = ["1", "2", "3", "0"] as const;

/**
 * 押したキーが、優先度の候補でその場で決めるキーなら、そのキー（全角の数字も読む）。
 * 変換中と修飾キー付きは当てない（候補の中でも、読み込みを待つあいだの欄でも同じ決まり）
 */
export function priorityKeyOf(
  event: Pick<
    KeyboardEvent,
    "key" | "isComposing" | "keyCode" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
  >,
): string | undefined {
  if (isComposingKey(event)) return undefined;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  const key = event.key.normalize("NFKC");
  return (PRIORITY_KEYS as readonly string[]).includes(key) ? key : undefined;
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
