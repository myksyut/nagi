import {
  type Bucket,
  type ChecklistItem,
  type Project,
  type Task,
  type TaskStatus,
  taskStatus,
} from "@shared/model";
import type { ProjectColor } from "@shared/palette";
import { createAtom, type IAtom } from "mobx";

/**
 * 画面に出す1行（確定データに送信中の操作を重ねたもの）。
 * 行ごとに観測値を1つ持つので、中身が変わった行を読んでいる部品だけが再描画される。
 * 同じ id のあいだは同じオブジェクトのまま、中身だけが入れ替わる。
 *
 * 行全体ではなく項目ごとに観測したいときは field(key) で読む（ビューの計算が、ほかの項目の変化で
 * 計算し直さず、しかも peek() のように変化を取りこぼさないように）。項目ごとの観測値は、読まれた項目だけ作る
 */
abstract class ObservedRow<T extends { id: string }> {
  readonly #atom: IAtom;
  #data: T;
  #fieldAtoms: Map<keyof T, IAtom> | undefined;

  constructor(data: T) {
    this.#data = data;
    this.#atom = createAtom(`row:${data.id}`);
  }

  /** id は変わらないので観測しない */
  get id(): string {
    return this.#data.id;
  }

  /** 行の中身。読むと、この行の変化を観測する */
  get value(): Readonly<T> {
    this.#atom.reportObserved();
    return this.#data;
  }

  /** 観測せずに今の中身を読む（データ層のリストの計算用。並びに効く変化はリストの側で知らせる） */
  peek(): Readonly<T> {
    return this.#data;
  }

  /** 項目 key だけを観測して読む。ほかの項目が変わっても知らせない（値が変わったときだけ知らせる） */
  field<K extends keyof T>(key: K): T[K] {
    this.#fieldAtoms ??= new Map();
    let atom = this.#fieldAtoms.get(key);
    if (!atom) {
      atom = createAtom(`row:${this.#data.id}:${String(key)}`);
      this.#fieldAtoms.set(key, atom);
    }
    atom.reportObserved();
    return this.#data[key];
  }

  /** データ層の中だけで使う。中身を入れ替えて、観測している部品に知らせる */
  replace(data: T): void {
    const previous = this.#data;
    this.#data = data;
    this.#atom.reportChanged();
    if (this.#fieldAtoms) {
      for (const [key, atom] of this.#fieldAtoms) {
        if (previous[key] !== data[key]) atom.reportChanged();
      }
    }
  }
}

export class TaskRow extends ObservedRow<Task> {
  get title(): string {
    return this.value.title;
  }
  get memo(): string {
    return this.value.memo;
  }
  get bucket(): Bucket {
    return this.value.bucket;
  }
  get scheduledOn(): string | null {
    return this.value.scheduledOn;
  }
  get deadlineOn(): string | null {
    return this.value.deadlineOn;
  }
  get projectId(): string | null {
    return this.value.projectId;
  }
  get rank(): string {
    return this.value.rank;
  }
  get arrivedOn(): string | null {
    return this.value.arrivedOn;
  }
  get checklist(): readonly ChecklistItem[] {
    return this.value.checklist;
  }
  get completedAt(): string | null {
    return this.value.completedAt;
  }
  /**
   * 進行中にした時刻（進行中でなければ null）。ほかの getter と違い、この項目だけを観測する
   * （タイトルなどが変わっても知らせない）。完了したタスクにも残っていることがあるので、状態は status で見る
   */
  get startedAt(): string | null {
    return this.field("startedAt");
  }
  /** 状態（未着手・進行中・完了）。completedAt と startedAt だけを観測する */
  get status(): TaskStatus {
    return taskStatus({
      completedAt: this.field("completedAt"),
      startedAt: this.field("startedAt"),
    });
  }
  /** 進行中（startedAt があり、未完了）。completedAt と startedAt だけを観測する */
  get isInProgress(): boolean {
    return this.status === "in-progress";
  }
  get createdAt(): string {
    return this.value.createdAt;
  }
  get updatedAt(): string {
    return this.value.updatedAt;
  }
  get deletedAt(): string | null {
    return this.value.deletedAt;
  }
  /** 確定した版の seq。まだサーバーにない（作成を送信中の）行は 0 */
  get seq(): number {
    return this.value.seq;
  }
}

export class ProjectRow extends ObservedRow<Project> {
  get name(): string {
    return this.value.name;
  }
  /**
   * 選んだ色（パレットの名前）。空なら null で、表示には作成順で決まる色を使う
   * （store.lists.projectColor(id) が両方を合わせた色を返す）。この項目だけを観測する
   */
  get color(): ProjectColor | null {
    return this.field("color");
  }
  get archivedAt(): string | null {
    return this.value.archivedAt;
  }
  get createdAt(): string {
    return this.value.createdAt;
  }
  get updatedAt(): string {
    return this.value.updatedAt;
  }
  get deletedAt(): string | null {
    return this.value.deletedAt;
  }
  get seq(): number {
    return this.value.seq;
  }
}

/**
 * タスクの置き場の区分。未完了のタスクは置き場（bucket）ごと、完了済みと削除済みはそれぞれ1つにまとめる
 * （完了しても bucket は変えないので、完了済みはどの置き場のものも "completed" に入る）
 */
export type TaskPartition = Bucket | "completed" | "deleted";

export const TASK_PARTITIONS: readonly TaskPartition[] = [
  "inbox",
  "today",
  "scheduled",
  "later",
  "completed",
  "deleted",
];

export function partitionOf(
  task: Pick<Task, "bucket" | "completedAt" | "deletedAt">,
): TaskPartition {
  if (task.deletedAt !== null) return "deleted";
  if (task.completedAt !== null) return "completed";
  return task.bucket;
}

/**
 * どのリストに入るか・どう並ぶかに効く項目。これが変わったら、その区分のリストを計算し直す。
 * startedAt は区分にも並びにも効かないので入れない（進行中で分ける計算は、TaskRow.startedAt で項目ごとに観測する）
 */
const LIST_FIELDS = [
  "bucket",
  "completedAt",
  "deletedAt",
  "rank",
  "createdAt",
  "scheduledOn",
  "projectId",
] as const satisfies readonly (keyof Task)[];

function sameChecklist(a: readonly ChecklistItem[], b: readonly ChecklistItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      item.id === other.id &&
      item.title === other.title &&
      item.done === other.done
    );
  });
}

export function sameTask(a: Task, b: Task): boolean {
  for (const key of Object.keys(a) as (keyof Task)[]) {
    if (key === "checklist") {
      if (!sameChecklist(a.checklist, b.checklist)) return false;
    } else if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

export function sameProject(a: Project, b: Project): boolean {
  return (Object.keys(a) as (keyof Project)[]).every((key) => a[key] === b[key]);
}

/**
 * タスクの区分ごとの行の集まり。区分ごとに観測値を1つ持ち、行が出入りしたときと、
 * 区分の中の行の並びに効く項目が変わったときだけ知らせる（タイトルの変更などでは知らせない）
 */
export class TaskIndex {
  readonly #sets = new Map<TaskPartition, Set<TaskRow>>(
    TASK_PARTITIONS.map((partition) => [partition, new Set()]),
  );
  readonly #atoms = new Map<TaskPartition, IAtom>(
    TASK_PARTITIONS.map((partition) => [partition, createAtom(`tasks:${partition}`)]),
  );

  /** その区分の行。読むと、区分の変化を観測する */
  rows(partition: TaskPartition): ReadonlySet<TaskRow> {
    this.#atom(partition).reportObserved();
    return this.#set(partition);
  }

  add(row: TaskRow): void {
    const partition = partitionOf(row.peek());
    this.#set(partition).add(row);
    this.#atom(partition).reportChanged();
  }

  remove(row: TaskRow): void {
    const partition = partitionOf(row.peek());
    this.#set(partition).delete(row);
    this.#atom(partition).reportChanged();
  }

  /** 行の中身を next に入れ替え、区分の出入りや並びの変化を知らせる */
  update(row: TaskRow, next: Task): void {
    const previous = row.peek();
    const from = partitionOf(previous);
    const to = partitionOf(next);
    row.replace(next);
    if (from !== to) {
      this.#set(from).delete(row);
      this.#set(to).add(row);
      this.#atom(from).reportChanged();
      this.#atom(to).reportChanged();
    } else if (LIST_FIELDS.some((key) => previous[key] !== next[key])) {
      this.#atom(to).reportChanged();
    }
  }

  clear(): void {
    for (const partition of TASK_PARTITIONS) {
      this.#set(partition).clear();
      this.#atom(partition).reportChanged();
    }
  }

  #set(partition: TaskPartition): Set<TaskRow> {
    const set = this.#sets.get(partition);
    if (!set) throw new Error(`unknown partition: ${partition}`);
    return set;
  }

  #atom(partition: TaskPartition): IAtom {
    const atom = this.#atoms.get(partition);
    if (!atom) throw new Error(`unknown partition: ${partition}`);
    return atom;
  }
}
