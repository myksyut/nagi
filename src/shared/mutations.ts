import { z } from "zod";
import { BUCKETS } from "./model";
import { isValidRank } from "./rank";

/**
 * 操作（/api/mutate）の検証スキーマ。画面とサーバーで同じものを使う。
 * 1回のユーザー操作が1つのまとまり（MutationBatch）になり、サーバーは全部成功か全部失敗にする
 */

/**
 * 1つのまとまりに入れられる操作の数。D1 へのクエリは 1 回の呼び出しで 1000 までなので、
 * 行ごとの書き込みと検証の読み取りがそれに収まるようにする
 */
export const MAX_MUTATIONS_PER_BATCH = 500;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ID は小文字の UUID（画面側で UUIDv7 を採番する） */
export const idSchema = z.string().regex(UUID_PATTERN, "invalid_id");
/** 日付（YYYY-MM-DD） */
export const dateSchema = z.iso.date();
/** 時刻（ISO 8601 の UTC）。`toISOString()` の形にそろえて保存する（文字列の大小で比べられるように） */
export const timestampSchema = z.iso.datetime().transform((value) => new Date(value).toISOString());
export const bucketSchema = z.enum(BUCKETS);
export const rankSchema = z.string().refine(isValidRank, "invalid_rank");
/** 空白だけのタイトルや名前は不可 */
const nonBlankSchema = z.string().refine((value) => value.trim().length > 0, "blank");

export const checklistItemSchema = z.strictObject({
  id: idSchema,
  title: z.string(),
  done: z.boolean(),
});

const taskFields = {
  title: nonBlankSchema,
  memo: z.string(),
  bucket: bucketSchema,
  scheduledOn: dateSchema.nullable(),
  deadlineOn: dateSchema.nullable(),
  projectId: idSchema.nullable(),
  rank: rankSchema,
  arrivedOn: dateSchema.nullable(),
  checklist: z.array(checklistItemSchema),
  completedAt: timestampSchema.nullable(),
  deletedAt: timestampSchema.nullable(),
};

const hasSomeChange = (changes: object) => Object.keys(changes).length > 0;

/** 作成。省略した項目は空（メモは ""、チェックリストは []、ほかは null） */
export const taskCreateSchema = z.strictObject({
  type: z.literal("task.create"),
  task: z.strictObject({
    id: idSchema,
    title: taskFields.title,
    memo: taskFields.memo.default(""),
    bucket: taskFields.bucket,
    scheduledOn: taskFields.scheduledOn.default(null),
    deadlineOn: taskFields.deadlineOn.default(null),
    projectId: taskFields.projectId.default(null),
    rank: taskFields.rank,
    arrivedOn: taskFields.arrivedOn.default(null),
    checklist: taskFields.checklist.default(() => []),
  }),
});

/** 更新。変える項目だけを送る。削除は deletedAt を入れる更新、削除の取り消しは deletedAt を null にする更新 */
export const taskUpdateSchema = z.strictObject({
  type: z.literal("task.update"),
  id: idSchema,
  changes: z.strictObject(taskFields).partial().refine(hasSomeChange, "no_changes"),
});

export const projectCreateSchema = z.strictObject({
  type: z.literal("project.create"),
  project: z.strictObject({ id: idSchema, name: nonBlankSchema }),
});

/** 更新。アーカイブは archivedAt を入れる更新（未完了のタスクが残っていると 400） */
export const projectUpdateSchema = z.strictObject({
  type: z.literal("project.update"),
  id: idSchema,
  changes: z
    .strictObject({
      name: nonBlankSchema,
      archivedAt: timestampSchema.nullable(),
      deletedAt: timestampSchema.nullable(),
    })
    .partial()
    .refine(hasSomeChange, "no_changes"),
});

export const mutationSchema = z.discriminatedUnion("type", [
  taskCreateSchema,
  taskUpdateSchema,
  projectCreateSchema,
  projectUpdateSchema,
]);

/** 操作のまとまり。id（UUIDv7）で再送を見分ける */
export const mutationBatchSchema = z.strictObject({
  id: idSchema,
  mutations: z.array(mutationSchema).min(1).max(MAX_MUTATIONS_PER_BATCH),
});

/** 画面が送る形（省略できる項目は省略してよい） */
export type Mutation = z.input<typeof mutationSchema>;
export type MutationBatch = z.input<typeof mutationBatchSchema>;
/** 検証したあとの形（省略した項目に既定値が入る） */
export type ParsedMutation = z.output<typeof mutationSchema>;
export type ParsedMutationBatch = z.output<typeof mutationBatchSchema>;
export type TaskChanges = z.output<typeof taskUpdateSchema>["changes"];
export type ProjectChanges = z.output<typeof projectUpdateSchema>["changes"];
