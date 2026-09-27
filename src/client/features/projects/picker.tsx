import { action, makeObservable, observable } from "mobx";
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
 */
export function pickerItems(
  projects: readonly ProjectRow[],
  query: string,
  currentProjectId: string | null,
): PickerItem[] {
  const q = normalizeName(query);
  const items: PickerItem[] = projects
    .filter((project) => normalizeName(project.name).includes(q))
    .map((project) => ({ kind: "project", id: project.id, label: project.name }));
  const name = query.trim();
  if (q !== "" && !projects.some((project) => normalizeName(project.name) === q)) {
    items.push({ kind: "create", name, label: `「${name}」を作成` });
  }
  if (q === "" && currentProjectId !== null) {
    items.push({ kind: "clear", label: "プロジェクトを外す" });
  }
  return items;
}

/** 候補を開いているタスクと、広げる元。一覧の状態（ListUi）ごとに1つ */
export class ProjectPicker {
  taskId: string | null = null;
  /** 広げる元の要素（開いたタスクのボタン）。null なら行から広げる */
  anchor: Element | null = null;
  /** 行ごとの「候補を開いているか」（行は自分の id だけを観測する） */
  readonly #openFlags = observable.map<string, true>();

  constructor() {
    makeObservable(this, { taskId: observable, open: action, close: action });
  }

  isOpenFor(taskId: string): boolean {
    return this.#openFlags.has(taskId);
  }

  open(taskId: string, anchor: Element | null = null): void {
    this.close();
    this.taskId = taskId;
    this.anchor = anchor;
    this.#openFlags.set(taskId, true);
  }

  close(): void {
    if (this.taskId !== null) this.#openFlags.delete(this.taskId);
    this.taskId = null;
    this.anchor = null;
  }
}

const pickers = new WeakMap<ListUi, ProjectPicker>();

export function projectPickerOf(ui: ListUi): ProjectPicker {
  let picker = pickers.get(ui);
  if (!picker) {
    picker = new ProjectPicker();
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
  const items = pickerItems(store.lists.projects, query, task.projectId);
  const current = items.find((item) => item.kind === "project" && item.id === task.projectId);

  const close = () => {
    picker.close();
    ui.focusList();
  };

  const choose = (item: PickerItem) => {
    const result =
      item.kind === "create"
        ? createProjectFor(ui, [task.id], item.name)
        : setTaskProject(ui, [task.id], item.kind === "project" ? item.id : null);
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
            placeholder="プロジェクト名"
            autoFocus
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
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
