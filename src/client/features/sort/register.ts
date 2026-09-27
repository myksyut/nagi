import { TASK_SORT_LABELS, TASK_SORTS } from "@/data";
import { registerKeyBindings } from "@/keyboard/keymap";
import type { ListKind } from "@/tasks/list-ui";
import { setSort } from "./state";

/**
 * 16 の登録：並び方の切り替え（キーはなし。⌘K の「並び方：◯◯」から選ぶ）。
 * 効くのは並び方を選べる画面（今日・あとで・プロジェクト。今日とプロジェクトはボードでも）だけ。
 * 見出しの「並び：◯◯」（sort-button.tsx）と同じ、画面ごとの並び方を変える
 */

const SORTABLE: readonly ListKind[] = ["today", "later", "project"];

registerKeyBindings(
  TASK_SORTS.map((sort) => ({
    id: `sort.${sort}`,
    label: `並び方：${TASK_SORT_LABELS[sort]}`,
    group: "リスト" as const,
    keys: [],
    when: ({ ui }) => ui.view !== null && SORTABLE.includes(ui.view.kind),
    run: ({ ui }) => {
      if (ui.view) setSort(ui, ui.view.key, sort);
    },
  })),
);
