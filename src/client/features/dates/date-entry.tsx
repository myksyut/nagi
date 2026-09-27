import { action, makeObservable, observable, observableRef } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { useAnchoredStyle, WaitingInput } from "@/components/waiting-input";
import type { TaskRow } from "@/data";
import { defer, useDeferred } from "@/lib/deferred";
import type { ListUi, ListView } from "@/tasks/list-ui";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";

/**
 * 日付の入力（d と ⇧D で共通）の開閉の状態と、それを描く枠。入力そのもの（カレンダーを含む）は
 * date-entry-panel.tsx にあり、起動に要らないので後から読み込む（DayPicker と date-fns を最初の JS から外す）。
 *
 * 開いているかどうかは一覧の状態（ListUi）ごとに1つだけ持つ。ポップオーバーは、開いた画面の中の、対象のタスク
 * （複数なら先頭）の行の右側の枠（register.tsx の締切の表示）が描く。行に合わせて開き、小さなボタンから開いたときは
 * ボタンに合わせる。閉じたときは、消えるときのフェード（150ms）が終わるまで描き続ける（leaving）。
 * 対象の行が一覧から消えたとき（同期・完了・振り分け）や画面を切り替えたときは、フェードなしで閉じて、
 * 一覧にフォーカスを戻す（あとで同じ行が出てきても、前の入力を開き直さない）。
 *
 * 小さな詳細（tasks/task-detail-popover.tsx）の中の小さなボタンから開いたときは detached にする。そのときは
 * 行ではなく小さな詳細が描き（一覧に行がなくてよい）、閉じたら押したボタンへフォーカスを戻す
 */

export type DateEntryKind = "schedule" | "deadline";

export type DateEntryRequest = {
  /** 開くたびに変わる番号（入力欄の中身を開くたびに空から始めるため） */
  id: number;
  kind: DateEntryKind;
  taskIds: readonly string[];
  /**
   * 開いた画面。ほかの画面に同じタスクの行があっても、そこには描かない。
   * 小さな詳細から開いたとき（detached）は使わない（null のことがある）
   */
  view: ListView | null;
  /** ポップオーバーを合わせる要素。null なら対象の行 */
  anchor: Element | null;
  /** 小さな詳細の中から開いた（行ではなく小さな詳細が描く） */
  detached: boolean;
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

  /** 開く。detached は小さな詳細の中から開いたとき（そのときは view が null でもよい） */
  open(
    kind: DateEntryKind,
    taskIds: readonly string[],
    view: ListView | null,
    anchor: Element | null = null,
    detached = false,
  ): void {
    const host = taskIds[0];
    this.close();
    if (host === undefined || (view === null && !detached)) return;
    // 同じ行で開き直すときは、前の入力のフェードを待たずに入れ替える（1つの行に描けるのは1つだけ）
    if (this.leaving?.taskIds[0] === host) this.leaving = null;
    this.request = { id: this.#nextId++, kind, taskIds: [...taskIds], view, anchor, detached };
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

/**
 * 閉じたあとのフォーカスの戻し先。小さな詳細から開いたときは押したボタン（消えていたら何もしない）、
 * 一覧の行から開いたときは一覧（キーの操作を続けられるように）
 */
export function returnFocusAfterDateEntry(ui: ListUi, request: DateEntryRequest): void {
  if (!request.detached) {
    ui.focusList();
    return;
  }
  const { anchor } = request;
  if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
}

/** 入力欄の読み上げ名 */
export function dateEntryLabel(kind: DateEntryKind): string {
  return kind === "schedule" ? "予定の日付" : "締切";
}

export function dateEntryPlaceholder(kind: DateEntryKind): string {
  return kind === "schedule" ? "明日、金曜、10/3 など" : "締切（金曜、10/3 など）";
}

/**
 * 入力の後始末：対象の行が今の画面の一覧から消えたら閉じる。行ごと外れた（画面の切り替え、抜けていく動きの終わり）
 * ときも閉じる。どちらも一覧にフォーカスを戻す（ポップオーバーの入力欄にあったフォーカスが行き場を失うため）。
 * 外れたかどうかは、StrictMode の付け直しと区別するため、外れた直後の microtask で確かめる。
 * 行の枠（DateEntryPopover）で使う（待ちの欄から本物の入力へ替わるときに閉じないように）。
 * 小さな詳細の中（detached）では、小さな詳細ごと閉じたときだけ閉じ、フォーカスは小さな詳細の閉じ方に任せる
 */
function useDismissWhenGone(requestId: number | null, inList: boolean, detached: boolean) {
  const ui = useUi();
  const mounted = useRef(false);
  useEffect(() => {
    if (requestId !== null && !inList && dateEntryOf(ui).dismiss(requestId)) ui.focusList();
  }, [ui, requestId, inList]);
  useEffect(() => {
    if (requestId === null) return;
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && dateEntryOf(ui).dismiss(requestId) && !detached) ui.focusList();
      });
    };
  }, [ui, requestId, detached]);
}

const panel = defer(() => import("./date-entry-panel"));

/**
 * 行の右側の枠から描く。開いていないとき・開いた画面の行でないときは何も描かない。
 * 小さな詳細は detached を付けて自分の中に置き、小さな詳細から開いた入力だけを描く（一覧に行がなくてよい）。
 * 開いている入力を先に、なければ閉じる途中の入力を描く。
 * 入力（カレンダーを含む）が届く前は、待ちの欄がキーを受け止め、打った文字は届いたら入力欄へ移す
 */
export const DateEntryPopover = observer(function DateEntryPopover({
  task,
  view,
  detached = false,
}: {
  task: TaskRow;
  view: ListView | null;
  /** 小さな詳細の中に置いた枠（小さな詳細から開いた入力だけを描く） */
  detached?: boolean;
}) {
  const ui = useUi();
  const entry = dateEntryOf(ui);
  const shown =
    [entry.request, entry.leaving].find(
      (request) =>
        request !== null &&
        request.taskIds[0] === task.id &&
        (detached ? request.detached : !request.detached && request.view === view),
    ) ?? null;
  const inList =
    shown !== null &&
    (detached || (ui.view === shown.view && ui.rows.some((row) => row.id === task.id)));
  useDismissWhenGone(shown?.id ?? null, inList, detached);
  // 届く前に打った文字（入力ごと）
  const [typed, setTyped] = useState<{ id: number; text: string } | null>(null);
  const { module, failed, retry } = useDeferred(panel, shown !== null, shown?.id);
  if (shown === null) return null;
  const text = typed?.id === shown.id ? typed.text : "";
  // 行が一覧から消えた（抜けていく動きのあいだも）ら描かない。閉じるのは useDismissWhenGone
  if (!inList) return null;
  if (module) {
    return <module.DateEntryPanel key={shown.id} request={shown} task={task} initialText={text} />;
  }
  // 閉じる途中の入力は、届いていなければ描かない
  if (entry.request?.id !== shown.id) return null;
  return (
    <DateEntryWaiting
      key={shown.id}
      request={shown}
      task={task}
      text={text}
      onText={(next) => setTyped({ id: shown.id, text: next })}
      failed={failed}
      onRetry={retry}
    />
  );
});

/** 日付の入力が届くまでの待ちの欄。対象の行（かボタン）の下に出す */
const DateEntryWaiting = observer(function DateEntryWaiting({
  request,
  task,
  text,
  onText,
  failed,
  onRetry,
}: {
  request: DateEntryRequest;
  task: TaskRow;
  text: string;
  onText: (text: string) => void;
  failed: boolean;
  onRetry: () => void;
}) {
  const ui = useUi();
  const style = useAnchoredStyle(
    request.anchor ?? document.getElementById(taskRowId(task.id)),
    "start",
  );
  return (
    <WaitingInput
      label={dateEntryLabel(request.kind)}
      placeholder={dateEntryPlaceholder(request.kind)}
      value={text}
      onChange={onText}
      onCancel={() => {
        dateEntryOf(ui).close();
        returnFocusAfterDateEntry(ui, request);
      }}
      failed={failed}
      onRetry={onRetry}
      className="w-[17.5rem]"
      style={style}
    />
  );
});
