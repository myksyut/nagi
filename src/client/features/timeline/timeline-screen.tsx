import { observer } from "mobx-react-lite";
import {
  type ButtonHTMLAttributes,
  type ComponentType,
  type CSSProperties,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useStore } from "@/data";
import { addDays } from "@/data/logical-day";
import { scheduleTasks, setDeadline } from "@/features/dates/commands";
import { daysBetween, formatShortDate } from "@/features/dates/labels";
import { ProjectDot } from "@/features/projects/project-dot";
import { QuickAddHost } from "@/features/quick-add/quick-add";
import { projectColorOf, projectColorVar } from "@/lib/project-color";
import { prefersReducedMotion } from "@/lib/reduced-motion";
import { cn } from "@/lib/utils";
import { TaskDetailPopoverHost, taskDetailPopoverOf } from "@/tasks/task-detail-popover";
import { useUi } from "@/tasks/ui-context";
import { shiftTaskDates } from "./commands";
import { ProjectFilterButton } from "./project-filter";
import {
  clampDragDays,
  type DragEdge,
  type DragSubject,
  dragChange,
  draggedDates,
} from "./timeline-drag";
import {
  shapeOf,
  type TimelineGroup,
  type TimelineItem,
  type TimelineModel,
  type TimelineRange,
  type TimelineShape,
  timelineModelOf,
  timelineRange,
} from "./timeline-model";
import { timelineNav } from "./timeline-nav";

/**
 * タイムライン（後から読み込む画面）。横に日付（1 週前から 8 週先）、縦にプロジェクトごとのまとまりとタスク。
 * 横にスクロールでき、今日の位置に縦の光の線。左の名前の列と上の日付の行は、スクロールしても残る。
 * - 棒か◆を押すと、その場に小さな詳細が開く（Enter でも）
 * - 棒をドラッグすると、日単位でぴったり止まる（左端でやる日、右端で締切、真ん中で両方。timeline-drag.ts）。
 *   動かしているあいだは、送る先の日付の形で描く。離すと送り、⌘Z 1回で戻る。Esc でやめる
 * - 「今日」で今日の位置へ、[ ] で1週ずつ前後へスクロールする
 * - 上の絞り込みで、プロジェクトを選べる
 * - 右下の「＋」と n は、小さな追加欄（features/quick-add）。絞り込み中なら、そのプロジェクトを付けて追加する
 */

/** 1日の幅（px）。ドラッグの日数もこの幅で決める */
export const DAY_WIDTH = 36;
/** 左の名前の列の幅（px） */
const NAME_WIDTH = 208;
/** 棒の左右の余白（px。隣の日の棒とくっつかないように） */
const BAR_INSET = 3;
/** これより動かしたらドラッグ（それまでは押しただけ）とみなす（px） */
const DRAG_THRESHOLD = 4;
/** 今日へスクロールしたとき、今日より前に見せる日数 */
const LEAD_DAYS = 3;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function weekdayOf(date: string): number {
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  ).getUTCDay();
}

/** 範囲の最初の日から date までの距離（px） */
function xOf(range: TimelineRange, date: string): number {
  return daysBetween(range.start, date) * DAY_WIDTH;
}

/** 見出し（lazy.tsx の TimelineHeading）。起動の道筋のモジュールを、この後から読み込むモジュールから import しないために受け取る */
export type TimelineHeadingComponent = ComponentType<{ actions?: ReactNode }>;

export const TimelineScreen = observer(function TimelineScreen({
  Heading,
}: {
  Heading: TimelineHeadingComponent;
}) {
  const store = useStore();
  const model = timelineModelOf(store);
  const { filter } = model;
  return (
    // 幅の上限を外す（右の枠。shell/app-shell.tsx）
    <div data-wide-view="">
      <Heading
        actions={
          <div className="flex flex-none items-center gap-2">
            <button
              type="button"
              className="rounded-lg border border-border bg-secondary px-2.5 py-1 font-medium text-[12.5px] text-sidebar-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => timelineNav.scroller?.scrollToToday()}
            >
              今日
            </button>
            <ProjectFilterButton model={model} />
          </div>
        }
      />
      {store.loaded && <TimelineGrid model={model} />}
      <TaskDetailPopoverHost />
      <QuickAddHost projectId={filter.kind === "project" ? filter.id : null} />
    </div>
  );
});

/** 表と、横のスクロール（「今日」と [ ]）。棒の要素はタスクごとに覚えておき、小さな詳細を開き直すときに使う */
const TimelineGrid = observer(function TimelineGrid({ model }: { model: TimelineModel }) {
  const store = useStore();
  const ui = useUi();
  const today = store.today;
  // 範囲は今日が変わったときだけ作り直す（行の部品に、毎回新しい props を渡さないように）
  const range = useMemo(() => timelineRange(today), [today]);
  const groups = model.groups;
  const scrollRef = useRef<HTMLElement>(null);
  const [anchors] = useState(() => new Map<string, HTMLElement>());

  // 今日の位置へ（最初は動きなしで）。[ ] と「今日」のボタンは、画面が開いているあいだだけ効く
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const scrollTo = (left: number, smooth: boolean) => {
      if (smooth && !prefersReducedMotion() && typeof element.scrollTo === "function") {
        element.scrollTo({ left, behavior: "smooth" });
      } else {
        element.scrollLeft = left;
      }
    };
    const toToday = (smooth: boolean) => {
      const current = store.today;
      const index = daysBetween(timelineRange(current).start, current);
      scrollTo(Math.max(0, index - LEAD_DAYS) * DAY_WIDTH, smooth);
    };
    toToday(false);
    return timelineNav.attach({
      scrollToToday: () => toToday(true),
      scrollWeeks: (delta) => scrollTo(element.scrollLeft + delta * 7 * DAY_WIDTH, true),
    });
  }, [store]);

  // 小さな詳細の押した要素が画面から消えたら（まとまりが変わった・離れた◆が棒に付いたなど）、
  // 同じタスクの棒から開き直す。タスクがタイムラインから出たら閉じる
  useLayoutEffect(() => {
    const popover = taskDetailPopoverOf(ui);
    const request = popover.request;
    if (!request || request.anchor.isConnected) return;
    const next = anchors.get(request.taskId);
    if (next?.isConnected) popover.open(request.taskId, next);
    else popover.dismiss();
  });

  return (
    <section
      ref={scrollRef}
      aria-label="タイムライン"
      className="relative mt-6.5 max-h-[calc(100dvh-15rem)] overflow-auto overscroll-x-contain rounded-xl border border-border bg-background"
      style={{ "--day-w": `${DAY_WIDTH}px`, "--name-w": `${NAME_WIDTH}px` } as CSSProperties}
    >
      <div className="relative" style={{ width: NAME_WIDTH + range.days * DAY_WIDTH }}>
        <TimelineAxis start={range.start} days={range.days} today={today} />
        <div className="relative">
          <DayBackdrop start={range.start} days={range.days} today={today} />
          {groups.length === 0 ? (
            <p className="sticky left-0 w-[calc(var(--name-w)+22rem)] px-6.5 py-10 text-muted-foreground text-sm">
              {model.filter.kind === "all"
                ? "予定・今日・締切のあるタスクが、ここに並びます"
                : "タイムラインに出すタスクはありません"}
            </p>
          ) : (
            groups.map((group) => (
              <TimelineGroupView
                key={group.key}
                group={group}
                range={range}
                today={today}
                anchors={anchors}
              />
            ))
          )}
          {/* 下の余白。左の名前の列は、ここも地の色で塞ぐ（横にスクロールした日の列の地が、名前の列の下からのぞかないように） */}
          <div aria-hidden="true" className="flex h-3">
            <div className="sticky left-0 z-20 w-(--name-w) flex-none bg-background" />
          </div>
        </div>
      </div>
    </section>
  );
});

/** 上の日付の行（縦のスクロールでも残る）。月の初めと範囲の最初の日は「10/1」、ほかは日だけ。今日は明るく */
const TimelineAxis = memo(function TimelineAxis({
  start,
  days,
  today,
}: {
  start: string;
  days: number;
  today: string;
}) {
  return (
    <div
      aria-hidden="true"
      className="sticky top-0 z-30 flex h-10 bg-background shadow-[inset_0_-1px_0_var(--border)]"
    >
      <div className="sticky left-0 z-10 w-(--name-w) flex-none bg-background shadow-[inset_0_-1px_0_var(--border)]" />
      {Array.from({ length: days }, (_, i) => {
        const date = addDays(start, i);
        const day = Number(date.slice(8, 10));
        const label = i === 0 || day === 1 ? `${Number(date.slice(5, 7))}/${day}` : String(day);
        const isToday = date === today;
        return (
          <div
            key={date}
            data-date={date}
            className={cn(
              "flex w-(--day-w) flex-none flex-col items-center justify-center text-[10.5px] text-faint-foreground leading-tight tabular-nums",
              isToday && "font-semibold text-foreground",
            )}
          >
            <span>{label}</span>
            <span className={cn("text-[9.5px]", !isToday && "opacity-75")}>
              {isToday ? "今日" : WEEKDAYS[weekdayOf(date)]}
            </span>
          </div>
        );
      })}
    </div>
  );
});

/** 日の列の地（週末をわずかに明るく、週の区切りに細い線）と、今日の位置の縦の光の線 */
const DayBackdrop = memo(function DayBackdrop({
  start,
  days,
  today,
}: {
  start: string;
  days: number;
  today: string;
}) {
  const todayIndex = daysBetween(start, today);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0"
      style={{ left: NAME_WIDTH, width: days * DAY_WIDTH }}
    >
      {Array.from({ length: days }, (_, i) => {
        const weekday = weekdayOf(addDays(start, i));
        if (weekday !== 0 && weekday !== 6 && weekday !== 1) return null;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 日の列は範囲の最初からの位置で決まる
            key={i}
            className={cn(
              "absolute inset-y-0",
              weekday === 1 ? "border-border/60 border-l" : "bg-muted/50",
            )}
            style={{ left: i * DAY_WIDTH, width: weekday === 1 ? 0 : DAY_WIDTH }}
          />
        );
      })}
      <div
        data-today-line=""
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-primary-text opacity-85 shadow-[0_0_12px_var(--primary-text)]"
        style={{ left: todayIndex * DAY_WIDTH + DAY_WIDTH / 2 }}
      />
    </div>
  );
});

/** プロジェクトごとのまとまり：色の見出しと、その下の行 */
const TimelineGroupView = observer(function TimelineGroupView({
  group,
  range,
  today,
  anchors,
}: {
  group: TimelineGroup;
  range: TimelineRange;
  today: string;
  anchors: Map<string, HTMLElement>;
}) {
  const store = useStore();
  const { projectId } = group;
  const project = projectId === null ? undefined : store.project(projectId);
  const color = projectId === null ? null : projectColorOf(store, projectId);
  const name = project?.name ?? "プロジェクトなし";
  return (
    // biome-ignore lint/a11y/useSemanticElements: プロジェクトのまとまり（見出しとその下の行）を名前で読み上げる
    <div role="group" aria-label={name}>
      <div className="flex h-8">
        <div className="sticky left-0 z-20 flex h-full w-(--name-w) flex-none items-center gap-2 bg-background px-3 pt-2 font-semibold text-[12.5px] text-foreground">
          {color === null ? (
            <span
              aria-hidden="true"
              className="size-2 flex-none rounded-full border border-faint-foreground"
            />
          ) : (
            <ProjectDot color={color} className="size-2" />
          )}
          <span className="truncate">{name}</span>
        </div>
      </div>
      {group.items.map((item) => (
        <TimelineRowView
          key={item.task.id}
          item={item}
          range={range}
          today={today}
          anchors={anchors}
          color={color === null ? "var(--muted-foreground)" : projectColorVar(color)}
        />
      ))}
    </div>
  );
});

/** 1行：左に名前（進行中なら丸の半分が紫の印）、右に棒か◆ */
const TimelineRowView = observer(function TimelineRowView({
  item,
  range,
  today,
  anchors,
  color,
}: {
  item: TimelineItem;
  range: TimelineRange;
  today: string;
  anchors: Map<string, HTMLElement>;
  color: string;
}) {
  const { task } = item;
  return (
    <div className="relative flex h-8 items-center" data-timeline-row={task.id}>
      <div className="sticky left-0 z-20 flex h-full w-(--name-w) flex-none items-center gap-1.5 bg-background pr-3 pl-6.5 text-[13px] text-sidebar-foreground">
        {task.isInProgress && (
          <span
            role="img"
            aria-label="進行中"
            className="status-in-progress size-2.5 flex-none rounded-full border-[1.4px]"
          />
        )}
        <span className="truncate">{task.title}</span>
      </div>
      <div className="relative h-full flex-1">
        <TimelineMarks item={item} range={range} today={today} anchors={anchors} color={color} />
      </div>
    </div>
  );
});

type DragState = {
  edge: DragEdge;
  pointerId: number;
  originX: number;
  days: number;
  moved: boolean;
};

function within(date: string, range: TimelineRange): boolean {
  return date >= range.start && date <= range.end;
}

/** 棒の位置と幅（範囲の端で切る）。範囲に1日も入らなければ null。clippedEnd は右端が範囲の外にあるか */
function barBox(
  shape: Extract<TimelineShape, { kind: "bar" }>,
  range: TimelineRange,
): { left: number; width: number; clippedEnd: boolean } | null {
  const rangeWidth = range.days * DAY_WIDTH;
  const left = Math.max(xOf(range, shape.from), 0);
  const end = xOf(range, shape.to) + DAY_WIDTH;
  const right = Math.min(end, rangeWidth);
  if (right <= left) return null;
  return {
    left: left + BAR_INSET,
    width: right - left - 2 * BAR_INSET,
    clippedEnd: end > rangeWidth,
  };
}

/** ◆（締切）の位置（その日の列のまん中） */
function diamondLeft(range: TimelineRange, on: string): number {
  return xOf(range, on) + DAY_WIDTH / 2 - 10;
}

/**
 * 1行の棒と◆。押すと小さな詳細が開き、ドラッグで日付を変える。
 * 押せる棒と◆（ボタン）は、確定している日付の形で描く。動かしているあいだは、ボタンはそのまま残して
 * （ポインタを捕まえたまま。見えなくするだけ）、離したときの形（今日への到着も含む）を、押せない見た目の層に描く
 * （表示と操作を分ける。形が棒から◆に変わっても、範囲の外へ出ても、捕まえた要素を消さないように）。
 * 範囲の外の離れた◆は描かない（Tab で見えない◆へ行かないように）
 */
const TimelineMarks = observer(function TimelineMarks({
  item,
  range,
  today,
  anchors,
  color,
}: {
  item: TimelineItem;
  range: TimelineRange;
  today: string;
  anchors: Map<string, HTMLElement>;
  color: string;
}) {
  const ui = useUi();
  const { task, shape } = item;
  const subject: DragSubject = {
    bucket: item.bucket,
    scheduledOn: item.bucket === "scheduled" ? item.doOn : null,
    deadlineOn: item.deadlineOn,
  };
  const [preview, setPreview] = useState<{ edge: DragEdge; days: number } | null>(null);
  const drag = useRef<DragState | null>(null);
  // ドラッグのあとのクリックでは、小さな詳細を開かない
  const suppressClick = useRef(false);
  const open = taskDetailPopoverOf(ui).isOpen(task.id);
  const dragging = preview !== null;
  const previewDates = preview ? draggedDates(preview.edge, subject, preview.days, today) : null;
  const previewShape = previewDates ? shapeOf(previewDates.doOn, previewDates.deadlineOn) : null;

  const cancel = () => {
    drag.current = null;
    setPreview(null);
  };

  // 動かしているあいだの Esc でやめる（アプリのキーより先に受ける）
  useEffect(() => {
    if (!dragging) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      drag.current = null;
      setPreview(null);
      // 離したときのクリックで、小さな詳細を開かない
      suppressClick.current = true;
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [dragging]);

  /** 離した：日付の操作を送る（決まりはデータ層。変えるものがなければ何も送らない） */
  const commit = (edge: DragEdge, days: number) => {
    const change = dragChange(edge, subject, days, today);
    if (change === null) return;
    switch (change.kind) {
      case "schedule":
        scheduleTasks(ui, [task.id], change.on);
        return;
      case "deadline":
        setDeadline(ui, [task.id], change.on);
        return;
      case "shift":
        shiftTaskDates(ui, [task.id], change.days);
        return;
    }
  };

  /** 棒と◆のポインタの受け口。edge を渡さなければ、押した場所（data-edge）で決める */
  const pointerHandlers = (fixedEdge?: DragEdge) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      suppressClick.current = false;
      if (event.button !== 0 || drag.current) return;
      const target = event.target instanceof Element ? event.target : null;
      const edge =
        fixedEdge ??
        (target?.closest("[data-edge]")?.getAttribute("data-edge") as DragEdge | null) ??
        "move";
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // 押したままのポインタでなければ（合成したイベントなど）、捕まえずに続ける
      }
      drag.current = {
        edge,
        pointerId: event.pointerId,
        originX: event.clientX,
        days: 0,
        moved: false,
      };
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      const dx = event.clientX - state.originX;
      if (!state.moved) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        state.moved = true;
      }
      const days = clampDragDays(state.edge, subject, Math.round(dx / DAY_WIDTH), today);
      state.days = days;
      setPreview((current) =>
        current?.edge === state.edge && current.days === days
          ? current
          : { edge: state.edge, days },
      );
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const state = drag.current;
      if (!state || state.pointerId !== event.pointerId) return;
      cancel();
      if (!state.moved) return;
      suppressClick.current = true;
      commit(state.edge, state.days);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === event.pointerId) cancel();
    },
    onLostPointerCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === event.pointerId) cancel();
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      // ドラッグのあとのクリックは開かない（キーボードの Enter・Space のクリック（detail が 0）はいつも開く）
      if (suppressClick.current && event.detail !== 0) {
        suppressClick.current = false;
        return;
      }
      suppressClick.current = false;
      taskDetailPopoverOf(ui).open(task.id, event.currentTarget);
    },
  });

  const registerMain: Ref<HTMLButtonElement> = (element) => {
    if (element) anchors.set(task.id, element);
    return () => {
      if (anchors.get(task.id) === element) anchors.delete(task.id);
    };
  };

  const title = task.title;
  const style = { "--bar": color } as CSSProperties;
  // 動かしているあいだは、押せる棒と◆を見えなくする（ポインタを捕まえたまま残す）
  const source = dragging ? { "data-drag-source": "" } : {};
  const previewLayer = previewShape && (
    <MarksPreview shape={previewShape} range={range} inProgress={task.isInProgress} style={style} />
  );

  if (shape.kind === "diamond") {
    return (
      <>
        <DiamondButton
          ref={registerMain}
          kind="diamond"
          left={diamondLeft(range, shape.on)}
          on={shape.on}
          label={`「${title}」 締切 ${formatShortDate(shape.on, today)}`}
          open={open}
          hidden={dragging}
          style={style}
          {...source}
          {...pointerHandlers("deadline")}
        />
        {previewLayer}
      </>
    );
  }

  const box = barBox(shape, range);
  const loose =
    shape.looseDeadline !== null && within(shape.looseDeadline, range) ? shape.looseDeadline : null;
  const doLabel = shape.from === today ? "今日" : formatShortDate(shape.from, today);
  const barLabel = `「${title}」 やる日 ${doLabel}${
    shape.endDiamond ? `・締切 ${formatShortDate(shape.to, today)}` : ""
  }`;

  return (
    <>
      {box && (
        <button
          ref={registerMain}
          type="button"
          aria-label={barLabel}
          data-shape="bar"
          data-from={shape.from}
          data-to={shape.to}
          data-end-diamond={shape.endDiamond || undefined}
          {...source}
          className={cn(
            barClassName(task.isInProgress),
            "cursor-grab touch-none select-none outline-none transition-[filter] hover:brightness-115 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            open &&
              "shadow-[0_0_0_1px_rgb(255_255_255/70%),0_0_16px_color-mix(in_srgb,var(--bar)_65%,transparent)]",
            dragging && "cursor-grabbing opacity-0",
          )}
          style={{ ...style, left: box.left, width: box.width }}
          {...pointerHandlers()}
        >
          {/* 左端と右端のつまみ（引くと、やる日・締切が変わる） */}
          <span
            data-edge="start"
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md hover:bg-white/25"
          />
          <span
            data-edge="end"
            aria-hidden="true"
            className="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md hover:bg-white/25"
          />
          {shape.endDiamond && !box.clippedEnd && (
            <span data-edge="end" aria-hidden="true" className={END_DIAMOND_CLASS} />
          )}
        </button>
      )}
      {loose !== null && (
        <DiamondButton
          ref={box ? undefined : registerMain}
          kind="loose-deadline"
          left={diamondLeft(range, loose)}
          on={loose}
          label={`「${title}」 締切 ${formatShortDate(loose, today)}`}
          open={open}
          hidden={dragging}
          style={style}
          {...source}
          {...pointerHandlers("deadline")}
        />
      )}
      {previewLayer}
    </>
  );
});

/** 棒の見た目（押せる棒と、ドラッグ中の見た目の層で共通） */
function barClassName(inProgress: boolean): string {
  return cn(
    "absolute top-[7px] h-[18px] rounded-md",
    inProgress
      ? "bg-[linear-gradient(90deg,color-mix(in_srgb,var(--bar)_70%,transparent),var(--bar))] shadow-[0_0_14px_color-mix(in_srgb,var(--bar)_40%,transparent)]"
      : "bg-[color-mix(in_srgb,var(--bar)_50%,transparent)]",
  );
}

/** 棒の右端の◆ */
const END_DIAMOND_CLASS =
  "absolute top-1/2 -right-1.5 size-2.5 -translate-y-1/2 rotate-45 cursor-ew-resize border border-white/40 bg-(--bar)";

/** ◆の中身（押せる◆と、ドラッグ中の見た目の層で共通） */
function DiamondGlyph({ open = false }: { open?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 rotate-45 border-(--bar) border-[1.5px] bg-[color-mix(in_srgb,var(--bar)_20%,transparent)]",
        open && "bg-(--bar) shadow-[0_0_10px_var(--bar)]",
      )}
    />
  );
}

/**
 * ドラッグ中の見た目の層：離したときの形（今日への到着も含む）。押せない（pointer-events: none）、読み上げない。
 * 範囲の外の部分は描かない
 */
function MarksPreview({
  shape,
  range,
  inProgress,
  style,
}: {
  shape: TimelineShape;
  range: TimelineRange;
  inProgress: boolean;
  style: CSSProperties;
}) {
  if (shape.kind === "diamond") {
    if (!within(shape.on, range)) return null;
    return (
      <div aria-hidden="true" className="pointer-events-none contents">
        <div
          data-shape="diamond"
          data-on={shape.on}
          className="absolute top-1.5 grid size-5 place-items-center"
          style={{ ...style, left: diamondLeft(range, shape.on) }}
        >
          <DiamondGlyph open />
        </div>
      </div>
    );
  }
  const box = barBox(shape, range);
  const loose = shape.looseDeadline;
  return (
    <div aria-hidden="true" className="pointer-events-none contents">
      {box && (
        <div
          data-shape="bar"
          data-from={shape.from}
          data-to={shape.to}
          data-end-diamond={shape.endDiamond || undefined}
          className={cn(barClassName(inProgress), "brightness-115")}
          style={{ ...style, left: box.left, width: box.width }}
        >
          {shape.endDiamond && !box.clippedEnd && <span className={END_DIAMOND_CLASS} />}
        </div>
      )}
      {loose !== null && within(loose, range) && (
        <div
          data-shape="loose-deadline"
          data-on={loose}
          className="absolute top-1.5 grid size-5 place-items-center"
          style={{ ...style, left: diamondLeft(range, loose) }}
        >
          <DiamondGlyph open />
        </div>
      )}
    </div>
  );
}

/** 押せる◆（締切）。やる日のないタスクの◆と、やる日より前にある離れた◆ */
function DiamondButton({
  ref,
  kind,
  left,
  on,
  label,
  open,
  hidden,
  style,
  ...rest
}: {
  ref?: Ref<HTMLButtonElement>;
  /** diamond：やる日のないタスクの◆。loose-deadline：やる日より前にある離れた◆ */
  kind: "diamond" | "loose-deadline";
  left: number;
  on: string;
  label: string;
  open: boolean;
  /** ドラッグ中（見えなくして、ポインタを捕まえたまま残す） */
  hidden: boolean;
  style: CSSProperties;
} & ButtonHTMLAttributes<HTMLButtonElement> & { "data-drag-source"?: string }) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      data-shape={kind}
      data-on={on}
      className={cn(
        "absolute top-1.5 grid size-5 cursor-grab touch-none select-none place-items-center rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring",
        hidden && "cursor-grabbing opacity-0",
      )}
      style={{ ...style, left }}
      {...rest}
    >
      <DiamondGlyph open={open} />
    </button>
  );
}
