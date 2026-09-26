import type { Project, Task } from "@shared/model";
import type { Mutation } from "@shared/mutations";
import type { OperationKind, PendingBatch } from "../data/replica";

/**
 * テスト用の値づくり。UUID は小文字の UUID の形にそろえる（サーバーの検証に落ちないように）
 */

let counter = 0;

/** 呼ぶたびに違う UUID（小文字）を返す */
export function nextId(): string {
  counter += 1;
  return `0199a000-0000-7000-8000-${counter.toString(16).padStart(12, "0")}`;
}

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: nextId(),
    title: "タスク",
    memo: "",
    bucket: "inbox",
    scheduledOn: null,
    deadlineOn: null,
    projectId: null,
    rank: "a0",
    arrivedOn: null,
    checklist: [],
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    seq: 1,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: nextId(),
    name: "プロジェクト",
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    seq: 1,
    ...overrides,
  };
}

export function makeBatch(
  overrides: Partial<PendingBatch> & { mutations: Mutation[] },
): PendingBatch {
  return {
    id: nextId(),
    at: "2026-01-01T00:00:00.000Z",
    operationId: nextId(),
    kind: "task.update" as OperationKind,
    ...overrides,
  };
}
