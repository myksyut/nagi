import type { Project, Task } from "@shared/model";
import type { Mutation } from "@shared/mutations";
import { createAtom } from "mobx";
import { applyProjectMutation, applyTaskMutation } from "./overlay";
import type { OperationKind, PendingBatch } from "./replica";

/**
 * 元に戻す（⌘Z・トーストの「元に戻す」）。1回のユーザー操作ごとに、逆向きの操作のまとまりを1つ作って積む。
 * - 作成の逆は削除（deletedAt を入れる）、削除の逆は deletedAt を消す更新、更新の逆は変える前の値への更新
 * - まとめて操作した3件は、1回でまとめて戻る
 * - 逆向きの操作は、操作した時点の表示（確定データ＋送信中の操作）から作る
 */

/** 逆向きの操作を作る。at は元に戻す時刻（作成の逆の deletedAt に使う） */
export type InverseBuilder = (at: string) => Mutation[];

type Readers = {
  task: (id: string) => Task | undefined;
  project: (id: string) => Project | undefined;
};

/** changes で変える項目の、今の値 */
function previousValues<T extends object>(current: T, changes: object): Partial<T> {
  const previous: Partial<T> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value !== undefined) previous[key as keyof T] = current[key as keyof T];
  }
  return previous;
}

/**
 * 操作の逆向きを作る。操作を順にたどって行の状態を進めながら、各操作の逆を作り、逆の順に並べる
 * （同じまとまりで作ったプロジェクトをタスクに付けた、などの順序を逆にたどれるように）
 */
export function buildInverse(mutations: readonly Mutation[], read: Readers): InverseBuilder {
  const tasks = new Map<string, Task | undefined>();
  const projects = new Map<string, Project | undefined>();
  const taskNow = (id: string) => (tasks.has(id) ? tasks.get(id) : read.task(id));
  const projectNow = (id: string) => (projects.has(id) ? projects.get(id) : read.project(id));
  const steps: ((at: string) => Mutation)[] = [];

  for (const mutation of mutations) {
    switch (mutation.type) {
      case "task.create": {
        const { id } = mutation.task;
        steps.push((at) => ({ type: "task.update", id, changes: { deletedAt: at } }));
        tasks.set(id, applyTaskMutation(taskNow(id), mutation, ""));
        break;
      }
      case "task.update": {
        const { id, changes } = mutation;
        const before = taskNow(id);
        if (before) {
          const previous = previousValues(before, changes);
          steps.push(() => ({ type: "task.update", id, changes: previous }));
        }
        tasks.set(id, applyTaskMutation(before, mutation, ""));
        break;
      }
      case "project.create": {
        const { id } = mutation.project;
        steps.push((at) => ({ type: "project.update", id, changes: { deletedAt: at } }));
        projects.set(id, applyProjectMutation(projectNow(id), mutation, ""));
        break;
      }
      case "project.update": {
        const { id, changes } = mutation;
        const before = projectNow(id);
        if (before) {
          const previous = previousValues(before, changes);
          steps.push(() => ({ type: "project.update", id, changes: previous }));
        }
        projects.set(id, applyProjectMutation(before, mutation, ""));
        break;
      }
    }
  }
  const reversed = steps.reverse();
  return (at) => reversed.map((step) => step(at));
}

export type UndoEntry = {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly inverse: InverseBuilder;
};

/** 覚えておく操作の数 */
export const UNDO_LIMIT = 100;

export class UndoStack {
  #entries: UndoEntry[] = [];
  /** 送信中の「元に戻す」操作の ID → 戻した元の操作（失敗したら積み直す） */
  readonly #undoing = new Map<string, UndoEntry>();
  readonly #atom = createAtom("undo");

  /** 元に戻せる操作があるか */
  get canUndo(): boolean {
    this.#atom.reportObserved();
    return this.#entries.length > 0;
  }

  /** 次に元に戻す操作（トーストの文言などに使う） */
  get last(): UndoEntry | undefined {
    this.#atom.reportObserved();
    return this.#entries.at(-1);
  }

  push(entry: UndoEntry): void {
    this.#entries.push(entry);
    if (this.#entries.length > UNDO_LIMIT) this.#entries.shift();
    this.#atom.reportChanged();
  }

  pop(): UndoEntry | undefined {
    const entry = this.#entries.pop();
    if (entry) this.#atom.reportChanged();
    return entry;
  }

  /** entry を元に戻す操作（operationId）を送り始めた */
  undoing(operationId: string, entry: UndoEntry): void {
    this.#undoing.set(operationId, entry);
  }

  /** まとまりが確定した */
  confirmed(batch: PendingBatch): void {
    this.#undoing.delete(batch.operationId);
  }

  /**
   * まとまりが捨てられた。その操作は（一部でも捨てられたら）元に戻す対象から外す。
   * 捨てられたのが「元に戻す」操作で、restoreUndone（通信の失敗）なら、戻そうとした元の操作を積み直す
   * （もう一度 ⌘Z で戻せるように）。400 などで捨てられたときは、同じ操作がまた失敗するので積み直さない
   */
  discarded(batches: readonly PendingBatch[], { restoreUndone = true } = {}): void {
    const operationIds = new Set(batches.map((batch) => batch.operationId));
    const kept = this.#entries.filter((entry) => !operationIds.has(entry.operationId));
    for (const operationId of operationIds) {
      const original = this.#undoing.get(operationId);
      this.#undoing.delete(operationId);
      if (restoreUndone && original && !operationIds.has(original.operationId)) {
        kept.push(original);
      }
    }
    this.#entries = kept.slice(-UNDO_LIMIT);
    this.#atom.reportChanged();
  }

  clear(): void {
    this.#entries = [];
    this.#undoing.clear();
    this.#atom.reportChanged();
  }
}
