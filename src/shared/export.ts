import { z } from "zod";
import { BUCKETS } from "./model";
import {
  checklistItemSchema,
  dateSchema,
  idSchema,
  pointsSchema,
  prioritySchema,
  projectColorSchema,
  rankSchema,
  timestampSchema,
} from "./mutations";

/**
 * 書き出しのファイル（`nagi export`）の形。端末のデータとクラウドで同じ形にして、
 * 一つの取り込みで読めるようにする。行は /api/sync で返る行（src/shared/model.ts）のまま並べる（並びに意味はない）。
 * 論理削除の行は入れない。端末のデータの seq は、まだ Worker にない行では 0。
 * クラウドのデータは、GET /api/export のページ（ExportPage）を TUI がこの形につなげる
 */
export const EXPORT_FORMAT = "nagi-export";
export const EXPORT_FORMAT_VERSION = 1;

const seqSchema = z.number().int().nonnegative();

export const exportTaskSchema = z.object({
  id: idSchema,
  title: z.string(),
  memo: z.string(),
  bucket: z.enum(BUCKETS),
  scheduledOn: dateSchema.nullable(),
  deadlineOn: dateSchema.nullable(),
  projectId: idSchema.nullable(),
  rank: rankSchema,
  arrivedOn: dateSchema.nullable(),
  checklist: z.array(checklistItemSchema),
  completedAt: timestampSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  priority: prioritySchema.nullable(),
  points: pointsSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: z.null(),
  seq: seqSchema,
});

export const exportProjectSchema = z.object({
  id: idSchema,
  name: z.string(),
  color: projectColorSchema.nullable(),
  archivedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  deletedAt: z.null(),
  seq: seqSchema,
});

export const exportSchema = z.object({
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
