import {
  POINTS,
  type Points,
  PRIORITIES,
  PRIORITY_LABELS,
  type Priority,
} from "@shared/priority-points";
import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useEffect, useState } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
} from "@/components/ui/combobox";
import type { OperationResult, TaskRow } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { runTaskOperation, toastSubject } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import type { PickerPopupProps, PickerSession, RowPicker } from "@/tasks/row-picker";
import { chipClassName } from "@/tasks/task-detail";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { PriorityMark, VALUE_LABELS, type ValueKind, valuePlaceholder } from "./values";

/**
 * ⇧P（優先度）と e（工数）の、後から読み込む部品：小さな候補（coss ui の Combobox）と、開いたタスクのボタン。
 * Base UI の Combobox を含むので、起動の JS から外す（開閉の状態は picker.tsx。ここから picker.tsx や register.tsx は
 * 読み込まない。起動の JS の分け方を変えないように、開く操作はボタンの持ち主から受け取る）。
 * 候補は、出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする。
 * - 優先度：高・中・低・なし。1・2・3・0 のキーでその場で決まる。↑↓ と Enter でもよい
 * - 工数：1・2・3・5・8・13・なし。数字を打つと、その数字で始まるものに絞り込まれ、Enter で決まる（13 は 1 と 3。
 *   0 でなし）。↑↓ と Enter でもよい
 * どちらも変換中の Enter では決めない。決めたら選んでいるすべてのタスクに1つの操作としてかける（⌘Z 1回で戻る）
 */

/** 候補の1つ。key は、その候補を選ぶキー（優先度はその場で決まる、工数は打つと絞り込まれる） */
type ValueOption<T> = { value: T | null; label: string; key: string };

const NONE = { value: null, label: "なし", key: "0" } as const;

const PRIORITY_OPTIONS: readonly ValueOption<Priority>[] = [
  ...PRIORITIES.map((priority, i) => ({
    value: priority,
    label: PRIORITY_LABELS[priority],
    key: String(i + 1),
  })),
  NONE,
];

const POINTS_OPTIONS: readonly ValueOption<Points>[] = [
  ...POINTS.map((points) => ({ value: points, label: String(points), key: String(points) })),
  NONE,
];

/** 打った文字に合う工数の候補（全角の数字も読む）。何も打っていなければすべて */
export function pointsOptions(query: string): readonly ValueOption<Points>[] {
  const q = query.normalize("NFKC").trim();
  return POINTS_OPTIONS.filter((option) => option.key.startsWith(q));
}

/** 押したキーが選ぶ優先度の候補（修飾キーなしの 1・2・3・0。全角の数字も読む） */
function priorityOptionOfKey(event: KeyboardEvent): ValueOption<Priority> | undefined {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return undefined;
  const key = event.key.normalize("NFKC");
  return PRIORITY_OPTIONS.find((option) => option.key === key);
}

/**
 * 優先度か工数を付ける・外す（null）。2件以上なら「3件の優先度を高に・元に戻す」。1件の行への変更は、行の印が変わるので
 * トーストを出さない（行は一覧から抜けない）
 */
export function setTaskValue(
  ui: ListUi,
  kind: ValueKind,
  ids: readonly string[],
  value: Priority | Points | null,
): OperationResult {
  const { actions } = ui.store;
  return runTaskOperation(ui, {
    ids,
    perform: () =>
      kind === "priority"
        ? actions.setPriority(ids, value as Priority | null)
        : actions.setPoints(ids, value as Points | null),
    toast: (left, changed) => {
      const subject = toastSubject(ui, left, changed);
      if (subject === undefined) return undefined;
      const name = VALUE_LABELS[kind];
      if (value === null) return `${subject}の${name}を外しました`;
      return `${subject}の${name}を${kind === "priority" ? PRIORITY_LABELS[value as Priority] : value}に`;
    },
  });
}

/** 閉じて、開いた元へフォーカスを戻す（ボタンから開いたらボタンへ。ボタンが消えていたら一覧へ。小さな詳細からなら戻さない） */
function closePicker(ui: ListUi, picker: RowPicker, { anchor, detached }: PickerSession): void {
  picker.close();
  if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
  else if (!detached) ui.focusList();
}

/**
 * 開いたタスクの一番下の列：優先度（「優先度 高」と印）と工数（「工数 3」）。なしなら点線の「優先度」「工数」。
 * 押すと ⇧P・e と同じ候補が、このボタンから広がる（onOpen）。リストで開いた詳細と、小さな詳細の両方に出る
 */
export const ValueChip = observer(function ValueChip({
  task,
  kind,
  onOpen,
}: {
  task: TaskRow;
  kind: ValueKind;
  onOpen: (anchor: Element) => void;
}) {
  const label = VALUE_LABELS[kind];
  const priority = kind === "priority" ? task.priority : null;
  const value =
    priority !== null ? PRIORITY_LABELS[priority] : kind === "points" ? task.points : null;
  return (
    <button
      type="button"
      aria-label={value === null ? `${label}を付ける` : `${label}：${value}`}
      className={cn(
        chipClassName,
        "outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
        value === null && "border-dashed text-muted-foreground/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen(event.currentTarget);
      }}
    >
      {priority !== null && <PriorityMark priority={priority} />}
      {value === null ? label : `${label} ${value}`}
    </button>
  );
});

export function PriorityPickerPopup(props: PickerPopupProps) {
  return <ValuePickerPopup {...props} kind="priority" />;
}

export function PointsPickerPopup(props: PickerPopupProps) {
  return <ValuePickerPopup {...props} kind="points" />;
}

type AnyOption = ValueOption<Priority | Points>;

/** 開いている候補（session）か、閉じる途中の候補（消えるときのフェードのあいだ）を描く */
const ValuePickerPopup = observer(function ValuePickerPopup({
  kind,
  task,
  picker,
  session,
  initialQuery,
}: PickerPopupProps & { kind: ValueKind }) {
  const ui = useUi();
  const { store } = ui;
  const priority = kind === "priority";
  // 優先度は文字を打たない（キーでその場で決まる）。工数は読み込みを待つあいだに打った数字から始める
  const [query, setQuery] = useState(priority ? "" : initialQuery);
  const { anchor, taskIds } = session;
  /** 閉じる途中なら false（フェードが終わったら picker.left で描くのをやめる） */
  const open = picker.session?.id === session.id;
  // 行と一緒に消えたとき（ほかのタブで削除されたなど）は、フェードの終わりを待たずに描くのをやめる
  useEffect(() => () => picker.left(session.id), [picker, session.id]);
  const items: readonly AnyOption[] = priority ? PRIORITY_OPTIONS : pointsOptions(query);
  // 複数のタスクにかけるときは、値がそろっているときだけ「今の値」として印を付ける
  const values = taskIds.map((id) => {
    const row = id === task.id ? task : store.task(id);
    return priority ? row?.priority : row?.points;
  });
  const shared = values.every((value) => value === values[0]) ? values[0] : undefined;
  const current = items.find((item) => item.value === shared) ?? null;

  const choose = (item: AnyOption) => {
    const result = setTaskValue(ui, kind, taskIds, item.value);
    // オフラインで受け付けられなかったときは、開いたままにする
    if (!result.ok && result.reason === "offline") return;
    closePicker(ui, picker, session);
  };

  return (
    <Combobox<AnyOption>
      open={open}
      onOpenChange={(next) => {
        if (!next && open) closePicker(ui, picker, session);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) picker.left(session.id);
      }}
      items={items}
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      value={current}
      onValueChange={(item) => {
        if (item) choose(item);
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      itemToStringLabel={(item) => item.label}
      autoHighlight
    >
      <ComboboxPopup
        anchor={anchor ?? (() => document.getElementById(taskRowId(task.id)))}
        align={anchor ? "start" : "end"}
        // 候補の中ではアプリのキー（↑↓ や Enter）を止める。行のクリック（開閉）にも伝えない
        data-keymap="off"
        onClick={(event) => event.stopPropagation()}
        className="w-44 min-w-0 duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="border-b p-1">
          <ComboboxPrimitive.Input
            aria-label={VALUE_LABELS[kind]}
            placeholder={valuePlaceholder(kind, taskIds)}
            autoFocus
            // 優先度は文字を受けない（1・2・3・0 はその場で決まる）
            readOnly={priority}
            inputMode="numeric"
            onFocus={(event) => {
              const { length } = event.currentTarget.value;
              event.currentTarget.setSelectionRange(length, length);
            }}
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
            onKeyDown={(event) => {
              // 変換中のキー（確定の Enter を含む）は Base UI に渡さない。Base UI が止めるのは
              // keyCode 229 のときだけで、isComposing だけが立つ確定の Enter では候補を選んでしまう
              if (isComposingKey(event.nativeEvent)) {
                event.preventBaseUIHandler();
                return;
              }
              const option = priority ? priorityOptionOfKey(event) : undefined;
              if (option) {
                event.preventDefault();
                event.preventBaseUIHandler();
                choose(option);
              }
            }}
          />
        </div>
        <ComboboxEmpty>1・2・3・5・8・13 か、0（なし）</ComboboxEmpty>
        <ComboboxList>
          {(item: AnyOption) => (
            <ComboboxItem
              key={item.key}
              value={item}
              className={item.value === null ? "text-muted-foreground" : undefined}
            >
              <span className="flex items-center justify-between gap-3">
                <span>{item.label}</span>
                {priority && (
                  <kbd className="font-sans text-faint-foreground text-xs">{item.key}</kbd>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
