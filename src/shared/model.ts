import type { ProjectColor } from "./palette";
import type { Points, Priority } from "./priority-points";

/**
 * タスクとプロジェクトの形。D1 の行（src/worker/db/schema.ts）と同じ形で、
 * 差分の取得（/api/sync）と操作の送信（/api/mutate）の応答にそのまま入る
 */

/** タスクの置き場。必ず1つだけ持つ */
export const BUCKETS = ["inbox", "today", "scheduled", "later"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** チェックリストの1項目 */
export type ChecklistItem = { id: string; title: string; done: boolean };

/**
 * 日付は YYYY-MM-DD（論理日付。logical-date.ts）、時刻は ISO 8601 の UTC（`toISOString()` の形）。
 * 空は null
 */
export type Task = {
  id: string;
  title: string;
  memo: string;
  bucket: Bucket;
  /** 予定の日付。bucket が scheduled のときだけ入る */
  scheduledOn: string | null;
  /** 締切 */
  deadlineOn: string | null;
  projectId: string | null;
  /** 置き場の中の並び順（fractional index。rank.ts） */
  rank: string;
  /** 日付の到来や締切で今日に入った日。「その日のあいだの印」に使う */
  arrivedOn: string | null;
  checklist: ChecklistItem[];
  /** 完了した時刻。未完了なら null。完了しても bucket は変えない */
  completedAt: string | null;
  /**
   * 進行中にした時刻。進行中でなければ null。入っているときは bucket が必ず today（サーバーでも検証する）。
   * 完了しても残す（直後に完了を取り消すと進行中に戻る）
   */
  startedAt: string | null;
  /** 優先度（高・中・低）。なしは null（3 番目の版で追加。priority-points.ts） */
  priority: Priority | null;
  /** 工数（1・2・3・5・8・13）。なしは null（3 番目の版で追加。priority-points.ts） */
  points: Points | null;
  createdAt: string;
  updatedAt: string;
  /** 削除した時刻（論理削除）。サーバーは 30 日後に物理削除する */
  deletedAt: string | null;
  /** 行を書き換えるたびにサーバーが振る通し番号。差分同期の基準 */
  seq: number;
};

export type Project = {
  id: string;
  name: string;
  /** パレットの色の名前（palette.ts）。空なら作成順で決まる色を使う（resolveProjectColors） */
  color: ProjectColor | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  seq: number;
};

/** 差分の取得と操作の送信で返る行。seq の順に並ぶ */
export type SyncRow = { kind: "task"; row: Task } | { kind: "project"; row: Project };

/** bucket が scheduled のときだけ scheduledOn が入る（サーバーでも検証する） */
export function isScheduleConsistent(task: Pick<Task, "bucket" | "scheduledOn">): boolean {
  return (task.bucket === "scheduled") === (task.scheduledOn !== null);
}

/** startedAt が入っているなら bucket は today（サーバーの検証と D1 の CHECK 制約でも守る） */
export function isStartConsistent(task: Pick<Task, "bucket" | "startedAt">): boolean {
  return task.startedAt === null || task.bucket === "today";
}

/**
 * タスクの状態（置き場とは別）。完了は completedAt、進行中は「startedAt があり completedAt がない」で表す。
 * 完了したタスクは startedAt が残っていても完了
 */
export type TaskStatus = "not-started" | "in-progress" | "completed";

export function taskStatus(task: Pick<Task, "completedAt" | "startedAt">): TaskStatus {
  if (task.completedAt !== null) return "completed";
  return task.startedAt !== null ? "in-progress" : "not-started";
}

/** チェックリストが同じか（項目の順・id・名前・チェック） */
export function sameChecklist(a: readonly ChecklistItem[], b: readonly ChecklistItem[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        item.id === other.id &&
        item.title === other.title &&
        item.done === other.done
      );
    })
  );
}

/** 未完了で、削除されていない */
export function isOpenTask(task: Pick<Task, "completedAt" | "deletedAt">): boolean {
  return task.completedAt === null && task.deletedAt === null;
}
