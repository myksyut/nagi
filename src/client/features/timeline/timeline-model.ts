import { computed, type IComputedValue, makeObservable, observableRef, reaction } from "mobx";
import type { AppStore, TaskRow } from "@/data";
import { addDays } from "@/data/logical-day";
import { daysBetween } from "@/features/dates/labels";

/**
 * タイムラインの中身（Core Flows のフロー5「タイムライン」）。
 * - 横：1 週前から 8 週先までの日付
 * - 縦：プロジェクトごとのまとまり（プロジェクトの作成順。プロジェクトなしは最後）。まとまりの中は、やる日の順
 * - 棒：やる日（予定は予定の日付、今日のタスクは今日。進行中も今日）から締切まで。締切がなければ1日の棒。
 *   締切がやる日より前なら、やる日に1日の棒と、締切の位置に離れた◆
 * - やる日のないタスク（受信箱・あとで）で締切があるものは◆だけ。やる日も締切もないタスクと、完了したタスクは出さない
 * - 表示の範囲に棒も◆も入らないタスクは、行ごと出さない
 * 未完了のリスト（今日・予定・あとで・受信箱）を読み、予定の日付・締切・プロジェクトは行ごとに項目だけを観測する
 * （行全体を観測すると、タイトルを打つたびに計算し直してしまう。peek() では変化を取りこぼす）
 */

/** 今日より前に出す週の数 */
export const WEEKS_BEFORE = 1;
/** 今日より先に出す週の数 */
export const WEEKS_AFTER = 8;

/** 表示の範囲（両端を含む）。days は日の数 */
export type TimelineRange = { start: string; end: string; days: number };

export function timelineRange(today: string): TimelineRange {
  const start = addDays(today, -7 * WEEKS_BEFORE);
  const end = addDays(today, 7 * WEEKS_AFTER);
  return { start, end, days: daysBetween(start, end) + 1 };
}

/**
 * 棒か◆の形。日付は論理日付（YYYY-MM-DD）
 * - bar：from（やる日）から to まで。締切がやる日以降なら to は締切で、右端に◆（endDiamond）。
 *   締切がやる日より前なら to はやる日（1日の棒）で、締切は離れた◆（looseDeadline）
 * - diamond：やる日がなく、締切の◆だけ
 */
export type TimelineShape =
  | { kind: "bar"; from: string; to: string; endDiamond: boolean; looseDeadline: string | null }
  | { kind: "diamond"; on: string };

/** やる日と締切から、棒か◆の形を決める（どちらもなければ null） */
export function shapeOf(doOn: string | null, deadlineOn: string | null): TimelineShape | null {
  if (doOn !== null) {
    if (deadlineOn !== null && deadlineOn >= doOn) {
      return { kind: "bar", from: doOn, to: deadlineOn, endDiamond: true, looseDeadline: null };
    }
    return { kind: "bar", from: doOn, to: doOn, endDiamond: false, looseDeadline: deadlineOn };
  }
  return deadlineOn === null ? null : { kind: "diamond", on: deadlineOn };
}

/** 未完了のタスクの置き場 */
export type OpenBucket = "inbox" | "today" | "scheduled" | "later";

/** 置き場と予定の日付から、やる日（予定は予定の日付、今日のタスクは今日、ほかは null） */
export function doOnOf(
  bucket: OpenBucket,
  scheduledOn: string | null,
  today: string,
): string | null {
  if (bucket === "today") return today;
  if (bucket === "scheduled") return scheduledOn;
  return null;
}

function within(date: string, range: TimelineRange): boolean {
  return date >= range.start && date <= range.end;
}

/** 棒か◆のどこかが、表示の範囲に入るか */
export function isInRange(shape: TimelineShape, range: TimelineRange): boolean {
  if (shape.kind === "diamond") return within(shape.on, range);
  if (shape.from <= range.end && shape.to >= range.start) return true;
  return shape.looseDeadline !== null && within(shape.looseDeadline, range);
}

/**
 * タイムラインの1行。置き場・やる日・締切が前と同じなら、同じオブジェクトのまま使う
 * （1件の日付を変えても、ほかの行の部品に新しい props を渡さないように）
 */
export type TimelineItem = {
  task: TaskRow;
  bucket: OpenBucket;
  doOn: string | null;
  deadlineOn: string | null;
  shape: TimelineShape;
};

/** プロジェクトごとのまとまり。projectId が null なら「プロジェクトなし」。行が前と同じなら、同じオブジェクトのまま使う */
export type TimelineGroup = {
  key: string;
  projectId: string | null;
  items: readonly TimelineItem[];
};

/** 絞り込み：すべて・1つのプロジェクト・プロジェクトなし */
export type ProjectFilter = { kind: "all" } | { kind: "none" } | { kind: "project"; id: string };

export const ALL_PROJECTS: ProjectFilter = { kind: "all" };

const NO_PROJECT_KEY = "none";

function compareNullable(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

/** 並び（行もまとまりも、同じオブジェクトを使い回すので、参照で比べる） */
function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * タイムラインの並びを計算する。未完了のタスクを、プロジェクトごとのまとまりに分けて返す
 * （行が1つもないまとまりは入れない）。範囲の外のタスクは入れない。
 * previous（前に計算した並び）を渡すと、置き場・やる日・締切が同じ行と、行が同じまとまりは、前のオブジェクトを使う
 */
export function computeTimelineGroups(
  store: AppStore,
  filter: ProjectFilter,
  previous: readonly TimelineGroup[] = [],
): readonly TimelineGroup[] {
  const previousItems = new Map<TaskRow, TimelineItem>();
  const previousGroups = new Map<string, TimelineGroup>();
  for (const group of previous) {
    previousGroups.set(group.key, group);
    for (const item of group.items) previousItems.set(item.task, item);
  }
  const today = store.today;
  const range = timelineRange(today);
  const { lists } = store;
  // 置き場ごとの並び（今日は並び順、予定は日付順、あとでは並び順、受信箱は古い順）を、同じ日の中の並びに使う
  const sources: [TaskRow, OpenBucket][] = [
    ...lists.today.map((row) => [row, "today"] as [TaskRow, OpenBucket]),
    ...lists.scheduled.map((row) => [row, "scheduled"] as [TaskRow, OpenBucket]),
    ...lists.later.map((row) => [row, "later"] as [TaskRow, OpenBucket]),
    ...lists.inbox.map((row) => [row, "inbox"] as [TaskRow, OpenBucket]),
  ];
  const byProject = new Map<string | null, { item: TimelineItem; index: number }[]>();
  sources.forEach(([task, bucket], index) => {
    const doOn = doOnOf(bucket, task.field("scheduledOn"), today);
    const deadlineOn = task.field("deadlineOn");
    const kept = previousItems.get(task);
    const same =
      kept !== undefined &&
      kept.bucket === bucket &&
      kept.doOn === doOn &&
      kept.deadlineOn === deadlineOn;
    const shape = same ? kept.shape : shapeOf(doOn, deadlineOn);
    if (!shape || !isInRange(shape, range)) return;
    const projectId = liveProjectId(store, task.field("projectId"));
    if (filter.kind === "none" && projectId !== null) return;
    if (filter.kind === "project" && projectId !== filter.id) return;
    let items = byProject.get(projectId);
    if (!items) {
      items = [];
      byProject.set(projectId, items);
    }
    items.push({ item: same ? kept : { task, bucket, doOn, deadlineOn, shape }, index });
  });
  // プロジェクトの作成順（アーカイブ済みのプロジェクトに未完了が残っていても出す）。プロジェクトなしは最後
  const projectIds = [...byProject.keys()]
    .filter((id): id is string => id !== null)
    .sort((a, b) => {
      const createdA = store.project(a)?.field("createdAt") ?? "";
      const createdB = store.project(b)?.field("createdAt") ?? "";
      return createdA < createdB ? -1 : createdA > createdB ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
  const order: (string | null)[] = byProject.has(null) ? [...projectIds, null] : projectIds;
  return order.map((projectId) => {
    const key = projectId ?? NO_PROJECT_KEY;
    // やる日の順（やる日のない◆だけの行は後ろ）。同じなら締切の順、さらに同じなら置き場の並び
    const items = (byProject.get(projectId) ?? [])
      .sort(
        (a, b) =>
          compareNullable(a.item.doOn, b.item.doOn) ||
          compareNullable(a.item.deadlineOn, b.item.deadlineOn) ||
          a.index - b.index,
      )
      .map(({ item }) => item);
    const kept = previousGroups.get(key);
    return kept && sameList(kept.items, items) ? kept : { key, projectId, items };
  });
}

/** プロジェクトの id（削除済みか、ないプロジェクトなら null＝プロジェクトなし） */
function liveProjectId(store: AppStore, projectId: string | null): string | null {
  if (projectId === null) return null;
  const project = store.project(projectId);
  return project && project.field("deletedAt") === null ? projectId : null;
}

/**
 * タイムラインの画面の状態：絞り込みと、並びの計算。並びは、中身（行とその日付）が前と同じなら知らせない。
 * ストアごとに1つ（timelineModelOf）なので、画面を離れて戻っても同じ絞り込みで開く（再読み込みでは「すべて」に戻る）。
 * 絞り込んでいたプロジェクトがアーカイブ・削除されたら、「すべて」に戻す（カレンダーと同じ。あとでアーカイブを解除しても戻らない）
 */
export class TimelineModel {
  filter: ProjectFilter = ALL_PROJECTS;
  readonly #store: AppStore;
  readonly #groups: IComputedValue<readonly TimelineGroup[]>;
  /** 前に計算した並び（変わっていない行とまとまりを、同じオブジェクトのまま使う） */
  #previous: readonly TimelineGroup[] = [];

  constructor(store: AppStore) {
    this.#store = store;
    this.#groups = computed(
      () => {
        this.#previous = computeTimelineGroups(this.#store, this.filter, this.#previous);
        return this.#previous;
      },
      { equals: sameList },
    );
    makeObservable(this, { filter: observableRef, setFilter: true });
    // 手元の控えを読み終える前は、プロジェクトの一覧が空なので見ない
    reaction(
      () => {
        const { filter } = this;
        return (
          filter.kind === "project" &&
          store.loaded &&
          !store.lists.projects.some((project) => project.id === filter.id)
        );
      },
      (gone) => {
        if (gone) this.setFilter(ALL_PROJECTS);
      },
      { fireImmediately: true },
    );
  }

  get groups(): readonly TimelineGroup[] {
    return this.#groups.get();
  }

  setFilter(filter: ProjectFilter): void {
    this.filter = filter;
  }
}

const models = new WeakMap<AppStore, TimelineModel>();

/** ストアごとのタイムラインの状態 */
export function timelineModelOf(store: AppStore): TimelineModel {
  let model = models.get(store);
  if (!model) {
    model = new TimelineModel(store);
    models.set(store, model);
  }
  return model;
}
