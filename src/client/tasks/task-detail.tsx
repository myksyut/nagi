import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { TaskRow } from "@/data";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import { isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { useDetailSurface } from "./detail-surface";
import { detailFieldsOf } from "./extensions";
import { LinkifiedText } from "./linkified-text";
import type { ListView } from "./list-ui";
import { useAutosave } from "./use-autosave";

// 開いたタスクの欄の中のキー（ショートカットのページの「候補や欄の中」）。下の TitleInput・MemoEditor の onKeyDown と同じ
// （開くとタイトルへ入るのは、キーマップの Enter。小さな詳細でも同じ）。メモは、フォーカスが入ると書く欄になり、
// Enter は改行（閉じるのは Esc だけ）
registerFieldKeys({
  id: "task-detail",
  label: "開いたタスク",
  order: FIELD_SCENE_ORDER.taskDetail,
  keys: [
    { label: "タイトルを保存して閉じる", keys: ["Enter", "Escape"] },
    { label: "改行（メモの中）", keys: ["Enter"] },
    { label: "メモを保存して閉じる", keys: ["Escape"] },
  ],
});

/** 開いたタスクのタイトルの入力欄の id（Enter でここにフォーカスを移す） */
export function titleInputId(taskId: string): string {
  return `task-title-${taskId}`;
}

/** 開いたタスクの入力欄のフォーカスの輪郭（選択中の行の背景とは別に、どこへ打つかを見せる） */
export const fieldFocusClassName =
  "-mx-1 rounded-sm px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring/70";

/**
 * 入力欄で Enter・Esc を押したら保存して閉じる（変換を確定するキーでは閉じない）。
 * 一覧の中なら開いたタスクを閉じて一覧へ、小さな詳細ならポップオーバーを閉じて押した場所へフォーカスを戻す
 */
function useCloseKeys(flush: () => void, keys: readonly string[]) {
  const surface = useDetailSurface();
  return (event: KeyboardEvent) => {
    if (isComposingKey(event.nativeEvent) || !keys.includes(event.key)) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    flush();
    surface.close();
  };
}

/**
 * 開いた行のタイトル。行の中で、そのまま直せる（小さな詳細では、ポップオーバーの一番上）。
 * id は、Enter でフォーカスを移す先（一覧の行）。小さな詳細では同じタスクの行と重ならないよう付けない
 */
export const TitleInput = observer(function TitleInput({
  task,
  id = titleInputId(task.id),
}: {
  task: TaskRow;
  id?: string;
}) {
  const field = useAutosave(task, "title");
  const onKeyDown = useCloseKeys(field.flush, ["Enter", "Escape"]);
  return (
    <input
      id={id}
      aria-label="タイトル"
      className={cn(
        "min-w-0 flex-1 bg-transparent placeholder:text-muted-foreground",
        fieldFocusClassName,
      )}
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
  return (
    // biome-ignore lint/a11y/useSemanticElements: 一覧（listbox）の中の、開いたタスクの欄のまとまり
    <div
      role="group"
      aria-label={`「${task.title}」の詳細`}
      // 左の端はタイトルの位置（行の左の余白 12px ＋ 丸 17px ＋ 間 12px）にそろえる
      className="mt-1 mb-2 ml-[41px] flex flex-col gap-3 rounded-[10px] border bg-card px-4 py-3"
    >
      <TaskDetailFields task={task} view={view} />
    </div>
  );
});

/**
 * 開いたタスクの欄の中身（メモ、登録された欄、一番下の小さなボタンの列）。
 * リストの行の下（TaskDetail）と小さな詳細（task-detail-popover.tsx）の両方で使う。縦に並べる枠は使う側が持つ
 */
export const TaskDetailFields = observer(function TaskDetailFields({
  task,
  view,
}: {
  task: TaskRow;
  view: ListView | null;
}) {
  const sections = detailFieldsOf("section");
  const chips = detailFieldsOf("chip");
  return (
    <>
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
    </>
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
        className={cn(
          "field-sizing-content min-h-6 w-[calc(100%+0.5rem)] resize-none bg-transparent text-muted-foreground text-sm leading-6 placeholder:text-muted-foreground/60",
          fieldFocusClassName,
        )}
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
        "min-h-6 cursor-text whitespace-pre-wrap break-words text-sm leading-6",
        fieldFocusClassName,
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
