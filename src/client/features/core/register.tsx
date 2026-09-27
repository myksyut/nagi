import { NotepadTextIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import type { TaskRow } from "@/data";
import { type KeyBinding, type KeyContext, registerKeyBindings } from "@/keyboard/keymap";
import { BUCKET_LISTS, LOGBOOK } from "@/navigation";
import {
  deleteTasks,
  moveSelectedRows,
  moveTasks,
  openRowsOf,
  selectionForOperation,
  toggleComplete,
  undo,
} from "@/tasks/commands";
import { ROW_META_ORDER, registerRowMeta, type TaskSlotProps } from "@/tasks/extensions";
import { titleInputId } from "@/tasks/task-detail";

/**
 * 4 の登録：毎日の流れのキーと、行の右側の「メモの印」。
 * 5・6 も同じ形で、features/<名前>/register.ts(x) から登録する。
 * タスクへの操作（x・t・l・⌘⌫）は、選んでいるすべての行に1つの操作としてかける（7 の複数選択）
 */

const selectedTask = ({ ui }: KeyContext) => ui.selected;
const hasOpenSelected = ({ ui }: KeyContext) =>
  ui.selectedRows.some((row) => row.completedAt === null);

/** 選んでいる行への操作。選択が 500 件を超えていたら、実行せずに知らせる */
function onSelection(run: (context: KeyContext, rows: readonly TaskRow[]) => void) {
  return (context: KeyContext) => {
    const rows = selectionForOperation(context.ui);
    if (rows && rows.length > 0) run(context, rows);
  };
}

const ids = (rows: readonly TaskRow[]) => rows.map((row) => row.id);

const LIST_KEYS = ["1", "2", "3", "4", "5"] as const;

export const CORE_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "list.down",
    label: "下へ",
    group: "移動",
    keys: ["ArrowDown", "j"],
    repeat: true,
    when: ({ ui }) => ui.rows.length > 0,
    run: ({ ui }) => {
      ui.moveSelection(1);
      ui.focusList();
    },
  },
  {
    id: "list.up",
    label: "上へ",
    group: "移動",
    keys: ["ArrowUp", "k"],
    repeat: true,
    when: ({ ui }) => ui.rows.length > 0,
    run: ({ ui }) => {
      ui.moveSelection(-1);
      ui.focusList();
    },
  },
  {
    id: "list.extendDown",
    label: "選択を下へ広げる",
    group: "移動",
    keys: ["Shift+ArrowDown"],
    repeat: true,
    when: ({ ui }) => ui.rows.length > 0,
    run: ({ ui }) => {
      ui.extendSelection(1);
      ui.focusList();
    },
  },
  {
    id: "list.extendUp",
    label: "選択を上へ広げる",
    group: "移動",
    keys: ["Shift+ArrowUp"],
    repeat: true,
    when: ({ ui }) => ui.rows.length > 0,
    run: ({ ui }) => {
      ui.extendSelection(-1);
      ui.focusList();
    },
  },
  {
    id: "task.moveUp",
    label: "並べ替え（上へ）",
    group: "タスク",
    keys: ["Alt+ArrowUp"],
    repeat: true,
    when: ({ ui }) => ui.reorderableSectionOf(ui.selectedIds) !== undefined,
    run: ({ ui }) => {
      moveSelectedRows(ui, -1);
    },
  },
  {
    id: "task.moveDown",
    label: "並べ替え（下へ）",
    group: "タスク",
    keys: ["Alt+ArrowDown"],
    repeat: true,
    when: ({ ui }) => ui.reorderableSectionOf(ui.selectedIds) !== undefined,
    run: ({ ui }) => {
      moveSelectedRows(ui, 1);
    },
  },
  {
    id: "task.add",
    label: "追加",
    group: "タスク",
    keys: ["n"],
    when: ({ ui }) => ui.view !== null,
    run: ({ ui }) => ui.startAdding(),
  },
  {
    id: "task.open",
    label: "開く",
    group: "タスク",
    keys: ["Enter"],
    when: (context) => selectedTask(context) !== undefined,
    run: (context) => {
      const task = selectedTask(context);
      if (!task) return;
      // 開いているタスクでもう一度 Enter を押すと、タイトルを直せる
      if (context.ui.isOpen(task.id)) document.getElementById(titleInputId(task.id))?.focus();
      else context.ui.open(task.id);
    },
  },
  {
    id: "task.close",
    label: "閉じる",
    group: "タスク",
    keys: ["Escape"],
    when: ({ ui }) => ui.openId !== null || ui.selectedId !== null,
    run: ({ ui }) => {
      if (ui.openId !== null) {
        ui.close();
        ui.focusList();
      } else {
        ui.select(null);
      }
    },
  },
  {
    id: "task.complete",
    label: "完了（もう一度で戻す）",
    group: "タスク",
    keys: ["x"],
    when: (context) => selectedTask(context) !== undefined,
    run: onSelection(({ ui }, rows) => {
      toggleComplete(ui, ids(rows));
    }),
  },
  {
    id: "task.today",
    label: "今日へ",
    group: "いつやる",
    keys: ["t"],
    when: hasOpenSelected,
    run: onSelection(({ ui }, rows) => {
      moveTasks(ui, ids(openRowsOf(rows)), "today");
    }),
  },
  {
    id: "task.later",
    label: "あとでへ",
    group: "いつやる",
    keys: ["l"],
    when: hasOpenSelected,
    run: onSelection(({ ui }, rows) => {
      moveTasks(ui, ids(openRowsOf(rows)), "later");
    }),
  },
  {
    id: "task.delete",
    label: "削除",
    group: "タスク",
    keys: ["Mod+Backspace"],
    when: (context) => selectedTask(context) !== undefined,
    run: onSelection(({ ui }, rows) => {
      deleteTasks(ui, ids(rows));
    }),
  },
  {
    id: "undo",
    label: "元に戻す",
    group: "タスク",
    keys: ["Mod+z"],
    when: ({ store }) => store.canUndo,
    run: ({ ui }) => {
      undo(ui);
    },
  },
  ...[...BUCKET_LISTS, LOGBOOK].map(
    (list, i): KeyBinding => ({
      id: `go.${list.key}`,
      label: `${list.label}を開く`,
      group: "リスト",
      keys: [LIST_KEYS[i] ?? String(i + 1)],
      allowBeforeLoad: true,
      run: ({ navigate }) => navigate(list.path),
    }),
  ),
];

registerKeyBindings(CORE_KEY_BINDINGS);

/** 行の右側：メモがある印 */
const MemoMark = observer(function MemoMark({ task }: TaskSlotProps) {
  if (task.memo.trim() === "") return null;
  return <NotepadTextIcon role="img" aria-label="メモあり" className="size-3.5" />;
});

registerRowMeta({ id: "memo", order: ROW_META_ORDER.memo, Component: MemoMark });

// 開いたタスクの「いつやる」の小さなボタンは、日付と一緒に features/dates で登録する
