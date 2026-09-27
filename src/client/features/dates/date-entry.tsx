import { action, makeObservable, observable, observableRef } from "mobx";
import { observer } from "mobx-react-lite";
import type { TaskRow } from "@/data";
import { defer, useDeferred } from "@/lib/deferred";
import type { ListUi, ListView } from "@/tasks/list-ui";
import { useUi } from "@/tasks/ui-context";

/**
 * 日付の入力（d と ⇧D で共通）の開閉の状態と、それを描く枠。入力そのもの（カレンダーを含む）は
 * date-entry-panel.tsx にあり、起動に要らないので後から読み込む（DayPicker と date-fns を最初の JS から外す）。
 *
 * 開いているかどうかは一覧の状態（ListUi）ごとに1つだけ持つ。ポップオーバーは、開いた画面の中の、対象のタスク
 * （複数なら先頭）の行の右側の枠（register.tsx の締切の表示）が描く。行に合わせて開き、小さなボタンから開いたときは
 * ボタンに合わせる。閉じたときは、消えるときのフェード（150ms）が終わるまで描き続ける（leaving）。
 * 対象の行が一覧から消えたとき（同期・完了・振り分け）や画面を切り替えたときは、フェードなしで閉じて、
 * 一覧にフォーカスを戻す（あとで同じ行が出てきても、前の入力を開き直さない）
 */

export type DateEntryKind = "schedule" | "deadline";

export type DateEntryRequest = {
  /** 開くたびに変わる番号（入力欄の中身を開くたびに空から始めるため） */
  id: number;
  kind: DateEntryKind;
  taskIds: readonly string[];
  /** 開いた画面。ほかの画面に同じタスクの行があっても、そこには描かない */
  view: ListView;
  /** ポップオーバーを合わせる要素。null なら対象の行 */
  anchor: Element | null;
};

export class DateEntry {
  /** 開いている入力 */
  request: DateEntryRequest | null = null;
  /** 閉じる途中の入力（消えるときのフェードのあいだだけ描く） */
  leaving: DateEntryRequest | null = null;
  /** ポップオーバーを描く行（行ごとに自分の id だけを観測する） */
  readonly #hosts = observable.map<string, true>();
  #nextId = 1;

  constructor() {
    makeObservable(this, {
      request: observableRef,
      leaving: observableRef,
      open: action,
      close: action,
      dismiss: action,
      left: action,
    });
  }

  open(
    kind: DateEntryKind,
    taskIds: readonly string[],
    view: ListView | null,
    anchor: Element | null = null,
  ): void {
    const host = taskIds[0];
    this.close();
    if (host === undefined || view === null) return;
    this.request = { id: this.#nextId++, kind, taskIds: [...taskIds], view, anchor };
    this.#syncHosts();
  }

  /** 閉じる（消えるときのフェードのあいだは描き続ける） */
  close(): void {
    if (this.request) this.leaving = this.request;
    this.request = null;
    this.#syncHosts();
  }

  /** 開いているのが id の入力なら、フェードなしで閉じる（もう次の入力を開いていたら何もしない）。閉じたら true */
  dismiss(id: number): boolean {
    this.left(id);
    if (this.request?.id !== id) return false;
    this.request = null;
    this.#syncHosts();
    return true;
  }

  /** id の入力の、消えるときのフェードが終わった（描くのをやめる） */
  left(id: number): void {
    if (this.leaving?.id !== id) return;
    this.leaving = null;
    this.#syncHosts();
  }

  /** この行がポップオーバーを描くか */
  isHost(taskId: string): boolean {
    return this.#hosts.has(taskId);
  }

  #syncHosts(): void {
    const hosts = new Set<string>();
    for (const request of [this.request, this.leaving]) {
      const host = request?.taskIds[0];
      if (host !== undefined) hosts.add(host);
    }
    for (const id of [...this.#hosts.keys()]) if (!hosts.has(id)) this.#hosts.delete(id);
    for (const id of hosts) if (!this.#hosts.has(id)) this.#hosts.set(id, true);
  }
}

const entries = new WeakMap<ListUi, DateEntry>();

/** 一覧の状態ごとの日付の入力 */
export function dateEntryOf(ui: ListUi): DateEntry {
  let entry = entries.get(ui);
  if (!entry) {
    entry = new DateEntry();
    entries.set(ui, entry);
  }
  return entry;
}

const panel = defer(() => import("./date-entry-panel"));

/**
 * 行の右側の枠から描く。開いていないとき・開いた画面の行でないときは何も描かない。
 * 開いている入力を先に、なければ閉じる途中の入力を描く
 */
export const DateEntryPopover = observer(function DateEntryPopover({
  task,
  view,
}: {
  task: TaskRow;
  view: ListView;
}) {
  const entry = dateEntryOf(useUi());
  const shown =
    [entry.request, entry.leaving].find(
      (request) => request !== null && request.taskIds[0] === task.id && request.view === view,
    ) ?? null;
  const module = useDeferred(panel, shown !== null);
  if (shown === null || module === undefined) return null;
  return <module.DateEntryPanel key={shown.id} request={shown} task={task} />;
});
