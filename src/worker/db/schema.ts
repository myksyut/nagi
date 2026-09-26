import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
// drizzle-kit もこのファイルを読むので、パスの別名（@shared）は使わない
import { BUCKETS, type ChecklistItem } from "../../shared/model";

/** ログインのセッション。id はセッションのトークンの SHA-256（16進）。トークンそのものは保存しない */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  /** ISO 8601（UTC） */
  expiresAt: text("expires_at").notNull(),
  /** ISO 8601（UTC） */
  createdAt: text("created_at").notNull(),
});

/**
 * タスク。列の意味は src/shared/model.ts の Task と同じ。
 * 日付は YYYY-MM-DD、時刻は ISO 8601（UTC）。seq は行を書き換えるたびに振る通し番号（src/worker/sync/seq.ts）
 */
export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    memo: text("memo").notNull().default(""),
    bucket: text("bucket", { enum: BUCKETS }).notNull(),
    scheduledOn: text("scheduled_on"),
    deadlineOn: text("deadline_on"),
    projectId: text("project_id"),
    rank: text("rank").notNull(),
    arrivedOn: text("arrived_on"),
    checklist: text("checklist", { mode: "json" }).$type<ChecklistItem[]>().notNull().default([]),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    seq: integer("seq").notNull(),
  },
  (t) => [
    uniqueIndex("tasks_seq_idx").on(t.seq),
    index("tasks_bucket_scheduled_on_idx").on(t.bucket, t.scheduledOn),
    index("tasks_deadline_on_idx").on(t.deadlineOn),
    // 列名はテーブル名を付けずに書く（drizzle-kit がテーブルを作り直すときに、別名のテーブルでも通るように）
    check("tasks_bucket_check", sql`bucket IN ('inbox', 'today', 'scheduled', 'later')`),
    // bucket が scheduled のときだけ scheduled_on が入る
    check("tasks_scheduled_on_check", sql`(bucket = 'scheduled') = (scheduled_on IS NOT NULL)`),
  ],
);

/** プロジェクト。列の意味は src/shared/model.ts の Project と同じ */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    deletedAt: text("deleted_at"),
    seq: integer("seq").notNull(),
  },
  (t) => [uniqueIndex("projects_seq_idx").on(t.seq)],
);

/**
 * key と value の表。行はマイグレーションで入れておく
 * - seq：これまでに振った通し番号の最大値
 * - last_rollover_on：最後に日付の切り替えを終えた日（論理日付。まだなら ""）
 * - purged_through_seq：物理削除した行の seq の最大値
 * value は TEXT。数として使うときは SQL の中で CAST する
 */
export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** 反映済みの操作のまとまり。再送による二重の書き込みを防ぐ。7 日たったら消す */
export const appliedMutations = sqliteTable("applied_mutations", {
  id: text("id").primaryKey(),
  /** ISO 8601（UTC） */
  appliedAt: text("applied_at").notNull(),
});
