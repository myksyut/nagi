import { autorun } from "mobx";
import { observer } from "mobx-react-lite";
import { AnimatePresence, m, useIsPresent } from "motion/react";
import { memo, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef } from "react";
import {
  type BoardPoints,
  type ProjectBoard as ProjectBoardLists,
  type TaskRow,
  type TodayBoard as TodayBoardLists,
  useStore,
} from "@/data";
import {
  isArchivedProject,
  projectAddTo,
  projectScreenKey,
} from "@/features/projects/project-view";
import { sortSections } from "@/features/sort/state";
import { DURATION, LAYOUT_TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AddHint } from "@/tasks/add-hint";
import { AddRow } from "@/tasks/add-row";
import { toggleComplete } from "@/tasks/commands";
import { CompleteButton } from "@/tasks/complete-button";
import { dragOverRow, dropOnRow, taskDragOf, useTaskDropTarget } from "@/tasks/drag";
import { rowMetaItems } from "@/tasks/extensions";
import type { AddTarget, ListView, TaskSection } from "@/tasks/list-ui";
import { TaskDetailFields, TitleInput } from "@/tasks/task-detail";
import { taskRowId } from "@/tasks/task-item";
import { useListView, useUi } from "@/tasks/ui-context";
import { type ColumnKey, moveToColumn, startCardDrag } from "./commands";

/**
 * ボード（後から読み込む）：今日と各プロジェクトのタスクを、状態の列（未着手・進行中・完了）で見る。
 * 一覧の状態（選択・開いているタスク・追加欄）はリストと同じ ListUi で持ち、まとまりに列（column）を付けて渡す。
 * ↑↓ は列の中、←→ で列を移る（ListUi）。x・s・t などのキーは、リストと同じ割り当てが選んでいるカードに働く。
 * カードを別の列へドラッグすると状態が変わる（commands.ts）。列の中のドラッグと ⌥↑↓ は、リストで並べ替えられる
 * まとまりの中だけで並べ替える。見出しの並び方（features/sort。リストと同じ）が手動以外なら、並べ替えられるまとまりの中を
 * 優先度や工数の順に並べて見せ、⌥↑↓ と列の中のドラッグは止める（ほかの列へのドラッグは止めない）。
 * 列の見出しに、件数の横にその列の工数の合計を出す
 */

const COLUMNS: readonly { key: ColumnKey; label: string }[] = [
  { key: "notStarted", label: "未着手" },
  { key: "inProgress", label: "進行中" },
  { key: "completed", label: "完了" },
];

/** 今日のボード：今日のタスクを状態で分ける。完了の列は、今日完了したもの */
function todaySections(board: TodayBoardLists): TaskSection[] {
  return [
    { key: "notStarted", column: "notStarted", rows: board.notStarted, reorderable: true },
    { key: "inProgress", column: "inProgress", rows: board.inProgress, reorderable: true },
    { key: "completed", column: "completed", rows: board.completed },
  ];
}

/**
 * プロジェクトのボード：そのプロジェクトのタスク全部。未着手の列は今日・予定・あとで・受信箱のまとまりで並べ
 * （今日とあとでの中だけ並べ替えられる。リストと同じ）、完了の列は直近 7 日に完了したもの
 */
function projectSections(board: ProjectBoardLists): TaskSection[] {
  const { today, scheduled, later, inbox } = board.notStarted;
  return [
    { key: "today", column: "notStarted", heading: "今日", rows: today, reorderable: true },
    { key: "scheduled", column: "notStarted", heading: "予定", rows: scheduled },
    { key: "later", column: "notStarted", heading: "あとで", rows: later, reorderable: true },
    { key: "inbox", column: "notStarted", heading: "受信箱", rows: inbox },
    { key: "inProgress", column: "inProgress", rows: board.inProgress, reorderable: true },
    { key: "completed", column: "completed", rows: board.completed },
  ];
}

const TODAY_ADD_TO: AddTarget = { bucket: "today", label: "今日に追加" };

export const TodayBoard = observer(function TodayBoard() {
  const store = useStore();
  const ui = useUi();
  const view = useListView(() => ({
    key: "today",
    kind: "today",
    sections: () => sortSections(ui, "today", todaySections(store.lists.todayBoard)),
    addTo: TODAY_ADD_TO,
    addInSection: "notStarted",
  }));
  return <Board view={view} label="今日のボード" points={() => store.lists.todayBoardPoints} />;
});

export const ProjectBoard = observer(function ProjectBoard({ projectId }: { projectId: string }) {
  const store = useStore();
  const ui = useUi();
  const view = useListView(() => ({
    key: projectScreenKey(projectId),
    kind: "project",
    sections: () =>
      sortSections(
        ui,
        projectScreenKey(projectId),
        projectSections(store.lists.projectBoard(projectId)),
      ),
    // リストと同じ行き先（そのプロジェクトの「あとで」。アーカイブ済みなら受信箱で、未着手の列の一番上に開く）
    get addTo(): AddTarget {
      return projectAddTo(store, projectId);
    },
    get addInSection() {
      return isArchivedProject(store, projectId) ? undefined : "later";
    },
  }));
  const name = store.project(projectId)?.name ?? "";
  return (
    <Board
      view={view}
      label={`${name}のボード`}
      points={() => store.lists.projectBoardPoints(projectId)}
    />
  );
});

/**
 * ボード全体（listbox）。列は listbox の中のまとまり（group）で、カードが選べる行（option）。
 * points は列ごとの工数の合計を読む（列の見出しの中でだけ読む）
 */
const Board = observer(function Board({
  view,
  label,
  points,
}: {
  view: ListView;
  label: string;
  points: () => BoardPoints;
}) {
  const ui = useUi();
  const sections = view.sections();
  const adding = ui.adding && ui.view === view;
  // 追加欄を開く列（開くまとまりの列。まとまりを決めていなければ未着手の列の一番上）
  const addColumn = adding
    ? (sections.find((section) => section.key === view.addInSection)?.column ?? "notStarted")
    : undefined;
  const boardRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      ui.registerListElement(element);
      // 選んでいるカードを指す（選択が動くたびにボードを描き直さないよう、属性だけを書き換える）
      const dispose = autorun(() => {
        const id = ui.selected?.id;
        if (id === undefined) element.removeAttribute("aria-activedescendant");
        else element.setAttribute("aria-activedescendant", taskRowId(id));
      });
      return () => {
        dispose();
        ui.registerListElement(null);
      };
    },
    [ui],
  );

  return (
    <div
      ref={boardRef}
      role="listbox"
      aria-label={label}
      aria-multiselectable="true"
      tabIndex={0}
      // 運んでいるカードがボードの外へ出たら、並べ替えの落とし先の線を消す
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          taskDragOf(ui).clearTarget();
        }
      }}
      className={cn(
        "group/list mt-6.5 grid grid-cols-3 gap-3.5 rounded-lg outline-none",
        // 選ぶ前に Tab で入ったときはボードそのものに輪郭を出す（選んでいれば、選んでいるカードに出す）
        "[&:focus-visible:not([aria-activedescendant])]:ring-2 [&:focus-visible:not([aria-activedescendant])]:ring-ring/60 [&:focus-visible:not([aria-activedescendant])]:ring-offset-4 [&:focus-visible:not([aria-activedescendant])]:ring-offset-background",
      )}
    >
      {COLUMNS.map((column) => (
        <Column
          key={column.key}
          column={column.key}
          label={column.label}
          sections={sections.filter((section) => section.column === column.key)}
          view={view}
          adding={addColumn === column.key}
          points={points}
        />
      ))}
    </div>
  );
});

type Item =
  | { type: "heading"; key: string; heading: string; first: boolean }
  | { type: "card"; key: string; task: TaskRow }
  | { type: "add"; key: string }
  | { type: "empty"; key: string };

/**
 * 1つの列：見出し（状態の印・名前・件数・工数の合計）と、カード。別の列から運んできたカードを落とすと、状態が変わる。
 * 追加欄は、開くまとまりの一番下（まとまりを決めていなければ列の一番上）に開く
 */
const Column = observer(function Column({
  column,
  label,
  sections,
  view,
  adding,
  points,
}: {
  column: ColumnKey;
  label: string;
  sections: readonly TaskSection[];
  view: ListView;
  adding: boolean;
  points: () => BoardPoints;
}) {
  const ui = useUi();
  const drag = taskDragOf(ui);
  // 運んでいるカードの列（運んでいるカードは、どれも同じ列から来る。commands.ts の startCardDrag）
  const first = drag.ids?.[0];
  const from = first === undefined ? undefined : (ui.columnOf(first) as ColumnKey | undefined);
  const { over, dropProps } = useTaskDropTarget(
    from !== undefined && from !== column
      ? (ids) => {
          const result = moveToColumn(ui, ids, from, column);
          // 落としたカードを選んだままにする（完了の列へ落としても、次のカードへは移らない）
          const [dropped] = ids;
          if (result?.ok && dropped !== undefined && ui.rows.some((row) => row.id === dropped)) {
            ui.select(dropped);
          }
          ui.focusList();
        }
      : null,
  );

  const count = sections.reduce((total, section) => total + section.rows.length, 0);
  const items: Item[] = [];
  if (adding && !sections.some((section) => section.key === view.addInSection)) {
    items.push({ type: "add", key: "add" });
  }
  for (const section of sections) {
    if (section.heading && section.rows.length > 0) {
      items.push({
        type: "heading",
        key: `heading:${section.key}`,
        heading: section.heading,
        first: items.length === 0,
      });
    }
    for (const task of section.rows) items.push({ type: "card", key: task.id, task });
    if (adding && section.key === view.addInSection) items.push({ type: "add", key: "add" });
  }
  if (count === 0 && !adding && column === "notStarted")
    items.push({ type: "empty", key: "empty" });

  // 前に描いた並びと比べて、最初に変わった項目。そこから下の LAYOUT_WINDOW 項目だけ、位置の変化を動かす
  const committedKeys = useRef<readonly string[]>([]);
  const keys = items.map((item) => item.key);
  let firstChange = keys.findIndex((key, i) => committedKeys.current[i] !== key);
  if (firstChange < 0) firstChange = keys.length;
  useLayoutEffect(() => {
    committedKeys.current = keys;
  });

  return (
    // biome-ignore lint/a11y/useSemanticElements: ボード（listbox）の中の列のまとまり
    <div
      role="group"
      aria-label={label}
      {...dropProps}
      className={cn(
        "relative flex min-h-40 min-w-0 flex-col gap-2 rounded-xl border bg-muted/50 p-2.5",
        over && "bg-primary/10 outline-1 -outline-offset-1 outline-primary/60",
      )}
    >
      <div className="flex items-center gap-2 px-1 pt-0.5 pb-1.5 font-semibold text-[13px] text-sidebar-foreground">
        <ColumnGlyph column={column} />
        {label}
        <span className="font-normal text-faint-foreground tabular-nums">{count}</span>
        <ColumnPoints read={() => points()[column]} />
      </div>
      <AnimatePresence initial={false} mode="popLayout" presenceAffectsLayout={false}>
        {positioned(items).map(({ item, position }, index) => (
          <ColumnItem
            key={item.key}
            item={item}
            position={position}
            animate={index >= firstChange && index < firstChange + LAYOUT_WINDOW}
            view={view}
          />
        ))}
      </AnimatePresence>
    </div>
  );
});

/**
 * 列の見出しの工数の合計（「・ 工数 8」。工数のあるカードがなければ出さない）。
 * ここでだけ読む（工数が変わっても、描き直すのはこの小さな部品だけ）
 */
const ColumnPoints = observer(function ColumnPoints({ read }: { read: () => number }) {
  const points = read();
  if (points === 0) return null;
  return <span className="font-normal text-faint-foreground tabular-nums">・ 工数 {points}</span>;
});

/** 列の見出しの印（未着手は空の丸、進行中は半分が紫、完了は埋まった丸）。完了の丸と同じ見た目を小さくしたもの */
function ColumnGlyph({ column }: { column: ColumnKey }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 flex-none rounded-full border-[1.6px]",
        column === "notStarted" && "border-(--circle)",
        column === "inProgress" && "status-in-progress",
        column === "completed" && "border-(--circle) bg-(--circle)",
      )}
    />
  );
}

/** 位置の変化を動かす項目の数（TaskList と同じ考え方。それより下は描き直さずにそのまま詰める） */
const LAYOUT_WINDOW = 40;

/** 項目ごとの「上から何番目か」。追加欄は数えない（追加欄を開いても、下のカードを動かさない） */
function positioned(items: readonly Item[]): { item: Item; position: number }[] {
  let position = 0;
  return items.map((item) => ({ item, position: item.type === "add" ? -1 : position++ }));
}

const ITEM_INITIAL = { opacity: 0 };
const ITEM_ANIMATE = { opacity: 1 };
const ITEM_EXIT = { opacity: 0, transition: { duration: DURATION.exit } };
const ITEM_TRANSITION = { ...LAYOUT_TRANSITION, opacity: { duration: DURATION.short } };

function sameItem(a: Item, b: Item): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  switch (a.type) {
    case "card":
      return b.type === "card" && a.task === b.task;
    case "heading":
      return b.type === "heading" && a.first === b.first && a.heading === b.heading;
    case "add":
    case "empty":
      return true;
  }
}

/**
 * 列の1項目（Motion の layout アニメーションの単位）。カードが別の列へ移ると、下のカードが詰まる。
 * 位置の変わらないカードは、ほかのカードの出入りで描き直さない
 */
const ColumnItem = memo(
  function ColumnItem({
    item,
    position,
    view,
  }: {
    item: Item;
    position: number;
    animate: boolean;
    view: ListView;
  }) {
    return (
      <m.div
        layout="position"
        layoutDependency={position}
        initial={ITEM_INITIAL}
        animate={ITEM_ANIMATE}
        exit={ITEM_EXIT}
        transition={ITEM_TRANSITION}
      >
        <ItemView item={item} view={view} />
      </m.div>
    );
  },
  (a, b) =>
    (!b.animate || a.position === b.position) && a.view === b.view && sameItem(a.item, b.item),
);

function ItemView({ item, view }: { item: Item; view: ListView }): ReactNode {
  switch (item.type) {
    case "card":
      return <Card task={item.task} view={view} />;
    case "add":
      return <AddRow view={view} />;
    case "heading":
      return (
        <h3 className={cn("px-1 font-medium text-faint-foreground text-xs", !item.first && "mt-2")}>
          {item.heading}
        </h3>
      );
    case "empty":
      return (
        <div className="px-1 py-6 text-center">
          <AddHint />
        </div>
      );
  }
}

/**
 * カードの外側。抜けていく途中のカードは、読み上げとクリックの対象から外す。
 * 列の中の並べ替えの落とし先も、開いた欄を含めたここで受ける（別の列から来たカードは、列が受ける）
 */
function Card({ task, view }: { task: TaskRow; view: ListView }) {
  const ui = useUi();
  const present = useIsPresent();
  return (
    <div
      className={cn(!present && "pointer-events-none")}
      aria-hidden={present ? undefined : true}
      onDragOver={(event) => dragOverRow(ui, task.id, event)}
      onDrop={(event) => {
        // 並べ替えの落とし先があるとき（と、並び方で並べ替えて見せている同じまとまりの上で、知らせるとき）だけ受ける
        // （ないときは列へ任せる。別の列から来たカードなど）
        const drag = taskDragOf(ui);
        if (drag.target || drag.blocked) dropOnRow(ui, event);
      }}
    >
      <CardView task={task} view={view} present={present} />
    </div>
  );
}

/**
 * カード：完了の丸・タイトル、その下に行の右側と同じ情報（プロジェクト（今日のボードだけ）・チェックリストの進み具合・
 * メモの印・締切）。選んだカードは行と同じ光で示す。Enter かクリックで、カードの下に詳細が広がる（中身はリストと同じ）
 */
const CardView = observer(function CardView({
  task,
  view,
  present,
}: {
  task: TaskRow;
  view: ListView;
  present: boolean;
}) {
  const ui = useUi();
  const drag = taskDragOf(ui);
  const selected = ui.isSelected(task.id);
  const cursor = ui.isCursor(task.id);
  const open = ui.isOpen(task.id);
  const done = task.completedAt !== null;
  const dropEdge = drag.edgeOf(task.id);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cursor) card.current?.scrollIntoView?.({ block: "nearest" });
  }, [cursor]);

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: キーの操作（Enter で開く）はキーマップがボード（listbox）で受ける */}
      {/* biome-ignore lint/a11y/useFocusableInteractive: フォーカスはボード（listbox）が持ち、カードは aria-activedescendant で指す */}
      <div
        ref={card}
        id={taskRowId(task.id)}
        role="option"
        aria-selected={selected}
        data-selected={selected || undefined}
        data-cursor={cursor || undefined}
        data-status={task.status}
        // 開いているカード（タイトルの入力欄がある）はつかめない。完了のカードは、ほかの列へ運べる
        draggable={present && !open}
        className={cn(
          "relative flex cursor-default flex-col gap-1.5 rounded-[10px] border px-3 py-2.5 text-sm",
          // 選んだカードは行と同じ紫の淡い背景と細い輪郭の光。ほかは面と下のやわらかい影（どちらも即時。動かさない）
          selected ? "row-selected" : "bg-card shadow-lg shadow-black/25 hover:bg-accent",
          done && !selected && "opacity-60",
          drag.isDragging(task.id) && "opacity-50",
          // フォーカスの輪郭は outline で、選んだカードの光（box-shadow）の外側に別に出す
          "group-focus-visible/list:data-cursor:outline-2 group-focus-visible/list:data-cursor:outline-offset-2 group-focus-visible/list:data-cursor:outline-ring",
        )}
        onClick={(event) => {
          // ⌘クリックで1枚ずつ選択に足す・外す
          if (event.metaKey) ui.toggleInSelection(task.id);
          else ui.toggleOpen(task.id);
          ui.focusList();
        }}
        onDragStart={(event) => startCardDrag(ui, task, event)}
        onDragEnd={() => drag.end()}
      >
        {dropEdge && (
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-primary-text",
              dropEdge === "before" ? "-top-[5px]" : "-bottom-[5px]",
            )}
          />
        )}
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex pt-px">
            <CompleteButton
              taskId={task.id}
              done={done}
              inProgress={task.isInProgress}
              title={task.title}
              onToggle={() => toggleComplete(ui, [task.id])}
            />
          </span>
          {open ? (
            <TitleInput task={task} />
          ) : (
            <span
              className={cn(
                "min-w-0 flex-1 break-words leading-5",
                done && "text-muted-foreground line-through decoration-(--circle)",
              )}
            >
              {task.title}
            </span>
          )}
        </div>
        <CardMeta task={task} view={view} />
      </div>
      {open && present && (
        // biome-ignore lint/a11y/useSemanticElements: ボード（listbox）の中の、開いたカードの欄のまとまり
        <div
          role="group"
          aria-label={`「${task.title}」の詳細`}
          className="mt-1.5 flex flex-col gap-3 rounded-[10px] border bg-card px-3 py-3"
        >
          <TaskDetailFields task={task} view={view} />
        </div>
      )}
    </>
  );
});

/**
 * カードの下の小さな情報。行の右側に登録された項目（registerRowMeta）をそのまま並べる
 * （日付の入力と p の候補も、この枠からカードを起点に開く）
 */
function CardMeta({ task, view }: { task: TaskRow; view: ListView }) {
  const items = rowMetaItems();
  if (items.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-[27px] text-muted-foreground text-xs empty:hidden">
      {items.map(({ id, Component }) => (
        <Component key={id} task={task} view={view} />
      ))}
    </span>
  );
}
