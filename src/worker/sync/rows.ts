import { inArray } from "drizzle-orm";
import type { Project, SyncRow, Task } from "../../shared/model";
import type { Db } from "../db/client";
import { projects, tasks } from "../db/schema";

// D1 の行の型と、画面と共有する型（src/shared/model.ts）が同じであることを型で確かめる
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type TaskRowMatchesShared = Assert<Equals<typeof tasks.$inferSelect, Task>>;
export type ProjectRowMatchesShared = Assert<Equals<typeof projects.$inferSelect, Project>>;

/** タスクとプロジェクトの行を、seq の順に並べた SyncRow にする */
export function toSyncRows(taskRows: Task[], projectRows: Project[]): SyncRow[] {
  const rows: SyncRow[] = [
    ...taskRows.map((row) => ({ kind: "task" as const, row })),
    ...projectRows.map((row) => ({ kind: "project" as const, row })),
  ];
  return rows.sort((a, b) => a.row.seq - b.row.seq);
}

/** 1つの文のバインド変数は 100 まで。IN (...) で読むときはこの数ずつに分ける */
const READ_CHUNK_SIZE = 90;

export function chunk<T>(items: readonly T[], size: number = READ_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** ID を指定してタスクとプロジェクトの今の行を読む（ない ID は飛ばす） */
export async function readRowsByIds(
  db: Db,
  taskIds: readonly string[],
  projectIds: readonly string[],
): Promise<SyncRow[]> {
  const [taskChunks, projectChunks] = await Promise.all([
    Promise.all(chunk(taskIds).map((ids) => db.select().from(tasks).where(inArray(tasks.id, ids)))),
    Promise.all(
      chunk(projectIds).map((ids) => db.select().from(projects).where(inArray(projects.id, ids))),
    ),
  ]);
  return toSyncRows(taskChunks.flat(), projectChunks.flat());
}
