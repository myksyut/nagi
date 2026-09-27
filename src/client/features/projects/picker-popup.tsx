import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
} from "@/components/ui/combobox";
import type { TaskRow } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { createProjectFor, setTaskProject } from "./commands";
import {
  PICKER_LABEL,
  type PickerItem,
  type PickerSession,
  type ProjectPicker,
  pickerItems,
  pickerPlaceholder,
} from "./picker";

/**
 * p（プロジェクト）の候補のポップアップ（coss ui の Combobox）。Base UI の Combobox を含むので、
 * このモジュールは後から読み込む（開閉の状態と候補の中身は picker.tsx）。
 * 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする
 */

function itemKey(item: PickerItem): string {
  switch (item.kind) {
    case "project":
      return `project:${item.id}`;
    case "create":
      return "create";
    case "clear":
      return "clear";
  }
}

/** 開いている候補（session）か、閉じる途中の候補（消えるときのフェードのあいだ）を描く */
export const ProjectPickerPopup = observer(function ProjectPickerPopup({
  task,
  picker,
  session,
  initialQuery = "",
}: {
  task: TaskRow;
  picker: ProjectPicker;
  session: PickerSession;
  /** 開いたときの入力欄の文字（読み込みを待つあいだに打った文字） */
  initialQuery?: string;
}) {
  const ui = useUi();
  const { store } = ui;
  const [query, setQuery] = useState(initialQuery);
  const { anchor, taskIds } = session;
  /** 閉じる途中なら false（フェードが終わったら picker.left で描くのをやめる） */
  const open = picker.session?.id === session.id;
  // 行と一緒に消えたとき（振り分けで行が抜けたなど）は、フェードの終わりを待たずに描くのをやめる
  useEffect(() => () => picker.left(session.id), [picker, session.id]);
  // 複数のタスクにかけるときは、付いているプロジェクトがそろっているときだけ「今の値」として出す
  const targets = taskIds.flatMap((id) => {
    const row = id === task.id ? task : store.task(id);
    return row ? [row] : [];
  });
  const shared = targets.every((row) => row.projectId === task.projectId) ? task.projectId : null;
  const items = pickerItems(
    store.lists.projects,
    query,
    shared,
    targets.some((row) => row.projectId !== null),
  );
  const current = items.find((item) => item.kind === "project" && item.id === shared);

  /** 閉じて、開いた元へフォーカスを戻す（ボタンから開いたらボタンへ。ボタンが消えていたら一覧へ） */
  const close = () => {
    picker.close();
    if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
    else ui.focusList();
  };

  const choose = (item: PickerItem) => {
    const result =
      item.kind === "create"
        ? createProjectFor(ui, taskIds, item.name)
        : setTaskProject(ui, taskIds, item.kind === "project" ? item.id : null);
    // オフラインで受け付けられなかったときは、打った名前を残して開いたままにする
    if (!result.ok && result.reason === "offline") return;
    close();
  };

  return (
    <Combobox<PickerItem>
      open={open}
      onOpenChange={(next) => {
        if (!next && open) close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) picker.left(session.id);
      }}
      items={items}
      filter={null}
      inputValue={query}
      onInputValueChange={setQuery}
      value={current ?? null}
      onValueChange={(item) => {
        if (item) choose(item);
      }}
      isItemEqualToValue={(a, b) => itemKey(a) === itemKey(b)}
      itemToStringLabel={(item) => item.label}
      autoHighlight
    >
      <ComboboxPopup
        anchor={anchor ?? (() => document.getElementById(taskRowId(task.id)))}
        align={anchor ? "start" : "end"}
        // 候補の中ではアプリのキー（↑↓ や Enter）を止める。行のクリック（開閉）にも伝えない
        data-keymap="off"
        onClick={(event) => event.stopPropagation()}
        // 出るときは 100ms、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="w-64 min-w-0 duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="border-b p-1">
          <ComboboxPrimitive.Input
            aria-label={PICKER_LABEL}
            placeholder={pickerPlaceholder(taskIds)}
            autoFocus
            // 読み込みを待つあいだに打った文字が入っているときも、続きを打てるよう末尾から
            onFocus={(event) => {
              const { length } = event.currentTarget.value;
              event.currentTarget.setSelectionRange(length, length);
            }}
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
            onKeyDown={(event) => {
              // 変換中のキー（確定の Enter を含む）は Base UI に渡さない。Base UI が止めるのは
              // keyCode 229 のときだけで、isComposing だけが立つ確定の Enter では候補を選んでしまう
              if (isComposingKey(event.nativeEvent)) event.preventBaseUIHandler();
            }}
          />
        </div>
        <ComboboxEmpty>名前を入れると、新しいプロジェクトを作れます</ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => (
            <ComboboxItem
              key={itemKey(item)}
              value={item}
              className={item.kind === "project" ? undefined : "text-muted-foreground"}
            >
              <span className="block truncate">{item.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
