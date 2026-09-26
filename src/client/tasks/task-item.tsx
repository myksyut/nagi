import { observer } from "mobx-react-lite";
import { useIsPresent } from "motion/react";
import { useEffect, useRef } from "react";
import { type TaskRow, useStore } from "@/data";
import { cn } from "@/lib/utils";
import { toggleComplete } from "./commands";
import { CompleteButton } from "./complete-button";
import { rowMetaItems } from "./extensions";
import type { ListView } from "./list-ui";
import { TaskDetail, TitleInput } from "./task-detail";
import { useUi } from "./ui-context";

/** 行の要素の id（listbox の aria-activedescendant で指す） */
export function taskRowId(taskId: string): string {
  return `task-${taskId}`;
}

/**
 * 一覧の1行の外側。抜けていく途中の行（完了・振り分けの直後の短い動きのあいだ）は、読み上げとクリックの対象から外す。
 * Motion の抜けていく状態の文脈は一覧を描くたびに変わるので、ここ（軽い殻）だけで受け、行の中身には値で渡す
 */
export function TaskItem({ task, view }: { task: TaskRow; view: ListView }) {
  const present = useIsPresent();
  return (
    <div className={cn(!present && "pointer-events-none")} aria-hidden={present ? undefined : true}>
      <TaskRowView task={task} view={view} present={present} />
    </div>
  );
}

/**
 * 1行と、開いたときに下に広がる欄。行は自分の中身と「選択中か」「開いているか」だけを観測するので、
 * ほかの行の変化や選択の移動では描き直さない
 */
const TaskRowView = observer(function TaskRowView({
  task,
  view,
  present,
}: {
  task: TaskRow;
  view: ListView;
  present: boolean;
}) {
  const ui = useUi();
  const store = useStore();
  const selected = ui.isSelected(task.id);
  const open = ui.isOpen(task.id);
  const done = task.completedAt !== null;
  const arrived = !done && store.lists.isArrivedToday(task);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [selected]);

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: キーの操作（Enter で開く）はキーマップが一覧（listbox）で受ける */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: フォーカスは一覧（listbox）が持ち、行は aria-activedescendant で指す */}
      <div
        ref={row}
        id={taskRowId(task.id)}
        role="option"
        aria-selected={selected}
        data-selected={selected || undefined}
        className={cn(
          "relative flex min-h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm",
          selected && "bg-primary/12",
          "group-focus-visible/list:data-selected:ring-1 group-focus-visible/list:data-selected:ring-ring/70",
        )}
        onClick={() => {
          ui.toggleOpen(task.id);
          ui.focusList();
        }}
      >
        {arrived && (
          <span
            role="img"
            aria-label="今日来たタスク"
            className="absolute top-1/2 -left-1 size-1.5 -translate-y-1/2 rounded-full bg-primary"
          />
        )}
        <CompleteButton
          done={done}
          title={task.title}
          onToggle={() => toggleComplete(ui, [task.id])}
        />
        {open ? (
          <TitleInput task={task} />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", done && "text-muted-foreground")}>
            {task.title}
          </span>
        )}
        <RowMeta task={task} view={view} />
      </div>
      {open && present && <TaskDetail task={task} view={view} />}
    </>
  );
});

/** 行の右側の情報の枠。項目は registerRowMeta で足す（extensions.ts） */
function RowMeta({ task, view }: { task: TaskRow; view: ListView }) {
  const items = rowMetaItems();
  if (items.length === 0) return null;
  return (
    <span className="ml-auto flex flex-none items-center gap-3 whitespace-nowrap text-muted-foreground text-xs empty:hidden">
      {items.map(({ id, Component }) => (
        <Component key={id} task={task} view={view} />
      ))}
    </span>
  );
}
