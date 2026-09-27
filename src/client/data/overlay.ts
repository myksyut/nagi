import type { Project, Task } from "@shared/model";
import type { Mutation } from "@shared/mutations";

/**
 * 送信中の操作を確定データに重ねる計算（純粋な関数）。
 * 画面に出す行 = 確定した行に、その行を対象にする送信中の操作を、送る順に重ねたもの
 */

export type TaskMutation = Extract<Mutation, { type: "task.create" | "task.update" }>;
export type ProjectMutation = Extract<Mutation, { type: "project.create" | "project.update" }>;

export type RowRef = { kind: "task" | "project"; id: string };

/** 操作の対象の行 */
export function targetOf(mutation: Mutation): RowRef {
  switch (mutation.type) {
    case "task.create":
      return { kind: "task", id: mutation.task.id };
    case "task.update":
      return { kind: "task", id: mutation.id };
    case "project.create":
      return { kind: "project", id: mutation.project.id };
    case "project.update":
      return { kind: "project", id: mutation.id };
  }
}

export function isTaskMutation(mutation: Mutation): mutation is TaskMutation {
  return mutation.type === "task.create" || mutation.type === "task.update";
}

/** 送られてきた項目だけを差し替える（undefined は「送らない」なので飛ばす） */
function withChanges<T extends object>(base: T, changes: object): T {
  const next = { ...base };
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  return next;
}

/**
 * タスクに操作を1つ重ねる。at は操作した時刻（作成を送信中の行の、仮の createdAt・updatedAt）。
 * 対象の行がない更新は何もしない（その行はない）
 */
export function applyTaskMutation(
  base: Task | undefined,
  mutation: TaskMutation,
  at: string,
): Task | undefined {
  if (mutation.type === "task.update") {
    return base && withChanges(base, mutation.changes);
  }
  const { task } = mutation;
  const fields = {
    title: task.title,
    memo: task.memo ?? "",
    bucket: task.bucket,
    scheduledOn: task.scheduledOn ?? null,
    deadlineOn: task.deadlineOn ?? null,
    projectId: task.projectId ?? null,
    rank: task.rank,
    arrivedOn: task.arrivedOn ?? null,
    checklist: task.checklist ?? [],
  };
  // 応答より先に、差分の取得で確定した行が届いていたら、その上に重ねる
  if (base) return { ...base, ...fields };
  return {
    id: task.id,
    ...fields,
    completedAt: null,
    startedAt: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    seq: 0,
  };
}

export function applyProjectMutation(
  base: Project | undefined,
  mutation: ProjectMutation,
  at: string,
): Project | undefined {
  if (mutation.type === "project.update") {
    return base && withChanges(base, mutation.changes);
  }
  const { project } = mutation;
  const color = project.color ?? null;
  if (base) return { ...base, name: project.name, color };
  return {
    id: project.id,
    name: project.name,
    color,
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    seq: 0,
  };
}
