import { and, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { ImportResponse } from "../../shared/api";
import { type ExportDocument, exportSchema } from "../../shared/export";
import type { Db } from "../db/client";
import { meta, projects, tasks } from "../db/schema";
import { metaRow } from "./meta";
import { MAX_PROJECTS_PER_USER, MAX_TASKS_PER_USER } from "./mutate";
import { chunk } from "./rows";
import { currentSeq } from "./seq";

/**
 * 1回の取り込みで受ける行の数（プロジェクトとタスクの合計）。D1 の 1 回の呼び出しで書く文の数に収める
 * （/api/mutate の MAX_MUTATIONS_PER_BATCH と同じ 500）
 */
export const MAX_IMPORT_ROWS = 500;

/** 取り込みの本文。書き出しと同じ形で、行の数と、同じ id の重なりも確かめる（どちらも 400 の issues に位置が出る） */
export const importRequestSchema = exportSchema.superRefine((document, ctx) => {
  if (document.projects.length + document.tasks.length > MAX_IMPORT_ROWS) {
    ctx.addIssue({ code: "custom", message: "too_many_rows", path: [] });
  }
  for (const key of ["projects", "tasks"] as const) {
    const seen = new Set<string>();
    document[key].forEach((row, index) => {
      if (seen.has(row.id)) {
        ctx.addIssue({ code: "custom", message: "duplicate_id", path: [key, index, "id"] });
      }
      seen.add(row.id);
    });
  }
});

export type ImportOutcome =
  | { ok: true; response: ImportResponse }
  | { ok: false; reason: "quota_exceeded" };

/** 同じ表で、利用者がもう持っている id（論理削除した行も）と、その行の deletedAt */
async function readExisting(
  db: Db,
  table: typeof tasks | typeof projects,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, string | null>> {
  const found = await Promise.all(
    chunk(ids).map((part) =>
      db
        .select({ id: table.id, deletedAt: table.deletedAt })
        .from(table)
        .where(and(eq(table.userId, userId), inArray(table.id, part))),
    ),
  );
  return new Map(found.flat().map((row) => [row.id, row.deletedAt]));
}

async function countRows(db: Db, table: typeof tasks | typeof projects, userId: string) {
  const row = await db.select({ n: count() }).from(table).where(eq(table.userId, userId)).get();
  return row?.n ?? 0;
}

/**
 * 同時の取り込みや書き込みが、数えたあとに行を足して上限を超えたら、meta.seq の value に NULL を入れようとして
 * バッチ全体を失敗させる（mutate.ts の requireWithinQuota と同じ守り）
 */
function quotaGuard(db: Db, userId: string, table: typeof tasks | typeof projects, max: number) {
  return db
    .update(meta)
    .set({ value: sql`NULL` })
    .where(
      and(
        metaRow(userId, "seq"),
        sql`(SELECT COUNT(*) FROM ${table} WHERE ${eq(table.userId, userId)}) > ${sql.raw(String(max))}`,
      ),
    );
}

/**
 * このバッチでここまでに入った行の数。meta.seq はこれまでに振った seq の最大値なので、それより大きい seq の行は、
 * このバッチで入れた行だけ
 */
function insertedSoFar(userId: string): SQL {
  const inTable = (table: typeof tasks | typeof projects) =>
    sql`(SELECT COUNT(*) FROM ${table} WHERE ${eq(table.userId, userId)} AND ${table.seq} > ${currentSeq(userId)})`;
  return sql`(${inTable(projects)} + ${inTable(tasks)})`;
}

type ImportPlan = {
  newProjects: ExportDocument["projects"];
  newTasks: ExportDocument["tasks"];
  existingProjects: number;
  existingTasks: number;
  /** 指す先のプロジェクトがなく、projectId を null にして入れるタスクの id */
  detached: Set<string>;
  /** ない行を足すと、利用者ごとの上限（mutate.ts と同じ。論理削除した行も数える）を超えるか */
  overQuota: boolean;
};

/**
 * 利用者の行を数えてから、本文の id のうちもうある行を読む。この順なら、あいだに同時の取り込みが同じ行を入れても、
 * 足す行を多く見積もらない（何度送っても同じ本文を、上限で断らない）。少なく見積もった分は、バッチの quotaGuard が止める
 */
async function planImport(db: Db, userId: string, document: ExportDocument): Promise<ImportPlan> {
  const [taskCount, projectCount] = await Promise.all([
    countRows(db, tasks, userId),
    countRows(db, projects, userId),
  ]);
  const existingProjects = await readExisting(
    db,
    projects,
    userId,
    document.projects.map((row) => row.id),
  );
  const newProjects = document.projects.filter((row) => !existingProjects.has(row.id));
  const existingTasks = await readExisting(
    db,
    tasks,
    userId,
    document.tasks.map((row) => row.id),
  );
  const newTasks = document.tasks.filter((row) => !existingTasks.has(row.id));

  // 指す先になれるプロジェクト。この本文で入れるものと、利用者がもう持っている論理削除していないもの
  const liveProjects = new Set(newProjects.map((row) => row.id));
  const referenced = new Set(
    newTasks.flatMap((row) => (row.projectId === null ? [] : [row.projectId])),
  );
  const unknown = [...referenced].filter((id) => !liveProjects.has(id));
  for (const [id, deletedAt] of await readExisting(db, projects, userId, unknown)) {
    if (deletedAt === null) liveProjects.add(id);
  }
  const detached = new Set(
    newTasks
      .filter((row) => row.projectId !== null && !liveProjects.has(row.projectId))
      .map((row) => row.id),
  );
  return {
    newProjects,
    newTasks,
    existingProjects: existingProjects.size,
    existingTasks: existingTasks.size,
    detached,
    overQuota:
      taskCount + newTasks.length > MAX_TASKS_PER_USER ||
      projectCount + newProjects.length > MAX_PROJECTS_PER_USER,
  };
}

/**
 * 書き出しの形の行を、その利用者の行として取り込む（ほかの利用者に同じ id の行があっても関係ない。主キーは user_id と id）。
 * 先にその利用者に同じ id の行があるかを読み、ない行だけを 1 回の db.batch で入れる（何度送っても同じ結果。
 * 入れる行がなければ何も書かず、meta.seq も動かない）。INSERT は ON CONFLICT DO NOTHING で、同時の取り込みが先に入れた行は
 * 飛ばす。seq は実際に入った行にだけ続きの番号を振り、meta.seq も入った行の数だけ進める。応答の数も、実際に入った行で数える。
 * 項目はそのまま写し、updatedAt は取り込んだ時刻。
 * 指す先のプロジェクトがない（利用者にも、この本文にもない。論理削除したものも）タスクは、projectId を null にして入れる。
 * dryRun なら書かずに、入れたとしたときの数を返す
 */
export async function importRows(
  db: Db,
  userId: string,
  document: ExportDocument,
  now: Date,
  dryRun: boolean,
): Promise<ImportOutcome> {
  const timestamp = now.toISOString();
  const plan = await planImport(db, userId, document);
  const { newProjects, newTasks, detached } = plan;
  if (dryRun) {
    return {
      ok: true,
      response: {
        tasks: { new: newTasks.length, existing: plan.existingTasks },
        projects: { new: newProjects.length, existing: plan.existingProjects },
        detachedTasks: detached.size,
      },
    };
  }
  if (plan.overQuota) return { ok: false, reason: "quota_exceeded" };

  const seq = sql`${currentSeq(userId)} + ${insertedSoFar(userId)} + 1`;
  // プロジェクトを先に、タスクをあとに入れる
  const inserts: BatchItem<"sqlite">[] = [
    ...newProjects.map((row) =>
      db
        .insert(projects)
        .values({
          userId,
          id: row.id,
          name: row.name,
          color: row.color,
          archivedAt: row.archivedAt,
          createdAt: row.createdAt,
          updatedAt: timestamp,
          deletedAt: null,
          seq,
        })
        .onConflictDoNothing({ target: [projects.userId, projects.id] })
        .returning({ id: projects.id }),
    ),
    ...newTasks.map((row) =>
      db
        .insert(tasks)
        .values({
          userId,
          id: row.id,
          title: row.title,
          memo: row.memo,
          bucket: row.bucket,
          scheduledOn: row.scheduledOn,
          deadlineOn: row.deadlineOn,
          projectId: detached.has(row.id) ? null : row.projectId,
          rank: row.rank,
          arrivedOn: row.arrivedOn,
          checklist: row.checklist,
          completedAt: row.completedAt,
          startedAt: row.startedAt,
          priority: row.priority,
          points: row.points,
          createdAt: row.createdAt,
          updatedAt: timestamp,
          deletedAt: null,
          seq,
        })
        .onConflictDoNothing({ target: [tasks.userId, tasks.id] })
        .returning({ id: tasks.id }),
    ),
  ];
  let results: unknown[] = [];
  if (inserts.length > 0) {
    const statements: BatchItem<"sqlite">[] = [
      ...inserts,
      db
        .update(meta)
        .set({ value: sql`CAST(${meta.value} AS INTEGER) + ${insertedSoFar(userId)}` })
        .where(metaRow(userId, "seq")),
      ...(newTasks.length > 0 ? [quotaGuard(db, userId, tasks, MAX_TASKS_PER_USER)] : []),
      ...(newProjects.length > 0 ? [quotaGuard(db, userId, projects, MAX_PROJECTS_PER_USER)] : []),
    ];
    try {
      results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
    } catch (error) {
      // 数えたあとに、同時の書き込みが上限まで行を足した。まだない行を読み直して、足すと上限を超えるかで決める
      if ((await planImport(db, userId, document)).overQuota) {
        return { ok: false, reason: "quota_exceeded" };
      }
      throw error;
    }
  }

  // RETURNING の行があるものだけが入った（同時の取り込みが先に入れた行は空）。行は入れた順で、バッチの頭に並ぶ
  const returned = results.slice(0, inserts.length) as { id: string }[][];
  const projectsInserted = newProjects.filter((_, i) => returned[i]?.length).length;
  const insertedTasks = newTasks.filter((_, i) => returned[newProjects.length + i]?.length);
  return {
    ok: true,
    response: {
      tasks: { new: insertedTasks.length, existing: document.tasks.length - insertedTasks.length },
      projects: {
        new: projectsInserted,
        existing: document.projects.length - projectsInserted,
      },
      detachedTasks: insertedTasks.filter((row) => detached.has(row.id)).length,
    },
  };
}
