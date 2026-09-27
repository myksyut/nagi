import type { Project, SyncRow, Task } from "@shared/model";
import type { Mutation } from "@shared/mutations";
import { createAtom, type ObservableMap, observable, runInAction } from "mobx";
import {
  applyProjectMutation,
  applyTaskMutation,
  isTaskMutation,
  type ProjectMutation,
  type TaskMutation,
  targetOf,
} from "./overlay";
import { ProjectRow, sameProject, sameTask, TaskIndex, TaskRow } from "./rows";

/** 画面から呼ぶ操作の種類（知らせと、元に戻すの表示に使う） */
export type OperationKind =
  | "task.add"
  | "task.update"
  | "task.complete"
  | "task.uncomplete"
  | "task.move"
  | "task.reorder"
  | "task.deadline"
  | "task.delete"
  | "project.create"
  | "project.update"
  | "undo";

/** 送信中の操作のまとまり（1つのリクエスト） */
export type PendingBatch = {
  /** まとまりの ID（UUIDv7）。再送でも同じ ID を使う */
  readonly id: string;
  readonly mutations: readonly Mutation[];
  /** 操作した時刻（ISO 8601）。作成を送信中の行の、仮の createdAt・updatedAt に使う */
  readonly at: string;
  /** 1回のユーザー操作の ID（1回の操作は1つのまとまりなので、今は id と同じ） */
  readonly operationId: string;
  readonly kind: OperationKind;
};

type Timed<M> = { mutation: M; at: string };

/**
 * 手元の写し。確定データ（サーバーで保存済みの行）と送信中の操作を持ち、画面にはその2つを重ねた行を出す。
 * 送信中の操作を外せば、その行は確定データの内容に戻る。
 * 確定データに取り込むのは、手元より seq が新しい行だけ。削除済みの行も確定データには残す
 * （遅れて届いた古い版を seq で退けるため）。リストの計算で削除済みを外す
 */
export class Replica {
  readonly #confirmedTasks = new Map<string, Task>();
  readonly #confirmedProjects = new Map<string, Project>();
  readonly #tasks: ObservableMap<string, TaskRow> = observable.map(undefined, { deep: false });
  readonly #projects: ObservableMap<string, ProjectRow> = observable.map(undefined, {
    deep: false,
  });
  readonly #projectsAtom = createAtom("projects");
  readonly #pendingAtom = createAtom("pending");
  #pending: PendingBatch[] = [];

  /** タスクの区分ごとの集まり（リストの計算が読む） */
  readonly taskIndex = new TaskIndex();

  /** 画面に出すタスク（削除済みも含む）。なければ undefined */
  task(id: string): TaskRow | undefined {
    return this.#tasks.get(id);
  }

  project(id: string): ProjectRow | undefined {
    return this.#projects.get(id);
  }

  /** すべてのプロジェクト（削除済み・アーカイブ済みも含む。並びは決めない） */
  allProjects(): readonly ProjectRow[] {
    this.#projectsAtom.reportObserved();
    return Array.from(this.#projects.values());
  }

  /** 確定した行（送信中の操作を重ねる前）。テストと、元に戻すの計算に使う */
  confirmedTask(id: string): Task | undefined {
    return this.#confirmedTasks.get(id);
  }

  confirmedProject(id: string): Project | undefined {
    return this.#confirmedProjects.get(id);
  }

  /** 確定データのうち、cutoff（ISO 8601）より前に削除された行 */
  expiredDeleted(cutoff: string): { taskIds: string[]; projectIds: string[] } {
    const expired = (row: { deletedAt: string | null }) =>
      row.deletedAt !== null && row.deletedAt < cutoff;
    return {
      taskIds: Array.from(this.#confirmedTasks.values())
        .filter(expired)
        .map((row) => row.id),
      projectIds: Array.from(this.#confirmedProjects.values())
        .filter(expired)
        .map((row) => row.id),
    };
  }

  /** 確定データのすべての行（reset のあとの保存などに使う） */
  confirmedRows(): SyncRow[] {
    return [
      ...Array.from(this.#confirmedTasks.values(), (row) => ({ kind: "task" as const, row })),
      ...Array.from(this.#confirmedProjects.values(), (row) => ({ kind: "project" as const, row })),
    ];
  }

  /** 送信中のまとまり（送る順） */
  get pending(): readonly PendingBatch[] {
    this.#pendingAtom.reportObserved();
    return this.#pending;
  }

  /**
   * 確定データを rows で置き換える（起動時の読み込みと、reset のあと）。seq は比べない。
   * 送信中の操作はそのまま重ねる
   */
  replaceConfirmed(rows: Iterable<SyncRow>): void {
    runInAction(() => {
      const taskIds = new Set(this.#confirmedTasks.keys());
      const projectIds = new Set(this.#confirmedProjects.keys());
      this.#confirmedTasks.clear();
      this.#confirmedProjects.clear();
      for (const entry of rows) {
        if (entry.kind === "task") {
          this.#confirmedTasks.set(entry.row.id, entry.row);
          taskIds.add(entry.row.id);
        } else {
          this.#confirmedProjects.set(entry.row.id, entry.row);
          projectIds.add(entry.row.id);
        }
      }
      this.#rematerialize(taskIds, projectIds);
    });
  }

  /** 手元より seq が新しい行だけを確定データに取り込む。取り込んだ行を返す */
  mergeConfirmed(rows: readonly SyncRow[]): SyncRow[] {
    return runInAction(() => {
      const accepted = this.#merge(rows);
      this.#rematerializeRows(accepted);
      return accepted;
    });
  }

  /** 確定データから行を捨てる（削除から 30 日たった行）。送信中の操作は重ねたまま */
  dropConfirmed(taskIds: readonly string[], projectIds: readonly string[]): void {
    runInAction(() => {
      for (const id of taskIds) this.#confirmedTasks.delete(id);
      for (const id of projectIds) this.#confirmedProjects.delete(id);
      this.#rematerialize(new Set(taskIds), new Set(projectIds));
    });
  }

  /** 送信中のまとまりを後ろに積む（画面にはすぐ重ねて出る） */
  addPending(batches: readonly PendingBatch[]): void {
    runInAction(() => {
      this.#pending.push(...batches);
      this.#pendingAtom.reportChanged();
      this.#rematerializeBatches(batches, []);
    });
  }

  /**
   * 送信に成功したまとまりを外し、確定した行を取り込む。1回の更新で行うので、
   * 画面は「送信中」から「確定」へちらつかずに移る。取り込んだ行を返す
   */
  confirmBatch(batchId: string, rows: readonly SyncRow[]): SyncRow[] {
    return runInAction(() => {
      const batches = this.#takePending((batch) => batch.id === batchId);
      const accepted = this.#merge(rows);
      this.#rematerializeBatches(batches, rows);
      return accepted;
    });
  }

  /** 送信中のまとまりを捨てる（表示はその操作の前に戻る）。捨てたまとまりを返す */
  discardPending(shouldDiscard: (batch: PendingBatch) => boolean): PendingBatch[] {
    return runInAction(() => {
      const batches = this.#takePending(shouldDiscard);
      this.#rematerializeBatches(batches, []);
      return batches;
    });
  }

  #takePending(predicate: (batch: PendingBatch) => boolean): PendingBatch[] {
    const taken = this.#pending.filter(predicate);
    if (taken.length > 0) {
      this.#pending = this.#pending.filter((batch) => !predicate(batch));
      this.#pendingAtom.reportChanged();
    }
    return taken;
  }

  #merge(rows: readonly SyncRow[]): SyncRow[] {
    const accepted: SyncRow[] = [];
    for (const entry of rows) {
      if (entry.kind === "task") {
        if (!isNewer(this.#confirmedTasks.get(entry.row.id), entry.row)) continue;
        this.#confirmedTasks.set(entry.row.id, entry.row);
      } else {
        if (!isNewer(this.#confirmedProjects.get(entry.row.id), entry.row)) continue;
        this.#confirmedProjects.set(entry.row.id, entry.row);
      }
      accepted.push(entry);
    }
    return accepted;
  }

  #rematerializeRows(rows: readonly SyncRow[]): void {
    this.#rematerializeBatches([], rows);
  }

  #rematerializeBatches(batches: readonly PendingBatch[], rows: readonly SyncRow[]): void {
    const taskIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const batch of batches) {
      for (const mutation of batch.mutations) {
        const target = targetOf(mutation);
        (target.kind === "task" ? taskIds : projectIds).add(target.id);
      }
    }
    for (const { kind, row } of rows) (kind === "task" ? taskIds : projectIds).add(row.id);
    this.#rematerialize(taskIds, projectIds);
  }

  /** 指定した行を、確定データに送信中の操作を重ねて作り直す */
  #rematerialize(taskIds: ReadonlySet<string>, projectIds: ReadonlySet<string>): void {
    if (taskIds.size === 0 && projectIds.size === 0) return;
    const taskOps = new Map<string, Timed<TaskMutation>[]>();
    const projectOps = new Map<string, Timed<ProjectMutation>[]>();
    for (const batch of this.#pending) {
      for (const mutation of batch.mutations) {
        if (isTaskMutation(mutation)) {
          const id = targetOf(mutation).id;
          if (taskIds.has(id)) pushTo(taskOps, id, { mutation, at: batch.at });
        } else {
          const id = targetOf(mutation).id;
          if (projectIds.has(id)) pushTo(projectOps, id, { mutation, at: batch.at });
        }
      }
    }

    for (const id of taskIds) {
      let value = this.#confirmedTasks.get(id);
      for (const { mutation, at } of taskOps.get(id) ?? []) {
        value = applyTaskMutation(value, mutation, at);
      }
      this.#showTask(id, value);
    }
    let projectsChanged = false;
    for (const id of projectIds) {
      let value = this.#confirmedProjects.get(id);
      for (const { mutation, at } of projectOps.get(id) ?? []) {
        value = applyProjectMutation(value, mutation, at);
      }
      projectsChanged = this.#showProject(id, value) || projectsChanged;
    }
    if (projectsChanged) this.#projectsAtom.reportChanged();
  }

  #showTask(id: string, value: Task | undefined): void {
    const row = this.#tasks.get(id);
    if (value === undefined) {
      if (row) {
        this.taskIndex.remove(row);
        this.#tasks.delete(id);
      }
    } else if (!row) {
      const created = new TaskRow(value);
      this.#tasks.set(id, created);
      this.taskIndex.add(created);
    } else if (!sameTask(row.peek(), value)) {
      this.taskIndex.update(row, value);
    }
  }

  /** プロジェクトの行を出し直す。変わったら true */
  #showProject(id: string, value: Project | undefined): boolean {
    const row = this.#projects.get(id);
    if (value === undefined) {
      if (!row) return false;
      this.#projects.delete(id);
      return true;
    }
    if (!row) {
      this.#projects.set(id, new ProjectRow(value));
      return true;
    }
    if (sameProject(row.peek(), value)) return false;
    row.replace(value);
    return true;
  }
}

/** 手元にない行か、手元より seq が新しい行だけを取り込む */
export function isNewer(current: { seq: number } | undefined, next: { seq: number }): boolean {
  return current === undefined || current.seq < next.seq;
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
