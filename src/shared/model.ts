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

/** 未完了で、削除されていない */
export function isOpenTask(task: Pick<Task, "completedAt" | "deletedAt">): boolean {
  return task.completedAt === null && task.deletedAt === null;
}
