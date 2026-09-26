import type { InvalidRequestReason } from "@shared/api";
import {
  isOpenTask,
  isScheduleConsistent,
  type Project,
  type SyncRow,
  type Task,
} from "@shared/model";
import type { ParsedMutationBatch, ProjectChanges, TaskChanges } from "@shared/mutations";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { Db } from "../db/client";
import { appliedMutations, meta, projects, tasks } from "../db/schema";
import { chunk, readRowsByIds, toSyncRows } from "./rows";
import { advanceSeq, seqFor } from "./seq";

export type MutateOutcome =
  | { ok: true; rows: SyncRow[]; duplicate: boolean }
  | { ok: false; reason: InvalidRequestReason; mutationIndex: number };

/** 検証に使うタスクの項目 */
type TaskFacts = Pick<Task, "bucket" | "scheduledOn" | "projectId" | "completedAt" | "deletedAt">;
type ProjectFacts = { archivedAt: string | null; deletedAt: string | null };

type NewTask = Omit<typeof tasks.$inferInsert, "createdAt" | "updatedAt" | "seq">;
type NewProject = Omit<typeof projects.$inferInsert, "createdAt" | "updatedAt" | "seq">;

/**
 * 1つの行への書き込み。同じまとまりで同じ行に何度か操作したときは1つにまとめる
 * （作成のあとの更新は作成に、更新のあとの更新は変える項目に重ねる）
 */
type PendingWrite =
  | { kind: "task"; id: string; create: NewTask | null; changes: TaskChanges }
  | { kind: "project"; id: string; create: NewProject | null; changes: ProjectChanges };

/** current の項目のうち、changes で送られてきたものだけを差し替える */
function overlay<T extends object>(current: T, changes: Partial<T>): T {
  const next = { ...current };
  for (const key of Object.keys(current) as (keyof T)[]) {
    const value = changes[key];
    if (value !== undefined) next[key] = value as T[keyof T];
  }
  return next;
}

class Rejection extends Error {
  constructor(
    readonly reason: InvalidRequestReason,
    readonly mutationIndex: number,
  ) {
    super(reason);
  }
}

/** 操作の対象になった行の ID（作成と更新の対象） */
function targetIds(batch: ParsedMutationBatch) {
  const taskIds = new Set<string>();
  const projectIds = new Set<string>();
  for (const mutation of batch.mutations) {
    switch (mutation.type) {
      case "task.create":
        taskIds.add(mutation.task.id);
        break;
      case "task.update":
        taskIds.add(mutation.id);
        break;
      case "project.create":
        projectIds.add(mutation.project.id);
        break;
      case "project.update":
        projectIds.add(mutation.id);
        break;
    }
  }
  return { taskIds: [...taskIds], projectIds: [...projectIds] };
}

async function isApplied(db: Db, batchId: string): Promise<boolean> {
  const row = await db
    .select({ id: appliedMutations.id })
    .from(appliedMutations)
    .where(eq(appliedMutations.id, batchId))
    .get();
  return row !== undefined;
}

/**
 * 検証に要る今の行を読む。まとまりの書き込みより前に読む（1人用なので、読んでから書くまでの
 * あいだの変更は割り切る）
 * - 操作の対象のタスクとプロジェクト、タスクに付けるプロジェクト
 * - アーカイブするプロジェクトの、未完了・未削除のタスク
 */
async function loadFacts(db: Db, batch: ParsedMutationBatch) {
  const { taskIds, projectIds } = targetIds(batch);
  const referencedProjectIds = new Set(projectIds);
  const archivingProjectIds: string[] = [];
  for (const mutation of batch.mutations) {
    if (mutation.type === "task.create" && mutation.task.projectId) {
      referencedProjectIds.add(mutation.task.projectId);
    }
    if (mutation.type === "task.update" && mutation.changes.projectId) {
      referencedProjectIds.add(mutation.changes.projectId);
    }
    if (mutation.type === "project.update" && mutation.changes.archivedAt) {
      archivingProjectIds.push(mutation.id);
    }
  }

  const taskColumns = {
    id: tasks.id,
    bucket: tasks.bucket,
    scheduledOn: tasks.scheduledOn,
    projectId: tasks.projectId,
    completedAt: tasks.completedAt,
    deletedAt: tasks.deletedAt,
  };
  const [targetTasks, openTasks, projectRows] = await Promise.all([
    Promise.all(
      chunk(taskIds).map((ids) => db.select(taskColumns).from(tasks).where(inArray(tasks.id, ids))),
    ),
    Promise.all(
      chunk(archivingProjectIds).map((ids) =>
        db
          .select(taskColumns)
          .from(tasks)
          .where(
            and(inArray(tasks.projectId, ids), isNull(tasks.completedAt), isNull(tasks.deletedAt)),
          ),
      ),
    ),
    Promise.all(
      chunk([...referencedProjectIds]).map((ids) =>
        db
          .select({
            id: projects.id,
            archivedAt: projects.archivedAt,
            deletedAt: projects.deletedAt,
          })
          .from(projects)
          .where(inArray(projects.id, ids)),
      ),
    ),
  ]);

  const taskFacts = new Map<string, TaskFacts>();
  for (const { id, ...facts } of [...targetTasks.flat(), ...openTasks.flat()]) {
    taskFacts.set(id, facts);
  }
  const projectFacts = new Map<string, ProjectFacts>();
  for (const { id, ...facts } of projectRows.flat()) projectFacts.set(id, facts);
  return { taskFacts, projectFacts };
}

/**
 * まとまりの操作を順に、読んだ行に重ねながら検証し、行ごとの書き込みにまとめる。
 * 検証に落ちたら Rejection を投げる（何も書かない）
 */
function planWrites(
  batch: ParsedMutationBatch,
  taskFacts: Map<string, TaskFacts>,
  projectFacts: Map<string, ProjectFacts>,
): PendingWrite[] {
  const writes = new Map<string, PendingWrite>();

  /** アーカイブ済み・削除済みでない、あるプロジェクトだけを付けられる */
  const assertAttachable = (projectId: string, index: number) => {
    const project = projectFacts.get(projectId);
    if (!project) throw new Rejection("project_not_found", index);
    if (project.deletedAt !== null) throw new Rejection("project_deleted", index);
    if (project.archivedAt !== null) throw new Rejection("project_archived", index);
  };

  batch.mutations.forEach((mutation, index) => {
    switch (mutation.type) {
      case "task.create": {
        const { task } = mutation;
        if (taskFacts.has(task.id)) throw new Rejection("task_exists", index);
        const facts: TaskFacts = {
          bucket: task.bucket,
          scheduledOn: task.scheduledOn,
          projectId: task.projectId,
          completedAt: null,
          deletedAt: null,
        };
        if (!isScheduleConsistent(facts)) throw new Rejection("schedule_mismatch", index);
        if (task.projectId !== null) assertAttachable(task.projectId, index);
        taskFacts.set(task.id, facts);
        writes.set(`task:${task.id}`, {
          kind: "task",
          id: task.id,
          create: { ...task },
          changes: {},
        });
        break;
      }
      case "task.update": {
        const { id, changes } = mutation;
        const current = taskFacts.get(id);
        if (!current) throw new Rejection("task_not_found", index);
        const next = overlay(current, changes);
        if (!isScheduleConsistent(next)) throw new Rejection("schedule_mismatch", index);
        if (next.projectId !== null && next.projectId !== current.projectId) {
          assertAttachable(next.projectId, index);
        }
        taskFacts.set(id, next);
        const pending = writes.get(`task:${id}`);
        if (pending?.kind === "task") {
          if (pending.create) Object.assign(pending.create, changes);
          else Object.assign(pending.changes, changes);
        } else {
          writes.set(`task:${id}`, { kind: "task", id, create: null, changes: { ...changes } });
        }
        break;
      }
      case "project.create": {
        const { project } = mutation;
        if (projectFacts.has(project.id)) throw new Rejection("project_exists", index);
        projectFacts.set(project.id, { archivedAt: null, deletedAt: null });
        writes.set(`project:${project.id}`, {
          kind: "project",
          id: project.id,
          create: { ...project },
          changes: {},
        });
        break;
      }
      case "project.update": {
        const { id, changes } = mutation;
        const current = projectFacts.get(id);
        if (!current) throw new Rejection("project_not_found", index);
        // アーカイブするプロジェクトに、未完了のタスクが残っていてはいけない（このまとまりでの変更も含めて）
        if (changes.archivedAt) {
          for (const task of taskFacts.values()) {
            if (task.projectId === id && isOpenTask(task)) {
              throw new Rejection("project_has_open_tasks", index);
            }
          }
        }
        projectFacts.set(id, overlay(current, changes));
        const pending = writes.get(`project:${id}`);
        if (pending?.kind === "project") {
          if (pending.create) Object.assign(pending.create, changes);
          else Object.assign(pending.changes, changes);
        } else {
          writes.set(`project:${id}`, {
            kind: "project",
            id,
            create: null,
            changes: { ...changes },
          });
        }
        break;
      }
    }
  });
  return [...writes.values()];
}

/** 今の行を読んで検証し、行ごとの書き込みにまとめる */
async function plan(
  db: Db,
  batch: ParsedMutationBatch,
): Promise<{ ok: true; writes: PendingWrite[] } | Extract<MutateOutcome, { ok: false }>> {
  const { taskFacts, projectFacts } = await loadFacts(db, batch);
  try {
    return { ok: true, writes: planWrites(batch, taskFacts, projectFacts) };
  } catch (error) {
    if (error instanceof Rejection) {
      return { ok: false, reason: error.reason, mutationIndex: error.mutationIndex };
    }
    throw error;
  }
}

/**
 * 既存の行を更新する前提（行がまだあること）を、バッチの中で確かめる文。
 * 検証のあとで行が物理削除されていると、UPDATE は 0 行でも失敗しないので、
 * 行が足りないときだけ meta.seq の value（NOT NULL）に NULL を入れようとして、バッチ全体を失敗させる。
 * 1つの文のバインド変数は 100 までなので、ID は 90 件ずつに分けて数える
 */
function requireExistingRows(db: Db, writes: readonly PendingWrite[]) {
  const updated = (kind: PendingWrite["kind"]) =>
    writes.filter((write) => write.kind === kind && write.create === null).map((w) => w.id);
  const guard = (table: typeof tasks | typeof projects, ids: string[]) =>
    db
      .update(meta)
      .set({ value: sql`NULL` })
      .where(
        and(
          eq(meta.key, "seq"),
          sql`(SELECT COUNT(*) FROM ${table} WHERE ${inArray(table.id, ids)}) < ${ids.length}`,
        ),
      );
  return [
    ...chunk(updated("task")).map((ids) => guard(tasks, ids)),
    ...chunk(updated("project")).map((ids) => guard(projects, ids)),
  ];
}

/**
 * 操作のまとまりを反映する。書き込みは db.batch() 1回だけで、全部成功か全部失敗
 * （D1 には対話的なトランザクションがないので、Drizzle の transaction() は使わない）。
 * バッチの中身は、applied_mutations の INSERT → 更新する行がまだあることの確認 →
 * meta.seq を行数ぶん進める → 行ごとの INSERT / UPDATE。
 * 同じ id のまとまりが再び来たら、書き込まずに、対象の行の今の内容を返す
 */
export async function applyMutationBatch(
  db: Db,
  batch: ParsedMutationBatch,
  now: Date,
): Promise<MutateOutcome> {
  const { taskIds, projectIds } = targetIds(batch);
  const currentRows = async (): Promise<MutateOutcome> => ({
    ok: true,
    rows: await readRowsByIds(db, taskIds, projectIds),
    duplicate: true,
  });

  if (await isApplied(db, batch.id)) return currentRows();

  const planned = await plan(db, batch);
  if (!planned.ok) {
    // 同じ id のまとまりが同時に来て、事前の確認のあとに先に反映されていた（自分が作った行を
    // 「もうある」と見て落ちた）なら、反映済みとして扱う
    if (await isApplied(db, batch.id)) return currentRows();
    return planned;
  }
  const { writes } = planned;

  const timestamp = now.toISOString();
  const count = writes.length;
  const statements: BatchItem<"sqlite">[] = [
    db.insert(appliedMutations).values({ id: batch.id, appliedAt: timestamp }),
    ...requireExistingRows(db, writes),
    advanceSeq(db, count),
    ...writes.map((write, i) => {
      const seq = seqFor(count, i);
      if (write.kind === "task") {
        return write.create
          ? db
              .insert(tasks)
              .values({ ...write.create, createdAt: timestamp, updatedAt: timestamp, seq })
              .returning()
          : db
              .update(tasks)
              .set({ ...write.changes, updatedAt: timestamp, seq })
              .where(eq(tasks.id, write.id))
              .returning();
      }
      return write.create
        ? db
            .insert(projects)
            .values({ ...write.create, createdAt: timestamp, updatedAt: timestamp, seq })
            .returning()
        : db
            .update(projects)
            .set({ ...write.changes, updatedAt: timestamp, seq })
            .where(eq(projects.id, write.id))
            .returning();
    }),
  ];

  let results: unknown[];
  try {
    results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  } catch (error) {
    // 同じ id のまとまりが同時に来て、先に反映された（applied_mutations の主キーが重なった）
    if (await isApplied(db, batch.id)) return currentRows();
    // 検証のあとで前提が崩れた（更新する行が物理削除されたなど）なら、検証をやり直して 400 にする
    const replanned = await plan(db, batch);
    if (!replanned.ok) return replanned;
    throw error;
  }

  // 行の書き込みは、バッチの最後に書き込んだ順で並ぶ（RETURNING の行）
  const written = results.slice(results.length - count) as (Task[] | Project[])[];
  const taskRows: Task[] = [];
  const projectRows: Project[] = [];
  writes.forEach((write, i) => {
    const rows = written[i] ?? [];
    if (write.kind === "task") taskRows.push(...(rows as Task[]));
    else projectRows.push(...(rows as Project[]));
  });
  return { ok: true, rows: toSyncRows(taskRows, projectRows), duplicate: false };
}
