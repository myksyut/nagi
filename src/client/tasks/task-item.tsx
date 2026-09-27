import { observer } from "mobx-react-lite";
import { useIsPresent } from "motion/react";
import { useEffect, useRef } from "react";
import { type TaskRow, useStore } from "@/data";
import { cn } from "@/lib/utils";
import { toggleComplete } from "./commands";
import { CompleteButton } from "./complete-button";
import { dragOverRow, dropOnRow, startRowDrag, taskDragOf } from "./drag";
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
 * Motion の抜けていく状態の文脈は一覧を描くたびに変わるので、ここ（軽い殻）だけで受け、行の中身には値で渡す。
 * ドラッグの並べ替えの落とし先も、開いた欄を含めたここで受ける
 */
export function TaskItem({ task, view }: { task: TaskRow; view: ListView }) {
  const ui = useUi();
  const present = useIsPresent();
  return (
    <div
      className={cn(!present && "pointer-events-none")}
      aria-hidden={present ? undefined : true}
      onDragOver={(event) => dragOverRow(ui, task.id, event)}
      onDrop={(event) => dropOnRow(ui, event)}
    >
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
  const drag = taskDragOf(ui);
  const selected = ui.isSelected(task.id);
  // 選択のカーソル（↑↓ の起点）。フォーカスの輪郭はこの行にだけ出す
  const cursor = ui.isCursor(task.id);
  const open = ui.isOpen(task.id);
  const done = task.completedAt !== null;
  const arrived = !done && store.lists.isArrivedToday(task);
  const dropEdge = drag.edgeOf(task.id);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cursor) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

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
        data-cursor={cursor || undefined}
        // 開いている行（タイトルの入力欄がある）と完了した行はつかめない
        draggable={present && !open && !done}
        className={cn(
          "relative flex min-h-10 cursor-default items-center gap-3 rounded-[10px] px-3 py-2 text-sm",
          // 選んだ行は紫の淡い背景と細い輪郭の光。ホバーは白をわずかに重ねる（どちらも即時。動かさない）
          selected ? "row-selected" : "hover:bg-(--row-hover)",
          drag.isDragging(task.id) && "opacity-50",
          // フォーカスの輪郭は outline で、選んだ行の光（box-shadow）の外側に別に出す
          "group-focus-visible/list:data-cursor:outline-2 group-focus-visible/list:data-cursor:outline-offset-2 group-focus-visible/list:data-cursor:outline-ring",
        )}
        onClick={(event) => {
          // ⌘クリックで1行ずつ選択に足す・外す
          if (event.metaKey) ui.toggleInSelection(task.id);
          else ui.toggleOpen(task.id);
          ui.focusList();
        }}
        onDragStart={(event) => startRowDrag(ui, task, event)}
        onDragEnd={() => drag.end()}
      >
        {dropEdge && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary-text",
              dropEdge === "before" ? "-top-px" : "-bottom-px",
            )}
          />
        )}
        <CompleteButton
          taskId={task.id}
          done={done}
          inProgress={task.isInProgress}
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
        <RowMeta task={task} view={view} arrived={arrived} />
      </div>
      {open && present && <TaskDetail task={task} view={view} />}
    </>
  );
});

/**
 * 行の右側の情報の枠。項目は registerRowMeta で足す（extensions.ts）。
 * 先頭に「今日来た」の印（日付の到来や締切で今日に入った日のあいだ）
 */
function RowMeta({ task, view, arrived }: { task: TaskRow; view: ListView; arrived: boolean }) {
  const items = rowMetaItems();
  if (items.length === 0 && !arrived) return null;
  return (
    <span className="ml-auto flex flex-none items-center gap-2.5 whitespace-nowrap text-muted-foreground text-xs empty:hidden">
      {arrived && <ArrivedMark />}
      {items.map(({ id, Component }) => (
        <Component key={id} task={task} view={view} />
      ))}
    </span>
  );
}

/**
 * 「今日来た」の小さな印（琥珀の枠）。文字は CSS で出す（行の文字（textContent）はタイトルと右側の情報のまま）。
 * 読み上げは「今日来たタスク」
 */
function ArrivedMark() {
  return (
    <span
      role="img"
      aria-label="今日来たタスク"
      data-label="今日来た"
      className="rounded-md border border-(--list-today)/35 px-1.5 text-(--list-today) text-[10px] leading-4 after:content-[attr(data-label)]"
    />
  );
}
