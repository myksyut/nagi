import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { type KeyBinding, type KeyContext, registerKeyBindings } from "@/keyboard/keymap";
import { cn } from "@/lib/utils";
import { openRowsOf, selectionForOperation } from "@/tasks/commands";
import {
  DETAIL_ORDER,
  ROW_META_ORDER,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { chipClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import { type DateEntryKind, DateEntryPopover, dateEntryOf } from "./date-entry";
import { deadlineStatus, formatLongDate, formatShortDateWithWeekday } from "./labels";

/**
 * 5 の登録：d（日付を決めて予定へ）と ⇧D（締切）のキー、行の右側の締切の表示、
 * 開いたタスクの「いつやる」と「締切」の小さなボタン（押すと日付の入力が開く）。
 * d・⇧D は、選んでいるすべての未完了の行にかける（7 の複数選択）
 */

const hasOpenSelected = ({ ui }: KeyContext) =>
  ui.selectedRows.some((row) => row.completedAt === null);

/**
 * 選んでいる未完了の行に、日付の入力を1回だけ開く（決めた日付をすべての行にかける。先頭の行から広がる）。
 * 選択が 500 件を超えていたら、開かずに知らせる
 */
function openDateEntry(kind: DateEntryKind) {
  return ({ ui }: KeyContext) => {
    const rows = selectionForOperation(ui);
    const ids = openRowsOf(rows ?? []).map((row) => row.id);
    if (ids.length > 0) dateEntryOf(ui).open(kind, ids, ui.view);
  };
}

export const DATE_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "task.schedule",
    label: "日付を決めて予定へ",
    group: "いつやる",
    keys: ["d"],
    when: hasOpenSelected,
    run: openDateEntry("schedule"),
  },
  {
    id: "task.deadline",
    label: "締切",
    group: "いつやる",
    keys: ["Shift+d"],
    when: hasOpenSelected,
    run: openDateEntry("deadline"),
  },
];

registerKeyBindings(DATE_KEY_BINDINGS);

/**
 * 行の右側：締切（4日以上先は「締切 10/2」、3日以内は「あと N 日」、当日は「今日まで」、過ぎたら「N 日超過」）。
 * 完了したタスクと完了ログでは出さない。日付の入力のポップオーバーも、対象の行ではここから描く
 */
const DeadlineMeta = observer(function DeadlineMeta({ task, view }: TaskSlotProps) {
  const ui = useUi();
  const host = dateEntryOf(ui).isHost(task.id);
  const deadlineOn = task.deadlineOn;
  const show = deadlineOn !== null && task.completedAt === null && view.kind !== "logbook";
  return (
    <>
      {show && <DeadlineLabel deadlineOn={deadlineOn} />}
      {host && <DateEntryPopover task={task} view={view} />}
    </>
  );
});

const DeadlineLabel = observer(function DeadlineLabel({ deadlineOn }: { deadlineOn: string }) {
  const today = useStore().today;
  const { tone, label } = deadlineStatus(deadlineOn, today);
  return (
    <span
      title={`締切 ${formatLongDate(deadlineOn, today)}`}
      className={cn(
        (tone === "soon" || tone === "today") && "text-primary-text",
        // 赤は締切を過ぎたときの文字にだけ使う（行全体は赤くしない）
        tone === "overdue" && "text-destructive-foreground",
      )}
    >
      {label}
    </span>
  );
});

registerRowMeta({ id: "deadline", order: ROW_META_ORDER.deadline, Component: DeadlineMeta });

const BUCKET_LABELS = {
  inbox: "受信箱",
  today: "今日",
  scheduled: "予定",
  later: "あとで",
} as const;

const chipButtonClassName = cn(
  chipClassName,
  "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/70",
);

/**
 * 開いたタスクの一番下の列：いつやる（置き場と予定の日付）。押すと日付の入力が開く（今日・あとでも選べる）。
 * 完了したタスクでは「完了」と出すだけ（d・⇧D と同じく、日付の入力は開けない）
 */
const WhenChip = observer(function WhenChip({ task, view }: TaskSlotProps) {
  const ui = useUi();
  const today = useStore().today;
  if (task.completedAt !== null) return <span className={chipClassName}>完了</span>;
  const label =
    task.bucket === "scheduled" && task.scheduledOn !== null
      ? `予定 ${formatShortDateWithWeekday(task.scheduledOn, today)}`
      : BUCKET_LABELS[task.bucket];
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={`いつやる：${label}`}
      className={chipButtonClassName}
      onClick={(event) => dateEntryOf(ui).open("schedule", [task.id], view, event.currentTarget)}
    >
      {label}
    </button>
  );
});

registerDetailField({
  id: "when",
  placement: "chip",
  order: DETAIL_ORDER.when,
  Component: WhenChip,
});

/**
 * 開いたタスクの一番下の列：締切（「締切 10/2(金)」）。押すと日付の入力が開く。
 * 完了したタスクでは出さない（行の右側と同じく、完了したタスクと完了ログには締切を出さない）
 */
const DeadlineChip = observer(function DeadlineChip({ task, view }: TaskSlotProps) {
  const ui = useUi();
  const today = useStore().today;
  if (task.completedAt !== null) return null;
  const deadlineOn = task.deadlineOn;
  const label =
    deadlineOn === null ? "締切" : `締切 ${formatShortDateWithWeekday(deadlineOn, today)}`;
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={deadlineOn === null ? "締切を付ける" : label}
      className={cn(chipButtonClassName, deadlineOn === null && "border-dashed")}
      onClick={(event) => dateEntryOf(ui).open("deadline", [task.id], view, event.currentTarget)}
    >
      {label}
    </button>
  );
});

registerDetailField({
  id: "deadline",
  placement: "chip",
  order: DETAIL_ORDER.deadline,
  Component: DeadlineChip,
});
