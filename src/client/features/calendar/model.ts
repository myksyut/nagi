import { compareShallow, computed, type IComputedValue } from "mobx";
import type { AppStore, TaskRow } from "@/data";
import { addDays } from "@/data/logical-day";
import { type ProjectFilter, shiftMonth } from "./state";

/**
 * カレンダーの中身（Core Flows のフロー5「カレンダー」）。日のマスごとに、締切の◆とタスクを出す。
 * - タスク：予定のタスクは予定の日付のマス、今日のタスク（未完了。進行中を含む）は今日のマス
 * - 締切の◆：未完了のタスク（受信箱・今日・予定・あとで）の締切の日のマス
 * - 受信箱・あとでにあって締切もないタスクと、完了したタスクは出さない
 * - マスの中は、締切の◆（今日・予定・あとで・受信箱の順）が先、そのあとにタスク（今日は今日の並び、予定は並び順キーの順）
 *
 * 予定の日付・締切・プロジェクトは、行全体ではなく項目ごとに観測する（row.field）。データ層のリストは、並びが同じなら
 * 知らせてこないので、予定の日付を変えても並びが変わらないときに取りこぼさないように。タイトルの入力では計算し直さない
 */

export type DayEntries = { deadlines: readonly TaskRow[]; tasks: readonly TaskRow[] };

/** マスに出す1つ：タスク（予定の日付を変える）か締切の◆（締切を変える） */
export type CalendarEntry = { kind: "task" | "deadline"; task: TaskRow };

const EMPTY: DayEntries = { deadlines: [], tasks: [] };

function sameEntries(a: DayEntries, b: DayEntries): boolean {
  return compareShallow(a.deadlines, b.deadlines) && compareShallow(a.tasks, b.tasks);
}

/** 曜日（0 が日曜） */
export function weekdayOf(date: string): number {
  return new Date(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))),
  ).getUTCDay();
}

/**
 * 月の表の週（日曜始まり。日付の入力のカレンダーとそろえる）。その月の1日を含む週から、末日を含む週まで
 * （4〜6 週）。前後の月の日も、週の中ではそのまま並ぶ
 */
export function monthWeeks(month: string): string[][] {
  const first = `${month}-01`;
  const last = addDays(`${shiftMonth(month, 1)}-01`, -1);
  const end = addDays(last, 6 - weekdayOf(last));
  const weeks: string[][] = [];
  let day = addDays(first, -weekdayOf(first));
  while (day <= end) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** 絞り込みに合うか（すべてのときはプロジェクトを観測しない） */
export function matchesFilter(row: TaskRow, filter: ProjectFilter): boolean {
  if (filter.kind === "all") return true;
  const projectId = row.field("projectId");
  return filter.kind === "none" ? projectId === null : projectId === filter.id;
}

/**
 * 実際に使う絞り込み。選んでいたプロジェクトがアーカイブ・削除されて一覧から消えたら、すべてに戻す
 * （アーカイブ済みのプロジェクトには未完了のタスクがないので、絞り込むと空になるだけのため）
 */
export function effectiveFilter(store: AppStore, filter: ProjectFilter): ProjectFilter {
  if (filter.kind !== "project") return filter;
  return store.lists.projects.some((project) => project.id === filter.id)
    ? filter
    : { kind: "all" };
}

/** 日付ごとの中身をまとめて作る（出すものがない日は入らない） */
export function entriesByDate(
  store: AppStore,
  filter: ProjectFilter,
): ReadonlyMap<string, DayEntries> {
  const { lists } = store;
  const days = new Map<string, { deadlines: TaskRow[]; tasks: TaskRow[] }>();
  const dayOf = (date: string) => {
    let day = days.get(date);
    if (!day) {
      day = { deadlines: [], tasks: [] };
      days.set(date, day);
    }
    return day;
  };
  const deadlineRows = [lists.today, lists.scheduled, lists.later, lists.inbox];
  for (const rows of deadlineRows) {
    for (const row of rows) {
      const deadlineOn = row.field("deadlineOn");
      if (deadlineOn !== null && matchesFilter(row, filter)) dayOf(deadlineOn).deadlines.push(row);
    }
  }
  const today = store.today;
  for (const row of lists.today) {
    if (matchesFilter(row, filter)) dayOf(today).tasks.push(row);
  }
  for (const row of lists.scheduled) {
    const scheduledOn = row.field("scheduledOn");
    if (scheduledOn !== null && matchesFilter(row, filter)) dayOf(scheduledOn).tasks.push(row);
  }
  return days;
}

/** マスに出す順（締切の◆が先、そのあとにタスク） */
export function entriesInOrder({ deadlines, tasks }: DayEntries): CalendarEntry[] {
  return [
    ...deadlines.map((task): CalendarEntry => ({ kind: "deadline", task })),
    ...tasks.map((task): CalendarEntry => ({ kind: "task", task })),
  ];
}

/**
 * カレンダーの計算。日付ごとの中身は、その日の中身が変わったときだけ知らせる
 * （あるマスのタスクを動かしても、ほかのマスは描き直さない）
 */
export class CalendarModel {
  readonly #byDate: IComputedValue<ReadonlyMap<string, DayEntries>>;
  readonly #days = new Map<string, IComputedValue<DayEntries>>();

  constructor(store: AppStore, filter: () => ProjectFilter) {
    this.#byDate = computed(() => entriesByDate(store, effectiveFilter(store, filter())));
  }

  /** その日の中身 */
  entriesOn(date: string): DayEntries {
    let day = this.#days.get(date);
    if (!day) {
      day = computed(() => this.#byDate.get().get(date) ?? EMPTY, { equals: sameEntries });
      this.#days.set(date, day);
    }
    return day.get();
  }
}
