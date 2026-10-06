import { and, eq, getTableColumns, inArray } from "drizzle-orm";
import type { Project, SyncRow, Task } from "../../shared/model";
import type { Db } from "../db/client";
import { projects, tasks } from "../db/schema";

// 画面へ返す列。user_id は返さない（行を読むとき・RETURNING で、必ずこの列を指定する）
const { userId: _taskUserId, ...taskColumns } = getTableColumns(tasks);
const { userId: _projectUserId, ...projectColumns } = getTableColumns(projects);

export { projectColumns, taskColumns };

// D1 の行（user_id を除く）の型と、画面と共有する型（src/shared/model.ts）が同じであることを型で確かめる
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Shown<Row> = { [K in keyof Row as Exclude<K, "userId">]: Row[K] };
export type TaskRowMatchesShared = Assert<Equals<Shown<typeof tasks.$inferSelect>, Task>>;
export type ProjectRowMatchesShared = Assert<Equals<Shown<typeof projects.$inferSelect>, Project>>;

/** タスクとプロジェクトの行を、seq の順に並べた SyncRow にする */
export function toSyncRows(taskRows: Task[], projectRows: Project[]): SyncRow[] {
  const rows: SyncRow[] = [
    ...taskRows.map((row) => ({ kind: "task" as const, row })),
    ...projectRows.map((row) => ({ kind: "project" as const, row })),
  ];
  return rows.sort((a, b) => a.row.seq - b.row.seq);
}

/** 1つの文のバインド変数は 100 まで。IN (...) で読むときはこの数ずつに分ける（user_id などのぶんを残す） */
const READ_CHUNK_SIZE = 90;

export function chunk<T>(items: readonly T[], size: number = READ_CHUNK_SIZE): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** ID を指定して、利用者のタスクとプロジェクトの今の行を読む（ない ID は飛ばす） */
export async function readRowsByIds(
  db: Db,
  userId: string,
  taskIds: readonly string[],
  projectIds: readonly string[],
): Promise<SyncRow[]> {
  const [taskChunks, projectChunks] = await Promise.all([
    Promise.all(
      chunk(taskIds).map((ids) =>
        db
          .select(taskColumns)
          .from(tasks)
          .where(and(eq(tasks.userId, userId), inArray(tasks.id, ids))),
      ),
    ),
    Promise.all(
      chunk(projectIds).map((ids) =>
        db
          .select(projectColumns)
          .from(projects)
          .where(and(eq(projects.userId, userId), inArray(projects.id, ids))),
      ),
    ),
  ]);
  return toSyncRows(taskChunks.flat(), projectChunks.flat());
}
