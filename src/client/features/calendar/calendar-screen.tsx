import { Menu } from "@base-ui/react/menu";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "lucide-react";
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import {
  type ComponentType,
  type DragEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import { useStore } from "@/data";
import { scheduleTasks, setDeadline } from "@/features/dates/commands";
import { formatLongDate } from "@/features/dates/labels";
import { ProjectDot } from "@/features/projects/project-dot";
import { QuickAddHost } from "@/features/quick-add/quick-add";
import { quickAddOf } from "@/features/quick-add/state";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { projectColorOf, projectColorVar } from "@/lib/project-color";
import { cn } from "@/lib/utils";
import { taskDragOf } from "@/tasks/drag";
import type { ListUi } from "@/tasks/list-ui";
import { TaskDetailPopoverHost, taskDetailPopoverOf } from "@/tasks/task-detail-popover";
import { useUi } from "@/tasks/ui-context";
import {
  type CalendarEntry,
  CalendarModel,
  effectiveFilter,
  entriesInOrder,
  locateEntry,
  monthWeeks,
  shownCount,
} from "./model";
import { type CalendarDrag, calendarOf, monthOf, type ProjectFilter } from "./state";

/**
 * カレンダーの画面（Core Flows のフロー5「カレンダー」）。後から読み込む（lazy.tsx）。
 * - 月の表（日曜始まり）。‹ › と [ ] で前後の月へ、「今日」で今月へ
 * - 日のマスに、締切の◆（「締切」とタイトル。プロジェクトの色の文字）と、タスク（プロジェクトの色の点とタイトル）。
 *   今日のマスには今日の未完了のタスク。出し切れないときは「ほか N 件」で、押すとその日の一覧が開く
 * - タスクを別の日へドラッグすると予定の日付が変わり（d と同じ決まり。今日か過去なら今日へ）、◆をドラッグすると
 *   締切が変わる（⇧D と同じ決まり）。どちらもデータ層の既存の操作を呼ぶだけで、⌘Z で戻る。
 *   タスクはサイドバーの今日・あとで・プロジェクトにも落とせる（リストの行と同じ）
 * - タスクか◆を押すと、その場に小さな詳細が開く（tasks/task-detail-popover.tsx）
 * - 右下の「＋」と n は「＋」の上に小さな追加欄（行き先は「受信箱｜今日」）。日のマスにマウスを乗せると出る「＋」からは、
 *   その日の予定として追加する（今日より前の日には出さない）。プロジェクトで絞り込んでいるときは、そのプロジェクトを付ける
 * - 上の絞り込みで、プロジェクト（すべて・各プロジェクト・プロジェクトなし）を選べる
 * この画面はリストではないので、一覧の状態（ui.view）は持たない（↑↓ や x などの一覧のキーは効かない）
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function monthLabel(month: string): string {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}

/** マスの左上の日付（月の1日だけ「10/1」） */
function dayNumber(date: string): string {
  const day = Number(date.slice(8, 10));
  return day === 1 ? `${Number(date.slice(5, 7))}/1` : String(day);
}

function keyHint(id: string): string {
  const key = keymap.get(id)?.keys[0];
  return key === undefined ? "" : `（${formatKey(key)}）`;
}

const toolButtonClassName =
  "inline-flex h-7 items-center justify-center rounded-lg border border-border bg-muted px-2.5 text-[12.5px] text-sidebar-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

/** 見出し（lazy.tsx の CalendarHeading）。起動の道筋のモジュールを、この後から読み込むモジュールから import しないために受け取る */
export type CalendarHeadingComponent = ComponentType<{ subtitle?: ReactNode; actions?: ReactNode }>;

export const CalendarScreen = observer(function CalendarScreen({
  Heading,
}: {
  Heading: CalendarHeadingComponent;
}) {
  const ui = useUi();
  const store = useStore();
  const state = calendarOf(ui);
  const [model] = useState(() => new CalendarModel(store, () => state.filter));
  const grid = useRef<HTMLDivElement>(null);
  // 画面が出ているあいだだけ [ ] が効く
  useLayoutEffect(() => {
    state.addScreen();
    return () => state.removeScreen();
  }, [state]);
  // 月を替えたら、開いていた小さな詳細は閉じる（押したマスが画面から消えるので）
  useEffect(
    () =>
      reaction(
        () => state.shownMonth(store.today),
        () => taskDetailPopoverOf(ui).dismiss(),
      ),
    [ui, state, store],
  );
  useFollowDetailAnchor(ui, grid, model, store.loaded);
  useEndDragAnywhere(ui);

  const today = store.today;
  const month = state.shownMonth(today);
  const filter = effectiveFilter(store, state.filter);

  return (
    // 幅の上限を外す（右の枠。shell/app-shell.tsx）
    <div data-wide-view="">
      <Heading
        subtitle={<p className="mt-1 text-[13px] text-muted-foreground">{monthLabel(month)}</p>}
        actions={<Toolbar />}
      />
      {store.loaded && (
        <div ref={grid} className="mt-6 overflow-hidden rounded-xl border border-border">
          <table
            aria-label={`${monthLabel(month)}のカレンダー`}
            className="w-full table-fixed border-collapse"
          >
            <thead>
              <tr className="border-border border-b bg-muted">
                {WEEKDAYS.map((weekday) => (
                  <th
                    key={weekday}
                    scope="col"
                    className="px-2.5 py-1.5 text-left font-normal text-[11px] text-faint-foreground"
                  >
                    {weekday}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {monthWeeks(month).map((week) => (
                <tr key={week[0]} className="border-border border-b last:border-b-0">
                  {week.map((date) => (
                    <DayCell key={date} date={date} month={month} today={today} model={model} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <DayListHost grid={grid} model={model} />
      <TaskDetailPopoverHost />
      <QuickAddHost projectId={filter.kind === "project" ? filter.id : null} />
    </div>
  );
});

/** 見出しの右：‹ 今日 ›（前後の月と今月）と、プロジェクトの絞り込み */
const Toolbar = observer(function Toolbar() {
  const ui = useUi();
  const store = useStore();
  const state = calendarOf(ui);
  return (
    <div className="flex flex-none items-center gap-2 pb-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="前の月"
          title={`前の月${keyHint("calendar.previousMonth")}`}
          className={cn(toolButtonClassName, "px-1.5")}
          onClick={() => state.shift(-1, store.today)}
        >
          <ChevronLeftIcon aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
        <button type="button" className={toolButtonClassName} onClick={() => state.showThisMonth()}>
          今日
        </button>
        <button
          type="button"
          aria-label="次の月"
          title={`次の月${keyHint("calendar.nextMonth")}`}
          className={cn(toolButtonClassName, "px-1.5")}
          onClick={() => state.shift(1, store.today)}
        >
          <ChevronRightIcon aria-hidden="true" className="size-4" strokeWidth={1.75} />
        </button>
      </div>
      <FilterMenu />
    </div>
  );
});

// --- 絞り込み ---------------------------------------------------------------------------------

function filterValue(filter: ProjectFilter): string {
  return filter.kind === "project" ? `project:${filter.id}` : filter.kind;
}

function parseFilter(value: string): ProjectFilter {
  if (value === "none") return { kind: "none" };
  if (value.startsWith("project:")) return { kind: "project", id: value.slice("project:".length) };
  return { kind: "all" };
}

/** プロジェクトの絞り込み（すべて・各プロジェクト・プロジェクトなし）。選び直すと、その場で表が変わる */
const FilterMenu = observer(function FilterMenu() {
  const ui = useUi();
  const store = useStore();
  const state = calendarOf(ui);
  const filter = effectiveFilter(store, state.filter);
  const project = filter.kind === "project" ? store.project(filter.id) : undefined;
  const label =
    filter.kind === "all"
      ? "すべてのプロジェクト"
      : filter.kind === "none"
        ? "プロジェクトなし"
        : (project?.name ?? "");
  return (
    <Menu.Root>
      <Menu.Trigger
        aria-label={`プロジェクトで絞り込む：${label}`}
        className={cn(toolButtonClassName, "gap-1.5 data-popup-open:bg-accent")}
      >
        {project && <ProjectDot color={projectColorOf(store, project.id)} className="size-2" />}
        <span className="max-w-44 truncate">{label}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 opacity-70" strokeWidth={1.75} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Menu.Popup
            // 中ではアプリの1文字のキーを止める（候補の頭文字で選ぶキーと重ねない）
            data-keymap="off"
            // 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする
            className="glass max-h-(--available-height) min-w-56 origin-(--transform-origin) overflow-y-auto rounded-lg border border-glass-edge bg-popover p-1 text-[13px] text-popover-foreground shadow-xl/30 outline-none transition-[scale,opacity] duration-(--duration-short) data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:duration-(--duration-exit)"
          >
            <Menu.RadioGroup
              value={filterValue(filter)}
              onValueChange={(value: string) => state.setFilter(parseFilter(value))}
            >
              <FilterItem value="all" label="すべてのプロジェクト" />
              {store.lists.projects.map((row) => (
                <FilterItem
                  key={row.id}
                  value={`project:${row.id}`}
                  label={row.name}
                  dot={<ProjectDot color={projectColorOf(store, row.id)} className="size-2" />}
                />
              ))}
              <FilterItem value="none" label="プロジェクトなし" />
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
});

function FilterItem({ value, label, dot }: { value: string; label: string; dot?: ReactNode }) {
  return (
    <Menu.RadioItem
      value={value}
      closeOnClick
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
    >
      <span className="grid size-2 flex-none place-items-center">{dot}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Menu.RadioItemIndicator className="flex-none text-primary-text">
        <CheckIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
      </Menu.RadioItemIndicator>
    </Menu.RadioItem>
  );
}

// --- 日のマス ---------------------------------------------------------------------------------

/** 落としたとき：タスクは予定の日付（今日か過去なら今日へ）、◆は締切。どちらも既存の操作で、⌘Z で戻る */
function dropOn(ui: ListUi, drag: CalendarDrag, date: string): void {
  if (drag.kind === "task") scheduleTasks(ui, [drag.taskId], date);
  else setDeadline(ui, [drag.taskId], date);
}

/** つかむのをやめた（落とした・やめた） */
function endDrag(ui: ListUi): void {
  calendarOf(ui).endDrag();
  taskDragOf(ui).end();
}

const DayCell = observer(function DayCell({
  date,
  month,
  today,
  model,
}: {
  date: string;
  month: string;
  today: string;
  model: CalendarModel;
}) {
  const ui = useUi();
  const state = calendarOf(ui);
  const [over, setOver] = useState(false);
  const entries = entriesInOrder(model.entriesOn(date));
  const shown = entries.slice(0, shownCount(entries.length));
  const overflow = shown.length < entries.length;
  const isToday = date === today;
  const past = date < today;
  const inMonth = monthOf(date) === month;
  const label = formatLongDate(date, today);

  const hover = (event: DragEvent<HTMLTableCellElement>) => {
    if (state.drag === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setOver(true);
  };

  return (
    <td
      aria-label={isToday ? `${label} 今日` : label}
      data-date={date}
      className={cn(
        "group/day h-28 border-border border-r p-0 align-top last:border-r-0",
        isToday && "bg-(--selection) shadow-[inset_0_0_0_1px_var(--selection-ring)]",
        over && "bg-primary/10 outline-1 -outline-offset-1 outline-primary/60",
      )}
      onDragEnter={hover}
      onDragOver={hover}
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) setOver(false);
      }}
      onDrop={(event) => {
        const drag = state.drag;
        setOver(false);
        if (drag === null) return;
        event.preventDefault();
        endDrag(ui);
        state.closeDayList();
        dropOn(ui, drag, date);
      }}
    >
      <div className="flex min-w-0 flex-col gap-1 px-1.5 pt-1.5 pb-2">
        <div className="flex h-5 items-center gap-1.5 px-1">
          <span
            className={cn(
              "text-[12px] tabular-nums",
              isToday
                ? "font-semibold text-foreground"
                : inMonth && !past
                  ? "text-sidebar-foreground"
                  : "text-faint-foreground",
            )}
          >
            {dayNumber(date)}
          </span>
          {isToday && <span className="text-[11px] text-primary-text">今日</span>}
          {!past && <DayAddButton date={date} label={label} />}
        </div>
        <ul className="flex min-w-0 flex-col gap-0.5">
          {shown.map((entry) => (
            <li key={`${entry.kind}:${entry.task.id}`} className="min-w-0">
              <EntryChip entry={entry} today={today} />
            </li>
          ))}
        </ul>
        {overflow && <MoreButton date={date} count={entries.length - shown.length} />}
      </div>
    </td>
  );
});

/** マスにマウスを乗せると出る「＋」。その日の予定として追加する小さな追加欄を、マスの下に開く */
const DayAddButton = observer(function DayAddButton({
  date,
  label,
}: {
  date: string;
  label: string;
}) {
  const ui = useUi();
  const quickAdd = quickAddOf(ui);
  const target = quickAdd.request?.target;
  // この日の欄が開いているあいだは出したままにする
  const adding = target?.kind === "date" && target.on === date;
  return (
    <button
      type="button"
      aria-label={`${label}に追加`}
      data-open={adding || undefined}
      className="ml-auto grid size-5 place-items-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover/day:opacity-100 data-open:bg-accent data-open:opacity-100"
      // マスの下に開き（マスの中身は見えたまま。追加したタスクがその場に出る）、Esc で閉じたらこのボタンへ戻る
      onClick={(event) => {
        const button = event.currentTarget;
        quickAdd.open({ kind: "date", on: date }, button.closest("td") ?? button, button);
      }}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
    </button>
  );
});

/** 「ほか N 件」。押すと、その日のタスクを一覧で開く（DayListHost） */
const MoreButton = observer(function MoreButton({ date, count }: { date: string; count: number }) {
  const ui = useUi();
  const state = calendarOf(ui);
  const self = useRef<HTMLButtonElement>(null);
  // 隠れているタスクの小さな詳細が、ここから開いているあいだ（先に詳細の状態を読んで観測する。
  // 最初の描画では要素がまだないので、あとから付いたときに描き直せるように）
  const detailAnchor = taskDetailPopoverOf(ui).request?.anchor;
  const anchored = detailAnchor !== undefined && detailAnchor === self.current;
  return (
    <button
      ref={self}
      type="button"
      data-calendar-entry={`more:${date}`}
      data-anchored={anchored || undefined}
      aria-expanded={state.dayList === date}
      className="self-start rounded-[5px] px-1.5 text-[11.5px] text-faint-foreground leading-[18px] outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring data-anchored:bg-accent data-anchored:text-foreground"
      onClick={() => {
        if (state.dayList === date) state.closeDayList();
        else state.openDayList(date);
      }}
    >
      ほか {count} 件
    </button>
  );
});

// --- マスの中の1つ（タスクか締切の◆） ------------------------------------------------------------

/**
 * タスク（プロジェクトの色の点とタイトル。進行中は丸の半分が紫）か、締切の◆（「締切」とタイトル。プロジェクトの色の文字。
 * 過ぎた締切は赤の文字）。押すと小さな詳細が開き、つかむと別の日へ動かせる。
 * anchor を渡すと、小さな詳細をその要素から開く（「ほか N 件」の一覧の中から開くとき。一覧は閉じる）
 */
const EntryChip = observer(function EntryChip({
  entry,
  today,
  anchor,
  onOpen,
}: {
  entry: CalendarEntry;
  today: string;
  anchor?: () => Element | null;
  onOpen?: () => void;
}) {
  const ui = useUi();
  const store = useStore();
  const state = calendarOf(ui);
  const { kind, task } = entry;
  const projectId = task.projectId;
  const color = projectId === null ? undefined : projectColorOf(store, projectId);
  const self = useRef<HTMLDivElement>(null);
  const dragging = state.drag?.taskId === task.id && state.drag.kind === kind;
  // 小さな詳細をこの要素から開いているあいだは、選んだ行と同じ光で示す（先に詳細の状態を読んで観測する。
  // 最初の描画では要素がまだないので、あとから付いたときに描き直せるように）
  const detailAnchor = taskDetailPopoverOf(ui).request?.anchor;
  const open = detailAnchor !== undefined && detailAnchor === self.current;
  const deadline = kind === "deadline";
  const overdue = deadline && (task.deadlineOn ?? "") < today;
  const openDetail = (element: HTMLElement) => {
    const from = anchor?.() ?? element;
    onOpen?.();
    // 開いたもの（タスクか◆か）を覚えておく。移ったり隠れたりしたら、これで付く先を決め直す（useFollowDetailAnchor）
    state.detail = { taskId: task.id, kind };
    taskDetailPopoverOf(ui).open(task.id, from);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: button 要素はブラウザによってドラッグを始められないため、role で押せるようにする
    <div
      ref={self}
      role="button"
      tabIndex={0}
      draggable
      data-calendar-entry={`${kind}:${task.id}`}
      data-calendar-task={task.id}
      // 読み上げ：締切は「締切 タイトル」、タスクはタイトル（◆や色の点は読まない）
      aria-label={deadline ? `締切 ${task.title}` : undefined}
      title={task.title}
      className={cn(
        "flex w-full min-w-0 cursor-default select-none items-center gap-1.5 rounded-[5px] px-1.5 text-left text-[11.5px] leading-[18px] outline-none focus-visible:outline-2 focus-visible:outline-ring",
        deadline ? "hover:bg-accent" : "bg-muted text-foreground hover:bg-accent",
        open && "row-selected",
        dragging && "opacity-50",
      )}
      style={
        deadline
          ? {
              color: overdue
                ? "var(--destructive-foreground)"
                : color === undefined
                  ? "var(--primary-text)"
                  : projectColorVar(color),
            }
          : undefined
      }
      onClick={(event) => openDetail(event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openDetail(event.currentTarget);
      }}
      onDragStart={(event) => {
        state.startDrag({ taskId: task.id, kind });
        // タスクはサイドバーの今日・あとで・プロジェクトにも落とせる（リストの行と同じ）。◆は日のマスにだけ
        if (kind === "task") taskDragOf(ui).start([task.id]);
        const transfer = event.dataTransfer;
        if (transfer) {
          transfer.effectAllowed = "move";
          transfer.setData("text/plain", task.title);
        }
      }}
      onDragEnd={() => endDrag(ui)}
    >
      {deadline ? (
        <>
          <span aria-hidden="true" className="flex-none text-[8px]">
            ◆
          </span>
          <span className="flex-none">締切</span>
        </>
      ) : task.isInProgress ? (
        <span
          aria-hidden="true"
          className="status-in-progress size-2 flex-none rounded-full border-[1.2px]"
        />
      ) : color === undefined ? (
        <span aria-hidden="true" className="size-1.5 flex-none rounded-full bg-faint-foreground" />
      ) : (
        <ProjectDot color={color} className="size-1.5" />
      )}
      <span className="min-w-0 flex-1 truncate">{task.title}</span>
    </div>
  );
});

// --- 「ほか N 件」の一覧 ------------------------------------------------------------------------

/**
 * 「ほか N 件」で開くその日の一覧（締切の◆とタスクを全部）。「ほか N 件」の下に開き、Esc で閉じてそこへ戻る。
 * 一覧の中のタスクを押すと、一覧を閉じて小さな詳細を「ほか N 件」から開く。一覧の中からも別の日へドラッグできる
 */
const DayListHost = observer(function DayListHost({
  grid,
  model,
}: {
  grid: RefObject<HTMLDivElement | null>;
  model: CalendarModel;
}) {
  const ui = useUi();
  const store = useStore();
  const state = calendarOf(ui);
  const date = state.dayList;
  // 閉じる途中（消えるときのフェードのあいだ）も、最後に開いた日を描く
  const [last, setLast] = useState(date);
  if (date !== null && date !== last) setLast(date);
  const shownDate = date ?? last;
  const anchor = () =>
    shownDate === null
      ? null
      : (Array.from(
          grid.current?.querySelectorAll<HTMLElement>("[data-calendar-entry]") ?? [],
        ).find((element) => element.dataset.calendarEntry === `more:${shownDate}`) ?? null);
  const anchorElement = anchor();
  // 「ほか N 件」が消えた（その日の件数が減った）ら閉じる
  useEffect(() => {
    if (date !== null && anchorElement === null) state.closeDayList();
  });
  if (shownDate === null) return null;
  const entries = entriesInOrder(model.entriesOn(shownDate));
  return (
    <Popover
      open={date !== null && anchorElement !== null}
      onOpenChange={(next, details) => {
        if (next) return;
        state.closeDayList();
        if (details.reason === "escape-key" && anchorElement instanceof HTMLElement) {
          anchorElement.focus();
        }
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setLast(null);
      }}
    >
      <PopoverPopup
        anchor={anchorElement}
        side="bottom"
        align="start"
        aria-label={`${formatLongDate(shownDate, store.today)}のタスク`}
        data-keymap="off"
        finalFocus={false}
        className="w-64 duration-(--duration-short) data-starting-style:scale-95 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="flex flex-col gap-1">
          <p className="px-1.5 pb-1 text-[12px] text-muted-foreground">
            {formatLongDate(shownDate, store.today)}
          </p>
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={`${entry.kind}:${entry.task.id}`}>
                <EntryChip
                  entry={entry}
                  today={store.today}
                  anchor={anchor}
                  onOpen={() => state.closeDayList()}
                />
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

// --- 小さな詳細の付いていく先 --------------------------------------------------------------------

/**
 * 小さな詳細の付く先を、開いたもの（タスクか◆か。CalendarState.detail）の今の場所から決め直す。表が描き直されるたびに見る。
 * - マスに出ていれば、そのタスク（◆）の要素に付く
 * - 「ほか N 件」に隠れていれば、その日の「ほか N 件」に付く（「ほか N 件」の一覧から開いたときも、ここに付いている）
 * - 表のどこにもなければ（完了・削除・絞り込みの外・表の外の日）閉じる
 * 付いていた要素がまだ画面にあっても、タスクが移っていれば決め直す（元の日の「ほか N 件」に残ったままにしない）。
 * 消えた要素に合わせたままだと、画面の左上へ飛ぶため、付く先がなくなったらフェードを待たずに閉じる
 */
function useFollowDetailAnchor(
  ui: ListUi,
  grid: RefObject<HTMLElement | null>,
  model: CalendarModel,
  ready: boolean,
) {
  useEffect(() => {
    const root = grid.current;
    if (!ready || !root) return;
    const popover = taskDetailPopoverOf(ui);
    const state = calendarOf(ui);
    const follow = () => {
      const request = popover.request;
      if (request === null) {
        // 閉じる途中で要素が消えたら、フェードを待たずに消す
        if (popover.leaving && !popover.leaving.anchor.isConnected) popover.dismiss();
        return;
      }
      const target =
        state.detail?.taskId === request.taskId
          ? state.detail
          : { taskId: request.taskId, kind: "task" as const };
      const dates = Array.from(
        root.querySelectorAll<HTMLElement>("td[data-date]"),
        (cell) => cell.dataset.date ?? "",
      );
      const location = locateEntry(model, dates, target);
      if (location === null) {
        popover.dismiss();
        return;
      }
      const key = location.shown ? `${target.kind}:${target.taskId}` : `more:${location.date}`;
      const cell = root.querySelector(`td[data-date="${location.date}"]`);
      const element = Array.from(
        cell?.querySelectorAll<HTMLElement>("[data-calendar-entry]") ?? [],
      ).find((candidate) => candidate.dataset.calendarEntry === key);
      if (element === undefined) {
        // 表がまだ描き直されていない（次の描き直しでもう一度見る）。付いていた要素が消えていれば閉じる
        if (!request.anchor.isConnected) popover.dismiss();
        return;
      }
      if (element !== request.anchor) popover.open(request.taskId, element);
    };
    const observer = new MutationObserver(follow);
    // 件数の文字（「ほか 3 件」→「ほか 2 件」）だけが変わるときも見る
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [ui, grid, model, ready]);
}

/**
 * カレンダーのドラッグの後始末。どこかへ落としたとき（日のマス・サイドバー・落とせないところ）と、やめたとき（Esc など）に、
 * カレンダーとサイドバー向け（taskDragOf）の両方のドラッグの状態を終える。
 * 元のチップの onDragEnd だけに頼らない（サイドバーの今日へ落とすと元のチップがマスから消え、dragend が届かないことがあるため）。
 * 念のため、次に押したとき（pointerdown。ドラッグのあいだは起きない）にも、残っていれば終える
 */
function useEndDragAnywhere(ui: ListUi) {
  useEffect(() => {
    const finish = () => {
      if (calendarOf(ui).drag !== null) endDrag(ui);
    };
    document.addEventListener("drop", finish);
    document.addEventListener("dragend", finish);
    document.addEventListener("pointerdown", finish, true);
    return () => {
      document.removeEventListener("drop", finish);
      document.removeEventListener("dragend", finish);
      document.removeEventListener("pointerdown", finish, true);
    };
  }, [ui]);
}
