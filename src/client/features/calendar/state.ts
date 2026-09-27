import { action, makeObservable, observable, observableRef } from "mobx";
import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import type { ListUi } from "@/tasks/list-ui";

/**
 * カレンダーの画面の状態（見ている月・プロジェクトの絞り込み・ドラッグ・「ほか N 件」の一覧。一覧の状態（ListUi）ごとに1つ）と、
 * 画面の中だけで効くキー（[ ]）。画面と一緒に後から読み込む（起動の道筋から import しない）。
 * キーは、このモジュールが読み込まれたとき（起動のあとの空いた時間の先読み）に登録する。
 * 見ている月と絞り込みは、ほかの画面へ移って戻ってきても残る（再読み込みでは今月・すべてに戻る）
 */

/** プロジェクトの絞り込み：すべて・プロジェクトなし・そのプロジェクト（id） */
export type ProjectFilter = { kind: "all" } | { kind: "none" } | { kind: "project"; id: string };

/** つかんでいるもの：タスク（予定の日付を変える）か締切の◆（締切を変える） */
export type CalendarDrag = { taskId: string; kind: "task" | "deadline" };

/** YYYY-MM の月に delta か月を足す */
export function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, "0")}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** 日付（YYYY-MM-DD）の月（YYYY-MM） */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export class CalendarState {
  /** 見ている月（YYYY-MM）。null なら今月（日付が変わって月が替わっても今月を見る） */
  month: string | null = null;
  filter: ProjectFilter = { kind: "all" };
  /** つかんでいるタスクか締切 */
  drag: CalendarDrag | null = null;
  /** 「ほか N 件」で一覧を開いている日（YYYY-MM-DD） */
  dayList: string | null = null;
  /** 画面が出ている数（キーの割り当てが効くか） */
  screens = 0;

  constructor() {
    makeObservable(this, {
      month: observable,
      filter: observableRef,
      drag: observableRef,
      dayList: observable,
      screens: observable,
      shift: action,
      showThisMonth: action,
      setFilter: action,
      startDrag: action,
      endDrag: action,
      openDayList: action,
      closeDayList: action,
      addScreen: action,
      removeScreen: action,
    });
  }

  get active(): boolean {
    return this.screens > 0;
  }

  /** 見ている月（today は今日の論理日付） */
  shownMonth(today: string): string {
    return this.month ?? monthOf(today);
  }

  /** 前後の月へ（‹ › と [ ]） */
  shift(delta: number, today: string): void {
    const next = shiftMonth(this.shownMonth(today), delta);
    this.month = next === monthOf(today) ? null : next;
    this.dayList = null;
  }

  /** 今月へ（「今日」） */
  showThisMonth(): void {
    this.month = null;
    this.dayList = null;
  }

  setFilter(filter: ProjectFilter): void {
    this.filter = filter;
    this.dayList = null;
  }

  startDrag(drag: CalendarDrag): void {
    this.drag = drag;
  }

  endDrag(): void {
    this.drag = null;
  }

  openDayList(date: string): void {
    this.dayList = date;
  }

  closeDayList(): void {
    this.dayList = null;
  }

  addScreen(): void {
    this.screens += 1;
  }

  removeScreen(): void {
    this.screens = Math.max(0, this.screens - 1);
    this.drag = null;
    this.dayList = null;
  }
}

const states = new WeakMap<ListUi, CalendarState>();

/** 一覧の状態ごとのカレンダーの状態 */
export function calendarOf(ui: ListUi): CalendarState {
  let state = states.get(ui);
  if (!state) {
    state = new CalendarState();
    states.set(ui, state);
  }
  return state;
}

/** カレンダーの画面が出ているときだけ効く割り当ての場面（タイムラインの [ ] とは別） */
const SCOPE = "calendar";

export const CALENDAR_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "calendar.previousMonth",
    label: "前の月へ",
    group: "移動",
    keys: ["["],
    repeat: true,
    allowBeforeLoad: true,
    scope: SCOPE,
    when: ({ ui }) => calendarOf(ui).active,
    run: ({ ui, store }) => calendarOf(ui).shift(-1, store.today),
  },
  {
    id: "calendar.nextMonth",
    label: "次の月へ",
    group: "移動",
    keys: ["]"],
    repeat: true,
    allowBeforeLoad: true,
    scope: SCOPE,
    when: ({ ui }) => calendarOf(ui).active,
    run: ({ ui, store }) => calendarOf(ui).shift(1, store.today),
  },
];

registerKeyBindings(CALENDAR_KEY_BINDINGS);
