import { action, makeObservable, observable, observableRef, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { type ComponentType, useEffect, useState } from "react";
import { useAnchoredStyle, WaitingInput } from "@/components/waiting-input";
import type { TaskRow } from "@/data";
import { type Deferred, useDeferred } from "@/lib/deferred";
import type { ListUi } from "./list-ui";
import { taskRowId } from "./task-item";
import { useUi } from "./ui-context";

/**
 * 行から広がる小さな候補（p のプロジェクト、⇧P の優先度、e の工数）の開閉の状態。候補の部品そのものは、
 * それぞれの機能が後から読み込む。候補は、対象のタスクの行の右側の枠から描き、行（キーのとき）か押したボタンから広がる。
 * 小さな詳細（tasks/task-detail-popover.tsx）の中のボタンから開いたときは detached にし、小さな詳細が自分の中に描く
 * （一覧に行がなくてよい）。描く枠は RowPickerHost
 */

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
  /** 小さな詳細の中から開いた（行ではなく小さな詳細が描く） */
  detached: boolean;
};

/**
 * 候補を開いているタスクと、広げる元。一覧の状態（ListUi）ごと、候補の種類ごとに1つ。
 * 複数のタスクにかけるとき（7 の複数選択）は、候補を1回だけ開き、決めたものをすべてに付ける。
 * 候補は先頭のタスク（taskId）の行から広がる。閉じたときは、消えるときのフェード（150ms）が終わるまで描き続ける（leaving）。
 * 画面が変わったときと、そのタスクが一覧からなくなったとき（同期・ほかのタブ）は、フェードなしで閉じる
 * （候補の部品は行と一緒に消えるので、閉じたことを自分では知らせられない）。
 * 小さな詳細から開いた候補（detached）は一覧の行と関係がないので、どちらでも閉じない（小さな詳細と一緒に消える）
 */
export class RowPicker {
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
      dismissDetached: action,
      left: action,
    });
    reaction(
      () => ui.view,
      () => {
        if (!this.session?.detached) this.dismiss();
      },
    );
    reaction(
      () => {
        const session = this.session;
        return (
          session !== null && !session.detached && !ui.rows.some((row) => row.id === session.taskId)
        );
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

  /** この行で描く候補（開いているか、閉じる途中のもの。detached は小さな詳細の中の枠） */
  sessionOf(taskId: string, detached = false): PickerSession | null {
    if (!this.isHost(taskId)) return null;
    return (
      [this.session, this.leaving].find(
        (candidate) => candidate?.taskId === taskId && candidate.detached === detached,
      ) ?? null
    );
  }

  /**
   * 候補を開く。taskIds は1つの id か、上から見えている順の id の列。
   * detached は小さな詳細の中から開いたとき
   */
  open(taskIds: string | readonly string[], anchor: Element | null = null, detached = false): void {
    const ids = typeof taskIds === "string" ? [taskIds] : [...taskIds];
    const host = ids[0];
    this.close();
    if (host === undefined) return;
    // 同じ行で開き直すときは、前の候補のフェードを待たずに入れ替える（1つの行に描けるのは1つだけ）
    if (this.leaving?.taskId === host) this.leaving = null;
    this.session = { id: this.#nextId++, taskId: host, taskIds: ids, anchor, detached };
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

  /**
   * 小さな詳細から開いたそのタスクの候補を、フェードなしで閉じる（小さな詳細が閉じて、描く枠ごと消えたとき。
   * 残しておくと、次にそのタスクの小さな詳細を開いたときに候補まで開いてしまう）
   */
  dismissDetached(taskId: string): void {
    if (this.session?.detached && this.session.taskId === taskId) this.session = null;
    if (this.leaving?.detached && this.leaving.taskId === taskId) this.leaving = null;
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

/** 後から読み込む候補の部品に渡すもの */
export type PickerPopupProps = {
  task: TaskRow;
  picker: RowPicker;
  session: PickerSession;
  /** 開いたときの入力欄の文字（読み込みを待つあいだに打った文字） */
  initialQuery: string;
};

/**
 * 行の右側の枠に置く。そのタスクの候補を開いているとき（と、閉じる途中）だけ描く。
 * 小さな詳細は detached を付けて自分の中に置き、小さな詳細から開いた候補だけを描く。
 * ほかの行は自分の「描くか」だけを観測するので、候補を開いても描き直さない。
 * 候補の部品（popup）は後から読み込む。届く前は、待ちの欄がキーを受け止め、打った文字は届いたら候補の入力欄へ移す
 */
export const RowPickerHost = observer(function RowPickerHost({
  task,
  picker,
  popup,
  label,
  placeholder,
  detached = false,
}: {
  task: TaskRow;
  picker: RowPicker;
  popup: Deferred<ComponentType<PickerPopupProps>>;
  /** 待ちの欄の読み上げ名（候補の入力欄と同じにする） */
  label: string;
  /** 待ちの欄の、何も打っていないときの案内（候補の入力欄と同じにする） */
  placeholder: (taskIds: readonly string[]) => string;
  /** 小さな詳細の中に置いた枠（小さな詳細から開いた候補だけを描く） */
  detached?: boolean;
}) {
  const ui = useUi();
  const session = picker.sessionOf(task.id, detached);
  // 届く前に打った文字（候補を開くたびに）
  const [typed, setTyped] = useState<{ id: number; text: string } | null>(null);
  const { module: Popup, failed, retry } = useDeferred(popup, session !== null, session?.id);
  // 小さな詳細の中の枠は、小さな詳細と一緒に消える。そのとき開いていた候補も閉じる
  useEffect(() => {
    if (!detached) return;
    return () => picker.dismissDetached(task.id);
  }, [picker, task.id, detached]);
  if (session === null) return null;
  const text = typed?.id === session.id ? typed.text : "";
  if (Popup) {
    return (
      <Popup key={session.id} task={task} picker={picker} session={session} initialQuery={text} />
    );
  }
  // 閉じる途中の候補は、届いていなければ描かない
  if (picker.session?.id !== session.id) return null;
  return (
    <PickerWaiting
      key={session.id}
      session={session}
      label={label}
      placeholder={placeholder(session.taskIds)}
      text={text}
      onText={(next) => setTyped({ id: session.id, text: next })}
      failed={failed}
      onRetry={retry}
      onCancel={() => {
        picker.close();
        const { anchor } = session;
        if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
        else if (!session.detached) ui.focusList();
      }}
    />
  );
});

/** 候補が届くまでの待ちの欄。行（右の端をそろえる）か、押したボタン（左の端をそろえる）の下に出す */
function PickerWaiting({
  session,
  label,
  placeholder,
  text,
  onText,
  failed,
  onRetry,
  onCancel,
}: {
  session: PickerSession;
  label: string;
  placeholder: string;
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
      label={label}
      placeholder={placeholder}
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
