import { action, makeObservable, observable, observableRef, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useState } from "react";
import { useAnchoredStyle, WaitingInput } from "@/components/waiting-input";
import type { ProjectRow, TaskRow } from "@/data";
import { defer, useDeferred } from "@/lib/deferred";
import type { ListUi } from "@/tasks/list-ui";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { normalizeName } from "./commands";

/**
 * p（プロジェクト）の候補の開閉の状態と、それを描く枠。候補そのもの（coss ui の Combobox）は picker-popup.tsx にあり、
 * 起動に要らないので後から読み込む（Base UI の Combobox を最初の JS から外す）。
 * 名前を打って絞り込み、Enter で決める。当てはまる名前がなければ「「◯◯」を作成」が出て、その場で作って付けられる。
 * アーカイブ済みのプロジェクトは候補に出さない。付けても置き場は変わらない（受信箱なら受信箱に残る）。
 * 候補は、対象のタスクの行の右側の枠（register.tsx）から描き、行（p のとき）か押したボタンから広がる
 */

/** 候補の1つ */
export type PickerItem =
  | { kind: "project"; id: string; label: string }
  | { kind: "create"; name: string; label: string }
  | { kind: "clear"; label: string };

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

/** 1回ぶんの候補（開くたびに作る） */
export type PickerSession = {
  /** 開くたびに変わる番号 */
  id: number;
  /** 候補を描く行（taskIds の先頭） */
  taskId: string;
  /** 決めたものを付けるタスク */
  taskIds: readonly string[];
  /** 広げる元の要素（開いたタスクのボタン）。null なら行から広げる */
  anchor: Element | null;
};

/**
 * 候補を開いているタスクと、広げる元。一覧の状態（ListUi）ごとに1つ。
 * 複数のタスクにかけるとき（7 の複数選択）は、候補を1回だけ開き、決めたものをすべてに付ける。
 * 候補は先頭のタスク（taskId）の行から広がる。閉じたときは、消えるときのフェード（150ms）が終わるまで描き続ける（leaving）。
 * 画面が変わったときと、そのタスクが一覧からなくなったとき（同期・ほかのタブ）は、フェードなしで閉じる
 * （候補の部品は行と一緒に消えるので、閉じたことを自分では知らせられない）
 */
export class ProjectPicker {
  /** 開いている候補 */
  session: PickerSession | null = null;
  /** 閉じる途中の候補（消えるときのフェードのあいだだけ描く） */
  leaving: PickerSession | null = null;
  /** 行ごとの「候補を描くか」（行は自分の id だけを観測する） */
  readonly #hosts = observable.map<string, true>();
  #nextId = 1;

  constructor(ui: ListUi) {
    makeObservable(this, {
      session: observableRef,
      leaving: observableRef,
      open: action,
      close: action,
      dismiss: action,
      left: action,
    });
    reaction(
      () => ui.view,
      () => this.dismiss(),
    );
    reaction(
      () => {
        const taskId = this.session?.taskId;
        return taskId !== undefined && !ui.rows.some((row) => row.id === taskId);
      },
      (gone) => {
        if (gone) this.dismiss();
      },
    );
  }

  /** この行が候補を描くか */
  isHost(taskId: string): boolean {
    return this.#hosts.has(taskId);
  }

  /** 候補を開く。taskIds は1つの id か、上から見えている順の id の列 */
  open(taskIds: string | readonly string[], anchor: Element | null = null): void {
    const ids = typeof taskIds === "string" ? [taskIds] : [...taskIds];
    const host = ids[0];
    this.close();
    if (host === undefined) return;
    // 同じ行で開き直すときは、前の候補のフェードを待たずに入れ替える（1つの行に描けるのは1つだけ）
    if (this.leaving?.taskId === host) this.leaving = null;
    this.session = { id: this.#nextId++, taskId: host, taskIds: ids, anchor };
    this.#syncHosts();
  }

  /** 閉じる（消えるときのフェードのあいだは描き続ける） */
  close(): void {
    if (this.session) this.leaving = this.session;
    this.session = null;
    this.#syncHosts();
  }

  /** フェードなしで閉じる（行や画面ごと消えるとき） */
  dismiss(): void {
    this.session = null;
    this.leaving = null;
    this.#syncHosts();
  }

  /** id の候補の、消えるときのフェードが終わった（描くのをやめる） */
  left(id: number): void {
    if (this.leaving?.id !== id) return;
    this.leaving = null;
    this.#syncHosts();
  }

  #syncHosts(): void {
    const hosts = new Set<string>();
    for (const session of [this.session, this.leaving]) {
      if (session) hosts.add(session.taskId);
    }
    for (const id of [...this.#hosts.keys()]) if (!hosts.has(id)) this.#hosts.delete(id);
    for (const id of hosts) if (!this.#hosts.has(id)) this.#hosts.set(id, true);
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

const popup = defer(() => import("./picker-popup"));

/** 候補の入力欄の読み上げ名と、何も打っていないときの案内（待ちの欄と同じにする） */
export const PICKER_LABEL = "プロジェクト";

export function pickerPlaceholder(taskIds: readonly string[]): string {
  return taskIds.length > 1 ? `${taskIds.length}件のプロジェクト` : "プロジェクト名";
}

/**
 * 行の右側の枠に置く。そのタスクの候補を開いているとき（と、閉じる途中）だけ描く。
 * ほかの行は自分の「描くか」だけを観測するので、候補を開いても描き直さない。
 * 候補が届く前は、待ちの欄がキーを受け止め、打った文字は届いたら候補の入力欄へ移す
 */
export const ProjectPickerHost = observer(function ProjectPickerHost({ task }: { task: TaskRow }) {
  const ui = useUi();
  const picker = projectPickerOf(ui);
  const session = picker.isHost(task.id)
    ? ([picker.session, picker.leaving].find((candidate) => candidate?.taskId === task.id) ?? null)
    : null;
  // 届く前に打った文字（候補を開くたびに）
  const [typed, setTyped] = useState<{ id: number; text: string } | null>(null);
  const { module, failed, retry } = useDeferred(popup, session !== null, session?.id);
  if (session === null) return null;
  const text = typed?.id === session.id ? typed.text : "";
  if (module) {
    return (
      <module.ProjectPickerPopup
        key={session.id}
        task={task}
        picker={picker}
        session={session}
        initialQuery={text}
      />
    );
  }
  // 閉じる途中の候補は、届いていなければ描かない
  if (picker.session?.id !== session.id) return null;
  return (
    <PickerWaiting
      key={session.id}
      session={session}
      text={text}
      onText={(next) => setTyped({ id: session.id, text: next })}
      failed={failed}
      onRetry={retry}
      onCancel={() => {
        picker.close();
        const { anchor } = session;
        if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
        else ui.focusList();
      }}
    />
  );
});

/** 候補が届くまでの待ちの欄。行（右の端をそろえる）か、押したボタン（左の端をそろえる）の下に出す */
function PickerWaiting({
  session,
  text,
  onText,
  failed,
  onRetry,
  onCancel,
}: {
  session: PickerSession;
  text: string;
  onText: (text: string) => void;
  failed: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const style = useAnchoredStyle(
    session.anchor ?? document.getElementById(taskRowId(session.taskId)),
    session.anchor ? "start" : "end",
  );
  return (
    <WaitingInput
      label={PICKER_LABEL}
      placeholder={pickerPlaceholder(session.taskIds)}
      value={text}
      onChange={onText}
      onCancel={onCancel}
      failed={failed}
      onRetry={onRetry}
      className="w-64"
      style={style}
    />
  );
}
