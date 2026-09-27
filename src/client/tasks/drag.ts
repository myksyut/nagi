import { action, makeObservable, observable, observableRef } from "mobx";
import { type DragEvent, useState } from "react";
import type { TaskRow } from "@/data";
import { dropRows, openRowsOf, withinBulkLimit } from "./commands";
import type { ListUi } from "./list-ui";
import { planDrop } from "./reorder";
import { taskRowId } from "./task-item";
import { useUi } from "./ui-context";

/**
 * 行のドラッグ（ブラウザの標準のドラッグ＆ドロップ）。
 * - 並べ替え：並べ替えられるまとまり（今日など）の中で、落とした行の前か後ろへ入れる。落とし先に細い線を出す
 * - 移動：サイドバーの「今日」「あとで」・プロジェクトに落とすと移す。「予定」に落とすと日付の入力が開く
 *   （受け付けるかどうかと、落としたときの動きは、落とし先の部品が useTaskDropTarget で決める）
 * 複数選んでいる行をつかむと、選んでいる行（未完了のもの）をまとめて運ぶ。選んでいない行をつかむと、その行だけを選んで運ぶ。
 * 運んでいるものは dataTransfer ではなくここに持つ（ドラッグの途中では dataTransfer の中身を読めないため）
 */

export type DropEdge = "before" | "after";

export class TaskDrag {
  /** 運んでいるタスク（上から見えている順）。運んでいなければ null */
  ids: readonly string[] | null = null;
  /** 並べ替えの落とし先（その行の前か後ろ） */
  target: { id: string; edge: DropEdge } | null = null;
  /** 行ごとの「運ばれているか」「落とし先の印」（行は自分の id だけを観測する） */
  readonly #dragging = observable.map<string, true>();
  readonly #edges = observable.map<string, DropEdge>();

  constructor() {
    makeObservable(this, {
      ids: observableRef,
      target: observableRef,
      start: action,
      setTarget: action,
      clearTarget: action,
      end: action,
    });
  }

  isDragging(id: string): boolean {
    return this.#dragging.has(id);
  }

  edgeOf(id: string): DropEdge | undefined {
    return this.#edges.get(id);
  }

  start(ids: readonly string[]): void {
    this.end();
    this.ids = ids;
    for (const id of ids) this.#dragging.set(id, true);
  }

  setTarget(id: string, edge: DropEdge): void {
    if (this.target?.id === id && this.target.edge === edge) return;
    this.clearTarget();
    this.target = { id, edge };
    this.#edges.set(id, edge);
  }

  clearTarget(): void {
    if (this.target) this.#edges.delete(this.target.id);
    this.target = null;
  }

  end(): void {
    this.clearTarget();
    this.ids = null;
    this.#dragging.clear();
  }
}

const drags = new WeakMap<ListUi, TaskDrag>();

export function taskDragOf(ui: ListUi): TaskDrag {
  let drag = drags.get(ui);
  if (!drag) {
    drag = new TaskDrag();
    drags.set(ui, drag);
  }
  return drag;
}

/** 複数を運ぶときに、つかんだ位置に「3件」と出す（ボードのカードでも使う） */
export function setCountImage(event: DragEvent, count: number): void {
  const transfer = event.dataTransfer;
  if (count < 2 || typeof transfer?.setDragImage !== "function") return;
  const ghost = document.createElement("div");
  ghost.textContent = `${count}件`;
  ghost.className =
    "fixed -top-40 left-0 rounded-md bg-primary px-2 py-0.5 text-primary-foreground text-xs";
  document.body.append(ghost);
  transfer.setDragImage(ghost, -10, -10);
  setTimeout(() => ghost.remove(), 0);
}

/** 行をつかんだとき */
export function startRowDrag(ui: ListUi, task: TaskRow, event: DragEvent): void {
  let rows: readonly TaskRow[];
  if (ui.isSelected(task.id) && ui.selectedIds.length > 1) {
    // 500 件の判定は、未完了に絞る前の選んだ件数で（キーの操作と同じ決まり）
    if (!withinBulkLimit(ui, ui.selectedRows.length)) {
      event.preventDefault();
      return;
    }
    rows = openRowsOf(ui.selectedRows);
  } else {
    ui.select(task.id);
    rows = [task];
  }
  if (rows.length === 0) {
    event.preventDefault();
    return;
  }
  taskDragOf(ui).start(rows.map((row) => row.id));
  const transfer = event.dataTransfer;
  if (transfer) {
    transfer.effectAllowed = "move";
    transfer.setData("text/plain", rows.map((row) => row.title).join("\n"));
  }
  setCountImage(event, rows.length);
}

/** 行（開いた欄を含む）の上を運んでいるとき：同じ並べ替えられるまとまりなら、前か後ろに線を出す */
export function dragOverRow(ui: ListUi, taskId: string, event: DragEvent): void {
  const drag = taskDragOf(ui);
  const ids = drag.ids;
  if (!ids) return;
  const section = ui.reorderableSectionOf([...ids, taskId]);
  if (!section) {
    drag.clearTarget();
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  const rect = document.getElementById(taskRowId(taskId))?.getBoundingClientRect();
  const edge: DropEdge = rect && event.clientY < rect.top + rect.height / 2 ? "before" : "after";
  // 落としても並びが変わらない位置には線を出さない
  const changes =
    !ids.includes(taskId) &&
    planDrop(
      section.rows.map((row) => row.id),
      ids,
      taskId,
      edge,
    ) !== null;
  if (changes) drag.setTarget(taskId, edge);
  else drag.clearTarget();
}

/** 行の上で落としたとき：並べ替える */
export function dropOnRow(ui: ListUi, event: DragEvent): void {
  const drag = taskDragOf(ui);
  const ids = drag.ids;
  const target = drag.target;
  if (!ids) return;
  event.preventDefault();
  drag.end();
  if (target) dropRows(ui, ids, target.id, target.edge);
  ui.focusList();
}

/**
 * サイドバーなど、行の外の落とし先。運んでいるあいだは受け付け、重なっているあいだは over が true。
 * 落としたら onDrop に運んでいたタスクと落とし先の要素を渡す（onDrop が null なら受け付けない）
 */
export function useTaskDropTarget(
  onDrop: ((ids: readonly string[], element: HTMLElement) => void) | null,
  {
    openOnly = false,
  }: {
    /**
     * 未完了のタスクを運んでいるときだけ受け付ける（サイドバーの今日・あとで・予定。完了済みは移せないので、
     * ボードの完了のカードを運んでいるときは光らせず、落とせない表示にする）
     */
    openOnly?: boolean;
  } = {},
) {
  const ui = useUi();
  const [over, setOver] = useState(false);
  const accepts = () => {
    const ids = taskDragOf(ui).ids;
    if (onDrop === null || ids === null) return false;
    return !openOnly || ids.some((id) => ui.store.task(id)?.peek().completedAt === null);
  };
  const hover = (event: DragEvent<HTMLElement>) => {
    if (!accepts()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    setOver(true);
  };
  return {
    over,
    dropProps: {
      onDragEnter: hover,
      onDragOver: hover,
      onDragLeave: (event: DragEvent<HTMLElement>) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) setOver(false);
      },
      onDrop: (event: DragEvent<HTMLElement>) => {
        const drag = taskDragOf(ui);
        const ids = drag.ids;
        setOver(false);
        if (!ids || onDrop === null || !accepts()) return;
        event.preventDefault();
        drag.end();
        onDrop(ids, event.currentTarget);
      },
    },
  };
}
