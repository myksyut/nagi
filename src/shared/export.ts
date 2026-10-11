import { z } from "zod";
import { isScheduleConsistent, isStartConsistent } from "./model";
import { idSchema, projectCreateSchema, taskCreateSchema, timestampSchema } from "./mutations";

/**
 * 書き出し（`nagi export`）の JSON の形。端末のデータとクラウドで同じ形にして、取り込み（POST /api/import）も同じ形を受ける。
 * 行の項目は、操作（mutations.ts）の作成と同じスキーマで確かめ、そこにない項目（完了・開始・アーカイブの時刻、
 * 作成・更新の時刻、seq）を足す。論理削除の行は入れない（deletedAt は必ず null）。端末のデータの seq は、
 * まだ Worker にない行では 0。クラウドのデータは、GET /api/export のページ（ExportPage）を TUI がこの形につなげる
 */
export const EXPORT_FORMAT = "nagi-export";
export const EXPORT_FORMAT_VERSION = 1;

export const exportTaskSchema = z
  .strictObject({
    ...taskCreateSchema.shape.task.shape,
    completedAt: timestampSchema.nullable(),
    startedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: z.null(),
    seq: z.int().nonnegative(),
  })
  .refine(isScheduleConsistent, "schedule_mismatch")
  .refine(isStartConsistent, "started_outside_today");

export const exportProjectSchema = z.strictObject({
  ...projectCreateSchema.shape.project.shape,
  archivedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: z.null(),
  seq: z.int().nonnegative(),
});

export const exportSchema = z.strictObject({
  format: z.literal(EXPORT_FORMAT),
  formatVersion: z.literal(EXPORT_FORMAT_VERSION),
  exportedAt: timestampSchema,
  /** 書き出した側。端末は `nagi <版>`、クラウドは `nagi-worker` */
  app: z.string(),
  projects: z.array(exportProjectSchema),
  tasks: z.array(exportTaskSchema),
});

export type ExportDocument = z.output<typeof exportSchema>;

export const EXPORT_KINDS = ["projects", "tasks"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

/**
 * GET /api/export の問い合わせ。kind の行を、id が after より後のものから 1 ページ返す
 * （after を省くと最初から）。projects を読み終えてから tasks を読む
 */
export const exportPageQuerySchema = z.strictObject({
  kind: z.enum(EXPORT_KINDS),
  after: idSchema.optional(),
});

export type ExportHeader = Pick<ExportDocument, "format" | "formatVersion" | "exportedAt" | "app">;

/**
 * GET /api/export の応答。rows は id の順。next は次のページの after で、null ならその kind は終わり。
 * 最初のページ（kind=projects で after なし）にだけ、ファイルの頭の項目（ExportHeader）が付く
 */
export type ExportPage<Row> = Partial<ExportHeader> & { rows: Row[]; next: string | null };
