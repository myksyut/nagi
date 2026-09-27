import { logicalDate } from "@shared/logical-date";
import type { Bucket } from "@shared/model";
import { type ProjectColor, resolveProjectColors } from "@shared/palette";
import { compareRank } from "@shared/rank";
import { compareShallow, computed, type IComputedValue, makeObservable } from "mobx";
import { addDays, dayStart, type LogicalDay } from "./logical-day";
import type { Replica } from "./replica";
import type { ProjectRow, TaskPartition, TaskRow } from "./rows";

/**
 * 各リストの中身と並び（Core Flows どおり）。ストアから計算する値で、
 * 行が出入りしたときと並びに効く項目が変わったときだけ計算し直す。
 * 中身と並びが前と同じなら、リストを読んでいる部品には知らせない（行の中身の変化は行ごとに知らせる）
 */

/** 完了ログの1日ぶん */
export type LogbookDay = { date: string; tasks: readonly TaskRow[] };

/** プロジェクトの画面：未完了を置き場ごとに、完了済み（全期間）を最後に */
export type ProjectTaskGroups = {
  today: readonly TaskRow[];
  scheduled: readonly TaskRow[];
  later: readonly TaskRow[];
  inbox: readonly TaskRow[];
  completed: readonly TaskRow[];
};

/**
 * 今日のボード（状態の列）。未着手と進行中は今日のリストと同じ並び（並び順キーの順）、
 * 完了は今日の「完了 N件」と同じ（今日完了したもの。新しい順）
 */
export type TodayBoard = {
  notStarted: readonly TaskRow[];
  inProgress: readonly TaskRow[];
  completed: readonly TaskRow[];
};

/**
 * プロジェクトのボード。未着手は置き場のまとまりごと（今日は進行中を除く。並びはプロジェクトの画面と同じ）、
 * 進行中は今日の並び順キーの順、完了は直近 PROJECT_BOARD_COMPLETED_DAYS 日（論理日付で今日を含む）に完了したもの
 * （新しい順）
 */
export type ProjectBoard = {
  notStarted: {
    today: readonly TaskRow[];
    scheduled: readonly TaskRow[];
    later: readonly TaskRow[];
    inbox: readonly TaskRow[];
  };
  inProgress: readonly TaskRow[];
  completed: readonly TaskRow[];
};

/** プロジェクトのボードの完了の列に出す日数（今日を含む。それより前は完了ログで見る） */
export const PROJECT_BOARD_COMPLETED_DAYS = 7;

type Compare = (a: TaskRow, b: TaskRow) => number;

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 古い順（作成順）。同じなら id の順 */
const byCreated: Compare = (a, b) =>
  compareStrings(a.peek().createdAt, b.peek().createdAt) || compareStrings(a.id, b.id);

/** 並び順キーの順。重なったら id の順 */
const byRank: Compare = (a, b) => compareRank(a.peek(), b.peek());

/** 予定の日付の順。同じ日の中は並び順キーの順 */
const bySchedule: Compare = (a, b) =>
  compareStrings(a.peek().scheduledOn ?? "", b.peek().scheduledOn ?? "") || byRank(a, b);

/** 完了した時刻の新しい順 */
const byCompletedDesc: Compare = (a, b) =>
  compareStrings(b.peek().completedAt ?? "", a.peek().completedAt ?? "") ||
  compareStrings(b.id, a.id);

/** 未完了のタスクの置き場ごとの並び */
const BUCKET_ORDER: Record<Bucket, Compare> = {
  inbox: byCreated,
  today: byRank,
  scheduled: bySchedule,
  later: byRank,
};

function sorted(rows: Iterable<TaskRow>, compare: Compare): TaskRow[] {
  return Array.from(rows).sort(compare);
}

function sameLogbook(a: readonly LogbookDay[], b: readonly LogbookDay[]): boolean {
  return (
    a.length === b.length &&
    a.every((day, i) => day.date === b[i]?.date && compareShallow(day.tasks, b[i]?.tasks))
  );
}

function sameGroups(a: ProjectTaskGroups, b: ProjectTaskGroups): boolean {
  return (Object.keys(a) as (keyof ProjectTaskGroups)[]).every((key) =>
    compareShallow(a[key], b[key]),
  );
}

function sameTodayBoard(a: TodayBoard, b: TodayBoard): boolean {
  return (
    compareShallow(a.notStarted, b.notStarted) &&
    compareShallow(a.inProgress, b.inProgress) &&
    compareShallow(a.completed, b.completed)
  );
}

function sameProjectBoard(a: ProjectBoard, b: ProjectBoard): boolean {
  return (
    compareShallow(a.inProgress, b.inProgress) &&
    compareShallow(a.completed, b.completed) &&
    (Object.keys(a.notStarted) as (keyof ProjectBoard["notStarted"])[]).every((key) =>
      compareShallow(a.notStarted[key], b.notStarted[key]),
    )
  );
}

function sameColors(a: ReadonlyMap<string, ProjectColor>, b: ReadonlyMap<string, ProjectColor>) {
  if (a.size !== b.size) return false;
  for (const [id, color] of a) if (b.get(id) !== color) return false;
  return true;
}

/**
 * 今日の行を、未着手と進行中に分ける（並びは保つ）。
 * startedAt は行ごとに項目だけを観測する（行の並びが同じまま進行中にしても、分け直しが取りこぼされないように）
 */
function splitByStarted(rows: readonly TaskRow[]): {
  notStarted: TaskRow[];
  inProgress: TaskRow[];
} {
  const notStarted: TaskRow[] = [];
  const inProgress: TaskRow[] = [];
  for (const row of rows) (row.startedAt !== null ? inProgress : notStarted).push(row);
  return { notStarted, inProgress };
}

export class TaskLists {
  readonly #replica: Replica;
  readonly #day: LogicalDay;
  readonly #projectGroups = new Map<string, IComputedValue<ProjectTaskGroups>>();
  readonly #projectBoards = new Map<string, IComputedValue<ProjectBoard>>();

  constructor(replica: Replica, day: LogicalDay) {
    this.#replica = replica;
    this.#day = day;
    const list = computed({ equals: compareShallow });
    makeObservable(this, {
      inbox: list,
      today: list,
      scheduled: list,
      later: list,
      completedToday: list,
      logbook: computed({ equals: sameLogbook }),
      projects: list,
      todayBoard: computed({ equals: sameTodayBoard }),
      projectColors: computed({ equals: sameColors }),
    });
  }

  /** 受信箱：古い順 */
  get inbox(): readonly TaskRow[] {
    return this.#open("inbox");
  }

  /** 今日：並び順キーの順（日付の到来や締切で入ったものは、サーバーが一番上のキーを振る） */
  get today(): readonly TaskRow[] {
    return this.#open("today");
  }

  /** 予定：日付の順 */
  get scheduled(): readonly TaskRow[] {
    return this.#open("scheduled");
  }

  /** あとで：並び順キーの順（プロジェクトごとのまとまりは 6 で画面が作る） */
  get later(): readonly TaskRow[] {
    return this.#open("later");
  }

  /** 今日の「完了 N件」：今日（論理日付）完了したもの。どの置き場で完了したものも入る。新しい順 */
  get completedToday(): readonly TaskRow[] {
    const startsAt = this.#day.startsAt;
    const rows = this.#rows("completed");
    const today: TaskRow[] = [];
    for (const row of rows) {
      if ((row.peek().completedAt ?? "") >= startsAt) today.push(row);
    }
    return today.sort(byCompletedDesc);
  }

  get completedTodayCount(): number {
    return this.completedToday.length;
  }

  /** サイドバーの受信箱の件数 */
  get inboxCount(): number {
    return this.inbox.length;
  }

  get todayCount(): number {
    return this.today.length;
  }

  /**
   * 完了ログ：昨日まで（論理日付）に完了したものを、完了した日ごとに新しい順で。
   * 今日完了したものは午前4時までは「完了 N件」にあり、日付が変わると完了ログに移る
   */
  get logbook(): readonly LogbookDay[] {
    const startsAt = this.#day.startsAt;
    const rows = sorted(
      Array.from(this.#rows("completed")).filter(
        (row) => (row.peek().completedAt ?? "") < startsAt,
      ),
      byCompletedDesc,
    );
    const days: { date: string; tasks: TaskRow[] }[] = [];
    let current: { date: string; tasks: TaskRow[] } | undefined;
    let currentStartsAt = "";
    for (const row of rows) {
      const completedAt = row.peek().completedAt ?? "";
      if (!current || completedAt < currentStartsAt) {
        const date = logicalDate(new Date(completedAt), this.#day.timeZone);
        current = { date, tasks: [] };
        currentStartsAt = dayStart(date, this.#day.timeZone).toISOString();
        days.push(current);
      }
      current.tasks.push(row);
    }
    return days;
  }

  /** サイドバーと p の候補に出すプロジェクト（アーカイブ済み・削除済みを除く）。作成順 */
  get projects(): readonly ProjectRow[] {
    return this.#replica
      .allProjects()
      .filter((project) => {
        const { archivedAt, deletedAt } = project.peek();
        return archivedAt === null && deletedAt === null;
      })
      .sort(
        (a, b) =>
          compareStrings(a.peek().createdAt, b.peek().createdAt) || compareStrings(a.id, b.id),
      );
  }

  /** 今日のボード：今日のタスクを状態（未着手・進行中・完了）で分けたもの */
  get todayBoard(): TodayBoard {
    return { ...splitByStarted(this.today), completed: this.completedToday };
  }

  /** 今日の進行中のタスク（今日の並び順キーの順） */
  get inProgressToday(): readonly TaskRow[] {
    return this.todayBoard.inProgress;
  }

  get inProgressTodayCount(): number {
    return this.inProgressToday.length;
  }

  /** プロジェクトのボード：そのプロジェクトのタスクを状態（未着手・進行中・完了）で分けたもの */
  projectBoard(projectId: string): ProjectBoard {
    let board = this.#projectBoards.get(projectId);
    if (!board) {
      board = computed(() => this.#computeProjectBoard(projectId), { equals: sameProjectBoard });
      this.#projectBoards.set(projectId, board);
    }
    return board.get();
  }

  /** そのプロジェクトの進行中のタスクの数 */
  inProgressCountOfProject(projectId: string): number {
    return this.projectBoard(projectId).inProgress.length;
  }

  /**
   * 各プロジェクトの色（id → パレットの名前）。color があればその色、空なら作成順で決まる色
   * （削除済みを除くすべてのプロジェクトを、アーカイブ済みも含めて作成順に並べた i 番目に、i を 8 で割った余りの色）。
   * 削除済みのプロジェクトは入らない
   */
  get projectColors(): ReadonlyMap<string, ProjectColor> {
    return resolveProjectColors(this.#replica.allProjects().map((project) => project.peek()));
  }

  /** プロジェクトの色（パレットの名前）。削除済みか、ないプロジェクトなら undefined */
  projectColor(projectId: string): ProjectColor | undefined {
    return this.projectColors.get(projectId);
  }

  /** プロジェクトの画面のタスク */
  project(projectId: string): ProjectTaskGroups {
    let groups = this.#projectGroups.get(projectId);
    if (!groups) {
      groups = computed(() => this.#computeProjectGroups(projectId), { equals: sameGroups });
      this.#projectGroups.set(projectId, groups);
    }
    return groups.get();
  }

  /** そのプロジェクトの未完了のタスクの数（アーカイブできるかの確認に使う） */
  openTaskCountOfProject(projectId: string): number {
    const { today, scheduled, later, inbox } = this.project(projectId);
    return today.length + scheduled.length + later.length + inbox.length;
  }

  /** 到着の印：日付の到来や締切で今日に入った日（arrivedOn）が今日 */
  isArrivedToday(task: TaskRow): boolean {
    return task.arrivedOn === this.#day.today;
  }

  #rows(partition: TaskPartition): ReadonlySet<TaskRow> {
    return this.#replica.taskIndex.rows(partition);
  }

  #open(bucket: Bucket): TaskRow[] {
    return sorted(this.#rows(bucket), BUCKET_ORDER[bucket]);
  }

  #computeProjectBoard(projectId: string): ProjectBoard {
    const { today, scheduled, later, inbox, completed } = this.project(projectId);
    const { notStarted, inProgress } = splitByStarted(today);
    // 論理日付で今日を含む直近 7 日。完了した時刻は行ごとに項目だけを観測する（完了の列の並びが同じまま
    // 完了した時刻だけが変わっても、区切りの判定を取りこぼさないように）
    const since = dayStart(
      addDays(this.#day.today, -(PROJECT_BOARD_COMPLETED_DAYS - 1)),
      this.#day.timeZone,
    ).toISOString();
    return {
      notStarted: { today: notStarted, scheduled, later, inbox },
      inProgress,
      completed: completed.filter((row) => (row.field("completedAt") ?? "") >= since),
    };
  }

  #computeProjectGroups(projectId: string): ProjectTaskGroups {
    const inProject = (partition: TaskPartition) =>
      Array.from(this.#rows(partition)).filter((row) => row.peek().projectId === projectId);
    return {
      today: inProject("today").sort(BUCKET_ORDER.today),
      scheduled: inProject("scheduled").sort(BUCKET_ORDER.scheduled),
      later: inProject("later").sort(BUCKET_ORDER.later),
      inbox: inProject("inbox").sort(BUCKET_ORDER.inbox),
      completed: inProject("completed").sort(byCompletedDesc),
    };
  }
}
