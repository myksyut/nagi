import { env } from "cloudflare:test";
import type { ApiErrorResponse, MutateResponse, SyncResponse } from "@shared/api";
import { API_VERSION, API_VERSION_HEADER } from "@shared/api";
import type { Project, SyncRow, Task } from "@shared/model";
import { mutationBatchSchema, type ParsedMutationBatch } from "@shared/mutations";
import { rankAfter } from "@shared/rank";
import { eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { type Db, getDb } from "../db/client";
import { appliedMutations, meta, projects, tasks } from "../db/schema";
import { createApp } from "../index";

/** 各テストの前に呼ぶ。tasks・projects・applied_mutations を空にし、meta を初期値（seq=0、last_rollover_on=''、purged_through_seq=0）に戻す */
export async function resetSyncTables(db: Db = getDb(env.DB)): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [
    db.delete(tasks),
    db.delete(projects),
    db.delete(appliedMutations),
    db.update(meta).set({ value: "0" }).where(eq(meta.key, "seq")),
    db.update(meta).set({ value: "" }).where(eq(meta.key, "last_rollover_on")),
    db.update(meta).set({ value: "0" }).where(eq(meta.key, "purged_through_seq")),
  ];
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

const BASE_HEADERS: Record<string, string> = {
  Origin: "http://localhost",
  "Content-Type": "application/json",
  [API_VERSION_HEADER]: String(API_VERSION),
};

/**
 * now を差し替えたアプリを作り、ログイン済み（AUTH_DISABLED）で POST するための小さなヘルパー。
 * headerOverrides に undefined を渡すと、そのヘッダを外す（X-Api-Version 抜きのテストなどに使う）
 */
export function apiApp(now: () => Date = () => new Date()) {
  const app = createApp({ now });
  const post = (
    path: string,
    body: unknown,
    headerOverrides: Record<string, string | undefined> = {},
    origin: string = "http://localhost",
  ) => {
    const headers: Record<string, string> = { ...BASE_HEADERS, Origin: origin };
    for (const [key, value] of Object.entries(headerOverrides)) {
      if (value === undefined) delete headers[key];
      else headers[key] = value;
    }
    return app.request(
      `${origin}${path}`,
      { method: "POST", headers, body: JSON.stringify(body) },
      { ...env, AUTH_DISABLED: "true" },
    );
  };
  return { app, post };
}

/** 検証を通る最小のタスク作成の中身。overrides で上書きする */
export function taskInput(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    title: "task",
    bucket: "inbox",
    rank: rankAfter(null),
    ...overrides,
  };
}

/** 検証を通る最小のプロジェクト作成の中身 */
export function projectInput(overrides: Record<string, unknown> = {}) {
  return { id: crypto.randomUUID(), name: "project", ...overrides };
}

export function mutationBatch(mutations: unknown[], id: string = crypto.randomUUID()) {
  return { id, mutations };
}

/** applyMutationBatch / rolloverIfDue を直接呼ぶテスト用に、まとまりを検証済みの形にする */
export function parseBatch(
  mutations: unknown[],
  id: string = crypto.randomUUID(),
): ParsedMutationBatch {
  return mutationBatchSchema.parse({ id, mutations });
}

/** meta.seq の今の値（数） */
export async function metaSeq(db: Db): Promise<number> {
  const row = await db.select().from(meta).where(eq(meta.key, "seq")).get();
  return Number(row?.value);
}

/** 書き込みが起きていないことを確かめるための、meta.seq・各表・applied_mutations のまとめ */
export async function snapshot(db: Db) {
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const [seq, taskRows, projectRows, appliedRows] = await Promise.all([
    metaSeq(db),
    db.select().from(tasks),
    db.select().from(projects),
    db.select().from(appliedMutations),
  ]);
  return { seq, tasks: byId(taskRows), projects: byId(projectRows), applied: byId(appliedRows) };
}

/** /api/mutate の 200 の応答として読む */
export async function mutateBody(res: Response): Promise<MutateResponse> {
  return (await res.json()) as MutateResponse;
}

/** /api/mutate や /api/sync の 400（invalid_request）の応答として読む */
export async function errorBody(
  res: Response,
): Promise<Extract<ApiErrorResponse, { error: "invalid_request" }>> {
  const body = (await res.json()) as ApiErrorResponse;
  if (body.error !== "invalid_request") throw new Error(`予期しないエラー: ${body.error}`);
  return body;
}

/** /api/sync の応答を読み、reset ではないことを確かめて絞り込む */
export async function syncBody(res: Response): Promise<Extract<SyncResponse, { reset: false }>> {
  const body = (await res.json()) as SyncResponse;
  if (body.reset) throw new Error("予期しない reset でした");
  return body;
}

/** 配列の index 番目を返す。存在しなければ投げる（noUncheckedIndexedAccess 用） */
export function at<T>(arr: readonly T[], index: number): T {
  const value = arr[index];
  if (value === undefined) throw new Error(`index ${index} が存在しません`);
  return value;
}

/** SyncRow が task の行であることを確かめて、その row を返す */
export function asTaskRow(row: SyncRow): Task {
  if (row.kind !== "task") throw new Error("task の行ではありません");
  return row.row;
}

/** SyncRow が project の行であることを確かめて、その row を返す */
export function asProjectRow(row: SyncRow): Project {
  if (row.kind !== "project") throw new Error("project の行ではありません");
  return row.row;
}

/** meta の1つの値を直に書き換える（テスト用の下ごしらえ） */
export async function setMeta(db: Db, key: string, value: string): Promise<void> {
  await db.update(meta).set({ value }).where(eq(meta.key, key));
}

/** 1つのINSERT文のバインド変数は100までなので、検証をバイパスした行の下ごしらえもこれで区切る */
const INSERT_CHUNK_SIZE = 10;

function chunkRows<T>(rows: readonly T[], size: number = INSERT_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

/** 検証をバイパスして、seq を連番で振った count 件のタスクを直に作る（ページ分けのテスト用） */
export async function insertRawTasks(db: Db, count: number, seqStart: number) {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    title: `task-${seqStart + i}`,
    bucket: "inbox" as const,
    rank: rankAfter(null),
    createdAt: now,
    updatedAt: now,
    seq: seqStart + i,
  }));
  for (const part of chunkRows(rows)) await db.insert(tasks).values(part);
  return rows;
}

/** 検証をバイパスして、seq を連番で振った count 件のプロジェクトを直に作る */
export async function insertRawProjects(db: Db, count: number, seqStart: number) {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: crypto.randomUUID(),
    name: `project-${seqStart + i}`,
    createdAt: now,
    updatedAt: now,
    seq: seqStart + i,
  }));
  for (const part of chunkRows(rows)) await db.insert(projects).values(part);
  return rows;
}

/**
 * 検証をバイパスして、1件のタスクの行を直に作る（rollover のテストで細かく項目を指定するのに使う）。
 * D1 の既定値（memo・checklist など）まで入った、今の行を読み直して返す
 */
export async function insertRawTask(
  db: Db,
  overrides: Partial<typeof tasks.$inferInsert> & { seq: number },
) {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(tasks).values({
    title: "task",
    bucket: "inbox" as const,
    rank: rankAfter(null),
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) throw new Error("insertRawTask: 行を読み直せませんでした");
  return row;
}

/** 検証をバイパスして、1件のプロジェクトの行を直に作る。今の行を読み直して返す */
export async function insertRawProject(
  db: Db,
  overrides: Partial<typeof projects.$inferInsert> & { seq: number },
) {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  await db.insert(projects).values({
    name: "project",
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  const row = await db.select().from(projects).where(eq(projects.id, id)).get();
  if (!row) throw new Error("insertRawProject: 行を読み直せませんでした");
  return row;
}
