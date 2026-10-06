import { env } from "cloudflare:test";
import { and, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { ApiErrorResponse, MutateResponse, SyncResponse } from "../../shared/api";
import { API_VERSION, API_VERSION_HEADER } from "../../shared/api";
import type { Project, SyncRow, Task } from "../../shared/model";
import { mutationBatchSchema, type ParsedMutationBatch } from "../../shared/mutations";
import { rankAfter } from "../../shared/rank";
import { type Db, getDb } from "../db/client";
import {
  appliedMutations,
  meta,
  OWNER_USER_ID,
  projects,
  sessions,
  tasks,
  users,
} from "../db/schema";
import { createApp } from "../index";
import { initialMetaRows, metaRow } from "../sync/meta";
import { projectColumns, taskColumns } from "../sync/rows";

/**
 * 各テストの前に呼ぶ。tasks・projects・applied_mutations を空にし、OWNER_USER_ID の meta を初期値
 * （seq=0、last_rollover_on=''、purged_through_seq=0）に戻す。テストが作ったほかの利用者は、セッション・meta ごと消す
 */
export async function resetSyncTables(db: Db = getDb(env.DB)): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [
    db.delete(tasks),
    db.delete(projects),
    db.delete(appliedMutations),
    db.delete(meta).where(ne(meta.userId, OWNER_USER_ID)),
    db.delete(sessions).where(ne(sessions.userId, OWNER_USER_ID)),
    db.delete(users).where(ne(users.id, OWNER_USER_ID)),
    db.update(meta).set({ value: "0" }).where(metaRow(OWNER_USER_ID, "seq")),
    db.update(meta).set({ value: "" }).where(metaRow(OWNER_USER_ID, "last_rollover_on")),
    db.update(meta).set({ value: "0" }).where(metaRow(OWNER_USER_ID, "purged_through_seq")),
  ];
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

/** 検証をバイパスして、もう 1 人の利用者（と、その meta の行）を直に作る。利用者の ID を返す */
export async function insertRawUser(db: Db, githubUserId: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.batch([
    db.insert(users).values({ id, githubUserId, createdAt: new Date().toISOString() }),
    db.insert(meta).values(initialMetaRows(id)),
  ]);
  return id;
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

/** 利用者（既定は OWNER_USER_ID）の meta.seq の今の値（数） */
export async function metaSeq(db: Db, userId: string = OWNER_USER_ID): Promise<number> {
  const row = await db.select().from(meta).where(metaRow(userId, "seq")).get();
  return Number(row?.value);
}

/**
 * 書き込みが起きていないことを確かめるための、利用者（既定は OWNER_USER_ID）の meta.seq・各表・applied_mutations のまとめ。
 * 行は、画面へ返すのと同じ形（user_id なし）
 */
export async function snapshot(db: Db, userId: string = OWNER_USER_ID) {
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const [seq, taskRows, projectRows, appliedRows] = await Promise.all([
    metaSeq(db, userId),
    db.select(taskColumns).from(tasks).where(eq(tasks.userId, userId)),
    db.select(projectColumns).from(projects).where(eq(projects.userId, userId)),
    db
      .select({ id: appliedMutations.id, appliedAt: appliedMutations.appliedAt })
      .from(appliedMutations)
      .where(eq(appliedMutations.userId, userId)),
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

/** OWNER_USER_ID の meta の1つの値を直に書き換える（テスト用の下ごしらえ） */
export async function setMeta(
  db: Db,
  key: "seq" | "last_rollover_on" | "purged_through_seq",
  value: string,
): Promise<void> {
  await db.update(meta).set({ value }).where(metaRow(OWNER_USER_ID, key));
}

/** 1つのINSERT文のバインド変数は100までなので、検証をバイパスした行の下ごしらえもこれで区切る */
const INSERT_CHUNK_SIZE = 10;

function chunkRows<T>(rows: readonly T[], size: number = INSERT_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

/** 検証をバイパスして、seq を連番で振った count 件のタスクを直に作る（ページ分けのテスト用）。持ち主は OWNER_USER_ID */
export async function insertRawTasks(db: Db, count: number, seqStart: number) {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    userId: OWNER_USER_ID,
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

/** 検証をバイパスして、seq を連番で振った count 件のプロジェクトを直に作る。持ち主は OWNER_USER_ID */
export async function insertRawProjects(db: Db, count: number, seqStart: number) {
  const now = new Date().toISOString();
  const rows = Array.from({ length: count }, (_, i) => ({
    userId: OWNER_USER_ID,
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
 * D1 の既定値（memo・checklist など）まで入った、今の行を読み直して返す（画面へ返すのと同じ形）。
 * 持ち主は、overrides.userId を書かなければ OWNER_USER_ID
 */
export async function insertRawTask(
  db: Db,
  overrides: Partial<typeof tasks.$inferInsert> & { seq: number },
) {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  const userId = overrides.userId ?? OWNER_USER_ID;
  await db.insert(tasks).values({
    userId,
    title: "task",
    bucket: "inbox" as const,
    rank: rankAfter(null),
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  const row = await db
    .select(taskColumns)
    .from(tasks)
    .where(and(eq(tasks.userId, userId), eq(tasks.id, id)))
    .get();
  if (!row) throw new Error("insertRawTask: 行を読み直せませんでした");
  return row;
}

/** 検証をバイパスして、1件のプロジェクトの行を直に作る。今の行を読み直して返す（持ち主は insertRawTask と同じ） */
export async function insertRawProject(
  db: Db,
  overrides: Partial<typeof projects.$inferInsert> & { seq: number },
) {
  const now = new Date().toISOString();
  const id = overrides.id ?? crypto.randomUUID();
  const userId = overrides.userId ?? OWNER_USER_ID;
  await db.insert(projects).values({
    userId,
    name: "project",
    createdAt: now,
    updatedAt: now,
    ...overrides,
    id,
  });
  const row = await db
    .select(projectColumns)
    .from(projects)
    .where(and(eq(projects.userId, userId), eq(projects.id, id)))
    .get();
  if (!row) throw new Error("insertRawProject: 行を読み直せませんでした");
  return row;
}
