import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { TaskRow } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { detailFieldsOf } from "./extensions";
import { LinkifiedText } from "./linkified-text";
import type { ListView } from "./list-ui";
import { useUi } from "./ui-context";
import { useAutosave } from "./use-autosave";

/** 開いたタスクのタイトルの入力欄の id（Enter でここにフォーカスを移す） */
export function titleInputId(taskId: string): string {
  return `task-title-${taskId}`;
}

/** 入力欄で Enter・Esc を押したら保存して閉じ、一覧にフォーカスを戻す（変換を確定するキーでは閉じない） */
function useCloseKeys(flush: () => void, keys: readonly string[]) {
  const ui = useUi();
  return (event: KeyboardEvent) => {
    if (isComposingKey(event.nativeEvent) || !keys.includes(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    flush();
    ui.close();
    ui.focusList();
  };
}

/** 開いた行のタイトル。行の中で、そのまま直せる */
export const TitleInput = observer(function TitleInput({ task }: { task: TaskRow }) {
  const field = useAutosave(task, "title");
  const onKeyDown = useCloseKeys(field.flush, ["Enter", "Escape"]);
  return (
    <input
      id={titleInputId(task.id)}
      aria-label="タイトル"
      className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
      placeholder="タイトル"
      value={field.value}
      onChange={(event) => field.onChange(event.target.value)}
      onFocus={field.onFocus}
      onBlur={field.onBlur}
      onCompositionStart={field.onCompositionStart}
      onCompositionEnd={field.onCompositionEnd}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    />
  );
});

/** 開いたタスクの下に広がる欄：メモ、登録された欄（チェックリストなど）、一番下の小さなボタンの列 */
export const TaskDetail = observer(function TaskDetail({
  task,
  view,
}: {
  task: TaskRow;
  view: ListView;
}) {
  const sections = detailFieldsOf("section");
  const chips = detailFieldsOf("chip");
  return (
    // biome-ignore lint/a11y/useSemanticElements: 一覧（listbox）の中の、開いたタスクの欄のまとまり
    <div
      role="group"
      aria-label={`「${task.title}」の詳細`}
      className="mt-0.5 mb-2 ml-9 flex flex-col gap-3 rounded-lg border bg-card px-4 py-3"
    >
      <MemoEditor task={task} />
      {sections.map(({ id, Component }) => (
        <Component key={id} task={task} view={view} />
      ))}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map(({ id, Component }) => (
            <Component key={id} task={task} view={view} />
          ))}
        </div>
      )}
    </div>
  );
});

/** 開いたタスクの欄の、小さなボタンの見た目（5・6 の締切やプロジェクトもこれを使う） */
export const chipClassName =
  "inline-flex h-6 items-center gap-1 rounded-full border px-2.5 text-muted-foreground text-xs";

/**
 * メモ。ふだんは URL をリンクにして出し（クリックで新しいタブ）、文字の部分をクリックするか
 * Tab で入ると、書き直せる欄になる
 */
const MemoEditor = observer(function MemoEditor({ task }: { task: TaskRow }) {
  const [editing, setEditing] = useState(false);
  const field = useAutosave(task, "memo");
  const onKeyDown = useCloseKeys(field.flush, ["Escape"]);
  const textarea = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    const element = textarea.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, [editing]);

  if (editing) {
    return (
      <textarea
        ref={textarea}
        aria-label="メモ"
        placeholder="メモ"
        rows={1}
        className="field-sizing-content min-h-6 w-full resize-none bg-transparent text-muted-foreground text-sm leading-6 outline-none placeholder:text-muted-foreground/60"
        value={field.value}
        onChange={(event) => field.onChange(event.target.value)}
        onFocus={field.onFocus}
        onBlur={() => {
          field.onBlur();
          setEditing(false);
        }}
        onCompositionStart={field.onCompositionStart}
        onCompositionEnd={field.onCompositionEnd}
        onKeyDown={onKeyDown}
      />
    );
  }

  const empty = field.value.trim() === "";
  return (
    // biome-ignore lint/a11y/useSemanticElements: 中に URL のリンクを含むので button にはできない
    <div
      role="button"
      tabIndex={0}
      aria-label={empty ? "メモを書く" : "メモを直す"}
      className={cn(
        "min-h-6 cursor-text whitespace-pre-wrap break-words text-sm leading-6 outline-none",
        empty ? "text-muted-foreground/60" : "text-muted-foreground",
      )}
      onClick={() => setEditing(true)}
      onFocus={(event) => {
        // リンクにフォーカスが入ったとき（クリックで開くとき）は書き直す欄にしない
        if (event.target === event.currentTarget) setEditing(true);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !isComposingKey(event.nativeEvent)) {
          event.preventDefault();
          setEditing(true);
        }
      }}
    >
      {empty ? "メモ" : <LinkifiedText text={field.value} />}
    </div>
  );
});
