import type { ChecklistItem } from "@shared/model";
import { GripVerticalIcon, XIcon } from "lucide-react";
import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { type DragControls, Reorder, useDragControls } from "motion/react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Checkbox } from "@/components/ui/checkbox";
import type { OperationResult, TaskRow } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { LAYOUT_TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { runTaskOperation } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import { fieldFocusClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import {
  type ChecklistDrafts,
  checklistDraftsOf,
  moveItem,
  orderItems,
  removeItem,
  renameItem,
  sameOrder,
  toggleItem,
} from "./checklist";

/**
 * 開いたタスクのチェックリスト（メモの下）。
 * - チェック・追加・削除・並べ替えは操作として送り、⌘Z で戻せる
 * - 項目の名前は、タイトルやメモと同じく自動保存（⌘Z の対象にしない）
 * - 並べ替えは、左のつまみのドラッグか、項目の中で ⌥↑／⌥↓
 * - 全部チェックしても、タスクは完了にしない
 * 項目の欄のキー：Enter で次の項目へ、↑↓ で上下の項目へ、空の欄で ⌫ を押すと項目を消す、Esc でタスクを閉じる
 */

/**
 * ドラッグを離したときに、項目が収まる場所へ戻るばね。減衰を臨界（2√剛性）より少し強くして跳ねさせない
 * （約 150ms で収まる）
 */
const SETTLE_TRANSITION = { bounceStiffness: 1000, bounceDamping: 64 } as const;

/** 打つのが止まってから保存するまでの時間（タイトルとメモと同じ） */
const AUTOSAVE_DELAY_MS = 500;

export function checklistItemInputId(taskId: string, itemId: string): string {
  return `checklist-${taskId}-${itemId}`;
}

export function checklistAddInputId(taskId: string): string {
  return `checklist-${taskId}-add`;
}

function newItemId(): string {
  return crypto.randomUUID();
}

/** チェックリストを変える操作（元に戻せる） */
function performChecklist(
  ui: ListUi,
  task: TaskRow,
  next: readonly ChecklistItem[],
): OperationResult {
  return runTaskOperation(ui, {
    ids: [task.id],
    perform: () => ui.store.actions.updateTask(task.id, { checklist: [...next] }),
  });
}

/** 欄にフォーカスを移す（文字の最後か最初にカーソルを置く） */
function focusField(id: string, caret: "start" | "end" = "end"): void {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLInputElement)) return;
  element.focus();
  const at = caret === "end" ? element.value.length : 0;
  element.setSelectionRange(at, at);
}

export const ChecklistEditor = observer(function ChecklistEditor({ task }: { task: TaskRow }) {
  const ui = useUi();
  const drafts = checklistDraftsOf(ui.store);
  const items = task.checklist;
  /** ドラッグしているあいだの並び（離したときに送る） */
  const [dragOrder, setDragOrderState] = useState<readonly string[] | null>(null);
  const dragOrderRef = useRef<readonly string[] | null>(null);
  /** 並べ替えや削除のあとにフォーカスを移す先（描き直したあとで移す） */
  const [focusAfter, setFocusAfter] = useState<{ id: string; caret: "start" | "end" } | null>(null);

  useLayoutEffect(() => {
    if (!focusAfter) return;
    focusField(focusAfter.id, focusAfter.caret);
    setFocusAfter(null);
  }, [focusAfter]);

  const setDragOrder = (order: readonly string[] | null) => {
    dragOrderRef.current = order;
    setDragOrderState(order);
  };

  const current = () => task.peek().checklist;
  const shown = dragOrder ? orderItems(items, dragOrder) : items;
  const inputOf = (itemId: string) => checklistItemInputId(task.id, itemId);
  const addInput = checklistAddInputId(task.id);

  const toggle = (itemId: string) => performChecklist(ui, task, toggleItem(current(), itemId));

  const move = (itemId: string, delta: -1 | 1) => {
    const before = current();
    const next = moveItem(before, itemId, delta);
    if (sameOrder(before, next)) return;
    const result = performChecklist(ui, task, next);
    // 動かした項目の欄は描き直しでフォーカスが外れることがあるので、描いたあとで戻す
    if (result.ok) setFocusAfter({ id: inputOf(itemId), caret: "end" });
  };

  const remove = (itemId: string) => {
    const before = current();
    const index = before.findIndex((item) => item.id === itemId);
    const result = performChecklist(ui, task, removeItem(before, itemId));
    if (!result.ok) return;
    const neighbor = before[index - 1] ?? before[index + 1];
    setFocusAfter({ id: neighbor ? inputOf(neighbor.id) : addInput, caret: "end" });
  };

  const commitDrag = () => {
    const order = dragOrderRef.current;
    setDragOrder(null);
    if (!order) return;
    const before = current();
    const next = orderItems(before, order);
    if (!sameOrder(before, next)) performChecklist(ui, task, next);
  };

  /** 上下の欄へ（一番下の項目の下は「項目を追加」の欄） */
  const focusSibling = (itemId: string, delta: -1 | 1) => {
    const index = shown.findIndex((item) => item.id === itemId);
    const target = shown[index + delta];
    if (target) focusField(inputOf(target.id));
    else if (delta > 0) focusField(addInput);
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 開いたタスクの欄の中の、チェックリストのまとまり
    <div role="group" aria-label="チェックリスト" className="-my-1 flex flex-col">
      {shown.length > 0 && (
        <Reorder.Group
          as="ul"
          axis="y"
          values={shown.map((item) => item.id)}
          onReorder={setDragOrder}
          className="flex flex-col"
        >
          {shown.map((item) => (
            <ChecklistItemRow
              key={item.id}
              task={task}
              item={item}
              drafts={drafts}
              inputId={inputOf(item.id)}
              onToggle={() => toggle(item.id)}
              onMove={(delta) => move(item.id, delta)}
              onRemove={() => remove(item.id)}
              onFocusSibling={(delta) => focusSibling(item.id, delta)}
              onDragEnd={commitDrag}
            />
          ))}
        </Reorder.Group>
      )}
      <AddItemInput
        task={task}
        drafts={drafts}
        inputId={addInput}
        onFocusLast={() => {
          const last = shown.at(-1);
          if (last) focusField(inputOf(last.id));
        }}
      />
    </div>
  );
});

const ChecklistItemRow = observer(function ChecklistItemRow({
  task,
  item,
  drafts,
  inputId,
  onToggle,
  onMove,
  onRemove,
  onFocusSibling,
  onDragEnd,
}: {
  task: TaskRow;
  item: ChecklistItem;
  drafts: ChecklistDrafts;
  inputId: string;
  onToggle: () => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onFocusSibling: (delta: -1 | 1) => void;
  onDragEnd: () => void;
}) {
  const ui = useUi();
  const controls = useDragControls();
  const field = useItemTitle(task, item, drafts);
  const name = field.value.trim() === "" ? item.title : field.value;

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        field.flush();
        onMove(event.key === "ArrowUp" ? -1 : 1);
      }
      return;
    }
    if (!plain) return;
    // チェックボックスの上の Enter は、Space と同じくチェックにする（開いたタスクのタイトルへ移さない）
    if (
      event.key === "Enter" &&
      event.target instanceof Element &&
      event.target.getAttribute("role") === "checkbox"
    ) {
      event.preventDefault();
      onToggle();
      return;
    }
    if (!(event.target instanceof HTMLInputElement)) return;
    switch (event.key) {
      case "Enter":
      case "ArrowDown":
        event.preventDefault();
        field.flush();
        onFocusSibling(1);
        return;
      case "ArrowUp":
        event.preventDefault();
        field.flush();
        onFocusSibling(-1);
        return;
      case "Escape":
        event.preventDefault();
        field.flush();
        ui.close();
        ui.focusList();
        return;
      case "Backspace":
        if (field.value === "") {
          event.preventDefault();
          field.discard();
          onRemove();
        }
        return;
    }
  };

  return (
    <Reorder.Item
      as="li"
      value={item.id}
      dragListener={false}
      dragControls={controls}
      // 動きのルールにそろえる：ほかの項目が詰まる動きは 200ms の減速、離したときは勢いを付けずに行き過ぎずに収まる
      transition={LAYOUT_TRANSITION}
      dragMomentum={false}
      dragTransition={SETTLE_TRANSITION}
      onDragEnd={onDragEnd}
      className="group/item relative flex min-h-7 items-center gap-2.5 bg-card"
      onKeyDown={onKeyDown}
    >
      <DragHandle controls={controls} />
      <Checkbox
        checked={item.done}
        onCheckedChange={onToggle}
        aria-label={name}
        className="size-3.5 sm:size-3.5"
      />
      <input
        id={inputId}
        aria-label="項目"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-sm leading-6",
          fieldFocusClassName,
          item.done && "text-muted-foreground line-through",
        )}
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onFocus={field.onFocus}
        onBlur={field.onBlur}
        onCompositionStart={field.onCompositionStart}
        onCompositionEnd={field.onCompositionEnd}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={`「${name}」を削除`}
        className="grid size-5 flex-none place-items-center rounded-sm text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/item:opacity-100"
        onClick={() => {
          field.discard();
          onRemove();
        }}
      >
        <XIcon aria-hidden="true" className="size-3.5" />
      </button>
    </Reorder.Item>
  );
});

/** 左のつまみ。ここを押しているあいだだけドラッグで並べ替える（欄の文字の選択と取り合わないように） */
function DragHandle({ controls }: { controls: DragControls }) {
  return (
    <span
      aria-hidden="true"
      className="absolute top-1/2 -left-4 grid size-4 -translate-y-1/2 cursor-grab touch-none place-items-center text-muted-foreground/60 opacity-0 active:cursor-grabbing group-hover/item:opacity-100"
      onPointerDown={(event) => {
        event.preventDefault();
        controls.start(event);
      }}
    >
      <GripVerticalIcon className="size-3.5" />
    </span>
  );
}

/** 「項目を追加」の欄。Enter で一番下に足して、そのまま次を打てる */
const AddItemInput = observer(function AddItemInput({
  task,
  drafts,
  inputId,
  onFocusLast,
}: {
  task: TaskRow;
  drafts: ChecklistDrafts;
  inputId: string;
  onFocusLast: () => void;
}) {
  const ui = useUi();
  const value = drafts.addDraft(task.id);

  const add = () => {
    const title = value.trim();
    if (title === "") return;
    const result = performChecklist(ui, task, [
      ...task.peek().checklist,
      { id: newItemId(), title, done: false },
    ]);
    // オフラインなどで受け付けられなかったら、打った文字は残す
    if (result.ok) drafts.noteAdded(task.id);
  };

  return (
    <div className="flex min-h-7 items-center gap-2.5">
      <span
        aria-hidden="true"
        className="size-3.5 flex-none rounded-[.25rem] border border-muted-foreground/30 border-dashed"
      />
      <input
        id={inputId}
        aria-label="項目を追加"
        placeholder="項目を追加"
        className={cn(
          "min-w-0 flex-1 bg-transparent text-sm leading-6 placeholder:text-muted-foreground/60",
          fieldFocusClassName,
        )}
        value={value}
        onChange={(event) => drafts.setAddDraft(task.id, event.target.value)}
        onKeyDown={(event) => {
          if (isComposingKey(event.nativeEvent)) return;
          if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
          if (event.key === "Enter") {
            event.preventDefault();
            add();
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            onFocusLast();
          } else if (event.key === "Escape") {
            event.preventDefault();
            ui.close();
            ui.focusList();
          }
        }}
      />
    </div>
  );
});

/**
 * 項目の名前の自動保存（タイトルやメモの useAutosave と同じ決まり）。
 * 打つのが止まったら・フォーカスが外れたら・閉じたら保存する。⌘Z の対象にしない。変換中は保存しない。
 * 空の名前は保存しない（フォーカスが外れたら元の名前に戻る）。保存できなかった文字は ChecklistDrafts に残し、欄に戻す
 */
function useItemTitle(task: TaskRow, item: ChecklistItem, drafts: ChecklistDrafts) {
  const { store } = useUi();
  const itemId = item.id;
  const stored = item.title;
  const [initial] = useState(() => {
    const unsaved = drafts.unsavedTitle(task.id, itemId);
    return { value: unsaved ?? stored, unsaved: unsaved !== undefined };
  });
  const [value, setValueState] = useState(initial.value);
  const valueRef = useRef(initial.value);
  const dirty = useRef(initial.unsaved);
  const focused = useRef(false);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setValue = useCallback((next: string) => {
    valueRef.current = next;
    setValueState(next);
  }, []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current || composing.current) return;
    const title = valueRef.current;
    if (title.trim() === "") return;
    const items = store.task(task.id)?.peek().checklist;
    const target = items?.find((entry) => entry.id === itemId);
    if (!items || !target || target.title === title) {
      dirty.current = false;
      drafts.clearUnsavedTitle(task.id, itemId);
      return;
    }
    const result = store.actions.updateTask(
      task.id,
      { checklist: renameItem(items, itemId, title) },
      { undoable: false, autosave: true },
    );
    // オフラインなどで受け付けられなかったら、次の機会にもう一度保存する
    if (result.ok || result.reason === "noop") {
      dirty.current = false;
      drafts.clearUnsavedTitle(task.id, itemId);
    }
  }, [store, task, itemId, drafts]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  }, [flush]);

  // 入力していないあいだは、ストアの値（同期・ほかのタブの変更）に合わせる
  useEffect(() => {
    if (!focused.current && !dirty.current) setValue(stored);
  }, [stored, setValue]);

  // 開いているあいだに保存できなかったら、その文字を欄に戻す（あとで打った文字があれば、そちらを残す）
  useEffect(
    () =>
      reaction(
        () => drafts.unsavedTitle(task.id, itemId),
        (unsaved) => {
          if (unsaved === undefined || dirty.current) return;
          dirty.current = true;
          setValue(unsaved);
        },
      ),
    [drafts, task, itemId, setValue],
  );

  // 閉じるとき（部品が消えるとき）に保存する。保存できなければ、次に開いたときのために残す
  useEffect(
    () => () => {
      flush();
      const title = valueRef.current;
      if (dirty.current && title.trim() !== "") drafts.keepUnsavedTitle(task.id, itemId, title);
    },
    [flush, drafts, task, itemId],
  );

  return {
    value,
    onChange: (next: string) => {
      setValue(next);
      dirty.current = true;
      if (!composing.current) schedule();
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      flush();
      // 空のまま離れたら、元の名前に戻す
      if (valueRef.current.trim() === "") {
        dirty.current = false;
        setValue(
          store
            .task(task.id)
            ?.peek()
            .checklist.find((e) => e.id === itemId)?.title ?? "",
        );
      }
    },
    onCompositionStart: () => {
      composing.current = true;
      clearTimeout(timer.current);
    },
    onCompositionEnd: () => {
      composing.current = false;
      schedule();
    },
    /** 今すぐ保存する */
    flush,
    /** 項目を消すとき：打ちかけの文字は保存しない */
    discard: () => {
      clearTimeout(timer.current);
      dirty.current = false;
      drafts.clearUnsavedTitle(task.id, itemId);
    },
  };
}
