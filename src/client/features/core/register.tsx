import { NotepadTextIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { type KeyBinding, type KeyContext, registerKeyBindings } from "@/keyboard/keymap";
import { BUCKET_LISTS, LOGBOOK } from "@/navigation";
import { deleteTasks, moveTasks, toggleComplete, undo } from "@/tasks/commands";
import {
  DETAIL_ORDER,
  ROW_META_ORDER,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { chipClassName, titleInputId } from "@/tasks/task-detail";

/**
 * 4 の登録：毎日の流れのキー、行の右側の「メモの印」、開いたタスクの「いつやる」の表示。
 * 5・6 も同じ形で、features/<名前>/register.ts(x) から登録する
 */

const selectedTask = ({ ui }: KeyContext) => ui.selected;
const selectedOpenTask = (context: KeyContext) => {
  const task = selectedTask(context);
  return task && task.completedAt === null ? task : undefined;
};

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
    run: (context) => {
      const task = selectedTask(context);
      if (task) toggleComplete(context.ui, [task.id]);
    },
  },
  {
    id: "task.today",
    label: "今日へ",
    group: "いつやる",
    keys: ["t"],
    when: (context) => selectedOpenTask(context) !== undefined,
    run: (context) => {
      const task = selectedOpenTask(context);
      if (task) moveTasks(context.ui, [task.id], "today");
    },
  },
  {
    id: "task.later",
    label: "あとでへ",
    group: "いつやる",
    keys: ["l"],
    when: (context) => selectedOpenTask(context) !== undefined,
    run: (context) => {
      const task = selectedOpenTask(context);
      if (task) moveTasks(context.ui, [task.id], "later");
    },
  },
  {
    id: "task.delete",
    label: "削除",
    group: "タスク",
    keys: ["Mod+Backspace"],
    when: (context) => selectedTask(context) !== undefined,
    run: (context) => {
      const task = selectedTask(context);
      if (task) deleteTasks(context.ui, [task.id]);
    },
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

const BUCKET_LABELS = {
  inbox: "受信箱",
  today: "今日",
  scheduled: "予定",
  later: "あとで",
} as const;

/** 開いたタスクの一番下の列：いつやる（表示だけ。変えるのは t・l、日付は 5 の d） */
const WhenChip = observer(function WhenChip({ task }: TaskSlotProps) {
  return (
    <span className={chipClassName}>
      {task.completedAt !== null ? "完了" : BUCKET_LABELS[task.bucket]}
    </span>
  );
});

registerDetailField({
  id: "when",
  placement: "chip",
  order: DETAIL_ORDER.when,
  Component: WhenChip,
});
