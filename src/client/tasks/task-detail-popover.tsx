import { action, makeObservable, observableRef, reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useMemo, useRef } from "react";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import type { TaskRow } from "@/data";
import { toggleComplete } from "./commands";
import { CompleteButton } from "./complete-button";
import { type DetailSurface, DetailSurfaceProvider } from "./detail-surface";
import { detachedHostsList } from "./extensions";
import type { ListUi, ListView } from "./list-ui";
import { TaskDetailFields, TitleInput } from "./task-detail";
import { useUi } from "./ui-context";

/**
 * 小さな詳細：カレンダーとタイムラインでタスクを押したときに、その場に開くポップオーバーの中の詳細（13・14 がつなぐ）。
 * 中身はリストで開く詳細（task-detail.tsx）と同じ：一番上に完了の丸とタイトル、その下にメモ・チェックリスト・
 * 小さなボタンの列（状態・いつやる・締切・プロジェクト）。どれもその場で直せて、保存と ⌘Z の決まりもリストと同じ。
 *
 * 使い方（画面の側）：
 * - 画面に `<TaskDetailPopoverHost />` を1つ置く（画面が消えると、開いていた小さな詳細も閉じる）
 * - タスクを押したら `taskDetailPopoverOf(ui).open(task.id, event.currentTarget)`（ui は useUi()）。
 *   押した要素から広がり、Esc で閉じて押した要素へフォーカスを戻す。外を押すと閉じる（フォーカスは押した先に任せる）
 * - 閉じるだけなら `taskDetailPopoverOf(ui).close()`。押した要素が画面から消える（日付を変えて別のマスへ移るなど）ときは、
 *   開き直す（新しい要素で open）か閉じる
 *
 * 決まり：
 * - 開いているのは一度に1つ。別のタスクを open すると入れ替わる
 * - 中にいるあいだはアプリの1文字のキーを止める（`data-keymap="off"`。選んでいる行へ x などが効かないように）
 * - 欄から開く日付の入力と p の候補は、小さな詳細の中に描く（extensions.ts の registerDetachedHost）
 * - タスクが削除されたら（ほかのタブを含む）閉じる。新しいバージョンへ読み込み直すとき（editingLocked）も閉じる
 * - 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする
 */

export type TaskDetailPopoverRequest = {
  /** 開くたびに変わる番号 */
  id: number;
  taskId: string;
  /** 押した要素（ここから広がり、Esc で閉じたらここへフォーカスを戻す） */
  anchor: Element;
};

/** 小さな詳細の開閉の状態。一覧の状態（ListUi）ごとに1つ */
export class TaskDetailPopoverState {
  /** 開いている小さな詳細 */
  request: TaskDetailPopoverRequest | null = null;
  /** 閉じる途中の小さな詳細（消えるときのフェードのあいだだけ描く） */
  leaving: TaskDetailPopoverRequest | null = null;
  readonly #ui: ListUi;
  #nextId = 1;

  constructor(ui: ListUi) {
    this.#ui = ui;
    makeObservable(this, {
      request: observableRef,
      leaving: observableRef,
      open: action,
      close: action,
      dismiss: action,
      left: action,
    });
    // 新しいバージョンへ読み込み直すまで編集を止めるときは、閉じる（打った文字は閉じるときに下書きへ残る）
    reaction(
      () => ui.editingLocked,
      (locked) => {
        if (locked) this.dismiss();
      },
    );
  }

  /** そのタスクの小さな詳細を、anchor（押した要素）から開く。開いていたものとは入れ替わる */
  open(taskId: string, anchor: Element): void {
    if (this.#ui.editingLocked) return;
    this.leaving = null;
    this.request = { id: this.#nextId++, taskId, anchor };
  }

  /** 閉じる（消えるときのフェードのあいだは描き続ける）。id を渡すと、それが開いているときだけ閉じる */
  close(id?: number): void {
    if (!this.request || (id !== undefined && this.request.id !== id)) return;
    this.leaving = this.request;
    this.request = null;
  }

  /** フェードなしで閉じる（画面ごと消えるとき・タスクが消えたとき） */
  dismiss(): void {
    this.request = null;
    this.leaving = null;
  }

  /** id の小さな詳細の、消えるときのフェードが終わった（描くのをやめる） */
  left(id: number): void {
    if (this.leaving?.id === id) this.leaving = null;
  }

  /** 開いているか（taskId を渡すと、そのタスクの小さな詳細が開いているか） */
  isOpen(taskId?: string): boolean {
    return this.request !== null && (taskId === undefined || this.request.taskId === taskId);
  }
}

const states = new WeakMap<ListUi, TaskDetailPopoverState>();

/** 一覧の状態ごとの小さな詳細 */
export function taskDetailPopoverOf(ui: ListUi): TaskDetailPopoverState {
  let state = states.get(ui);
  if (!state) {
    state = new TaskDetailPopoverState(ui);
    states.set(ui, state);
  }
  return state;
}

/**
 * 小さな詳細を描く枠。画面に1つ置く。開いている小さな詳細を先に、なければ閉じる途中のものを描く。
 * view は欄に渡す画面（一覧の画面の外なら省略してよい）
 */
export const TaskDetailPopoverHost = observer(function TaskDetailPopoverHost({
  view = null,
}: {
  view?: ListView | null;
}) {
  const ui = useUi();
  const state = taskDetailPopoverOf(ui);
  // 画面ごと消えたら（ほかの画面へ移ったら）、フェードなしで閉じる
  useEffect(() => () => state.dismiss(), [state]);
  const shown = state.request ?? state.leaving;
  const task = shown === null ? undefined : ui.store.task(shown.taskId);
  const gone = shown !== null && (task === undefined || task.deletedAt !== null);
  // タスクが削除された（ほかのタブを含む）ら閉じる
  useEffect(() => {
    if (gone) state.dismiss();
  }, [state, gone]);
  if (shown === null || task === undefined || gone) return null;
  return (
    <TaskDetailPopup
      key={shown.id}
      request={shown}
      task={task}
      open={state.request?.id === shown.id}
      view={view}
    />
  );
});

/** 押した要素へフォーカスを戻す（画面から消えていたら何もしない） */
function focusAnchor(anchor: Element): void {
  if (anchor instanceof HTMLElement && anchor.isConnected) anchor.focus();
}

/** 小さな詳細のタイトルの入力欄の id（同じタスクのリストの行の入力欄と重ならないように分ける） */
export function popoverTitleInputId(taskId: string): string {
  return `task-detail-popover-title-${taskId}`;
}

const TaskDetailPopup = observer(function TaskDetailPopup({
  request,
  task,
  open,
  view,
}: {
  request: TaskDetailPopoverRequest;
  task: TaskRow;
  /** false なら閉じる途中（消えるときのフェードのあいだ） */
  open: boolean;
  view: ListView | null;
}) {
  const ui = useUi();
  const state = taskDetailPopoverOf(ui);
  const body = useRef<HTMLDivElement>(null);
  // 入力欄の Esc・タイトルの Enter でも、ここで閉じて押した要素へ戻る
  const surface = useMemo<DetailSurface>(
    () => ({
      detached: true,
      close: () => {
        state.close(request.id);
        focusAnchor(request.anchor);
      },
    }),
    [state, request],
  );
  const done = task.completedAt !== null;

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next || !open) return;
        // Esc は押した要素へ戻す。外を押したときは、押した先にフォーカスを任せる
        if (details.reason === "escape-key") surface.close();
        else state.close(request.id);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) state.left(request.id);
      }}
    >
      <PopoverPopup
        anchor={request.anchor}
        side="bottom"
        align="start"
        aria-label={`「${task.title}」の詳細`}
        // 中ではアプリの1文字のキーを止める（選んでいる行へ x などが効かないように）
        data-keymap="off"
        // 開いたら枠そのものにフォーカスを置く（Tab でタイトルへ。打った文字でいきなりタイトルを変えないように）
        initialFocus={body}
        finalFocus={false}
        // 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="w-[22rem] duration-(--duration-short) data-starting-style:scale-95 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <DetailSurfaceProvider value={surface}>
          <div ref={body} tabIndex={-1} className="flex flex-col gap-3 outline-none">
            <div className="flex items-center gap-3 text-sm">
              <CompleteButton
                taskId={task.id}
                done={done}
                inProgress={task.isInProgress}
                title={task.title}
                onToggle={() => toggleComplete(ui, [task.id])}
              />
              <TitleInput task={task} id={popoverTitleInputId(task.id)} />
            </div>
            <TaskDetailFields task={task} view={view} />
          </div>
          {detachedHostsList().map(({ id, Component }) => (
            <Component key={id} task={task} />
          ))}
        </DetailSurfaceProvider>
      </PopoverPopup>
    </Popover>
  );
});
