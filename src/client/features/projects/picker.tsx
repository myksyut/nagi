import { action, makeObservable, observable, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
} from "@/components/ui/combobox";
import type { ProjectRow, TaskRow } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import type { ListUi } from "@/tasks/list-ui";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { createProjectFor, normalizeName, setTaskProject } from "./commands";

/**
 * p（プロジェクト）の候補。名前を打って絞り込み、Enter で決める。当てはまる名前がなければ
 * 「「◯◯」を作成」が出て、その場で作って付けられる（coss ui の Combobox）。
 * アーカイブ済みのプロジェクトは候補に出さない。付けても置き場は変わらない（受信箱なら受信箱に残る）。
 * 候補は、対象のタスクの行の右側の枠（register.tsx）から描き、行（p のとき）か押したボタンから広がる
 */

/** 候補の1つ */
export type PickerItem =
  | { kind: "project"; id: string; label: string }
  | { kind: "create"; name: string; label: string }
  | { kind: "clear"; label: string };

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

/**
 * 打った文字に合う候補。プロジェクトは作成順で、名前の一部が合うもの（全角と半角、大文字と小文字は区別しない）。
 * 名前がちょうど同じものがなければ、最後に「「◯◯」を作成」。付いているプロジェクトを外す候補は、何も打っていないときだけ
 * （複数のタスクにかけるときは、どれかにプロジェクトが付いていれば canClear）
 */
export function pickerItems(
  projects: readonly ProjectRow[],
  query: string,
  currentProjectId: string | null,
  canClear = currentProjectId !== null,
): PickerItem[] {
  const q = normalizeName(query);
  const items: PickerItem[] = projects
    .filter((project) => normalizeName(project.name).includes(q))
    .map((project) => ({ kind: "project", id: project.id, label: project.name }));
  const name = query.trim();
  if (q !== "" && !projects.some((project) => normalizeName(project.name) === q)) {
    items.push({ kind: "create", name, label: `「${name}」を作成` });
  }
  if (q === "" && canClear) {
    items.push({ kind: "clear", label: "プロジェクトを外す" });
  }
  return items;
}

/**
 * 候補を開いているタスクと、広げる元。一覧の状態（ListUi）ごとに1つ。
 * 複数のタスクにかけるとき（7 の複数選択）は、候補を1回だけ開き、決めたものをすべてに付ける。
 * 候補は先頭のタスク（taskId）の行から広がる。
 * 画面が変わったときと、そのタスクが一覧からなくなったとき（同期・ほかのタブ）は閉じる
 * （候補の部品は行と一緒に消えるので、閉じたことを自分では知らせられない）
 */
export class ProjectPicker {
  /** 候補を描く行（taskIds の先頭） */
  taskId: string | null = null;
  /** 決めたものを付けるタスク */
  taskIds: readonly string[] = [];
  /** 広げる元の要素（開いたタスクのボタン）。null なら行から広げる */
  anchor: Element | null = null;
  /** 行ごとの「候補を開いているか」（行は自分の id だけを観測する） */
  readonly #openFlags = observable.map<string, true>();

  constructor(ui: ListUi) {
    makeObservable(this, { taskId: observable, open: action, close: action });
    reaction(
      () => ui.view,
      () => this.close(),
    );
    reaction(
      () => this.taskId !== null && !ui.rows.some((row) => row.id === this.taskId),
      (gone) => {
        if (gone) this.close();
      },
    );
  }

  isOpenFor(taskId: string): boolean {
    return this.#openFlags.has(taskId);
  }

  /** 候補を開く。taskIds は1つの id か、上から見えている順の id の列 */
  open(taskIds: string | readonly string[], anchor: Element | null = null): void {
    const ids = typeof taskIds === "string" ? [taskIds] : [...taskIds];
    const host = ids[0];
    this.close();
    if (host === undefined) return;
    this.taskId = host;
    this.taskIds = ids;
    this.anchor = anchor;
    this.#openFlags.set(host, true);
  }

  close(): void {
    if (this.taskId !== null) this.#openFlags.delete(this.taskId);
    this.taskId = null;
    this.taskIds = [];
    this.anchor = null;
  }
}

const pickers = new WeakMap<ListUi, ProjectPicker>();

export function projectPickerOf(ui: ListUi): ProjectPicker {
  let picker = pickers.get(ui);
  if (!picker) {
    picker = new ProjectPicker(ui);
    pickers.set(ui, picker);
  }
  return picker;
}

/** 行の右側の枠に置く。そのタスクの候補を開いているときだけ描く */
export const ProjectPickerHost = observer(function ProjectPickerHost({ task }: { task: TaskRow }) {
  const ui = useUi();
  const picker = projectPickerOf(ui);
  if (!picker.isOpenFor(task.id)) return null;
  return <ProjectPickerPopup task={task} picker={picker} />;
});

const ProjectPickerPopup = observer(function ProjectPickerPopup({
  task,
  picker,
}: {
  task: TaskRow;
  picker: ProjectPicker;
}) {
  const ui = useUi();
  const { store } = ui;
  const [query, setQuery] = useState("");
  const [anchor] = useState(() => picker.anchor);
  const [taskIds] = useState(() => (picker.taskIds.length > 0 ? picker.taskIds : [task.id]));
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
      open
      onOpenChange={(open) => {
        if (!open) close();
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
        className="w-64 min-w-0 duration-(--duration-short) data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="border-b p-1">
          <ComboboxPrimitive.Input
            aria-label="プロジェクト"
            placeholder={
              taskIds.length > 1 ? `${taskIds.length}件のプロジェクト` : "プロジェクト名"
            }
            autoFocus
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
