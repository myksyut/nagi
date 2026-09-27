import { action, computed, makeObservable, observable, observableRef } from "mobx";
import { registerKeyBindings } from "@/keyboard/keymap";
import { ADD_BUTTON_ELEMENT_ID, QUICK_ADD_BINDING_ID } from "@/shell/add-button";
import type { ListUi } from "@/tasks/list-ui";

/**
 * 小さな追加欄（カレンダーとタイムライン）の開閉の状態（一覧の状態（ListUi）ごとに1つ）と、n の割り当て。
 * 使うのは後から読み込む画面だけなので、このモジュールも起動の道筋から import しない（起動に要る JS を増やさない）。
 * 割り当ては、このモジュールが読み込まれたとき（起動のあとの空いた時間の先読み）に登録する。
 * 使い方は README の「小さな追加欄」
 */

/**
 * 追加の行き先
 * - choice：「受信箱｜今日」から選ぶ（開くたびに受信箱から始まる）。右下の「＋」と n
 * - date：その日の予定として追加する（今日か過去なら今日へ）。カレンダーの日のマスの「＋」
 */
export type QuickAddTarget = { kind: "choice" } | { kind: "date"; on: string };

export type QuickAddRequest = {
  /** 開くたびに変わる番号 */
  id: number;
  target: QuickAddTarget;
  /** 欄を合わせる要素。null なら右下の「＋」の上 */
  anchor: Element | null;
  /** Esc で閉じたときにフォーカスを戻す要素。null なら右下の「＋」 */
  returnFocus: Element | null;
};

export class QuickAddState {
  /** 開いている欄 */
  request: QuickAddRequest | null = null;
  /** 閉じる途中の欄（消えるときのフェードのあいだだけ描く） */
  leaving: QuickAddRequest | null = null;
  /** 欄を描ける画面（QuickAddHost）が出ている数 */
  hosts = 0;
  readonly #ui: ListUi;
  #nextId = 1;

  constructor(ui: ListUi) {
    this.#ui = ui;
    makeObservable<QuickAddState>(this, {
      request: observableRef,
      leaving: observableRef,
      hosts: observable,
      available: computed,
      open: action,
      toggleFromFab: action,
      close: action,
      dismiss: action,
      left: action,
      addHost: action,
      removeHost: action,
    });
  }

  /** 欄を描ける画面が出ているか（n と右下の「＋」がこの欄につながるか） */
  get available(): boolean {
    return this.hosts > 0;
  }

  /**
   * 開く（開いていたものとは入れ替わる）。anchor の下に開き（null なら右下の「＋」の上）、Esc で閉じたら returnFocus へ戻す。
   * 新しいバージョンへ読み込み直すまで（editingLocked）は開かない
   */
  open(
    target: QuickAddTarget,
    anchor: Element | null = null,
    returnFocus: Element | null = anchor,
  ): void {
    if (!this.available || this.#ui.editingLocked) return;
    this.leaving = null;
    this.request = { id: this.#nextId++, target, anchor, returnFocus };
  }

  /**
   * 右下の「＋」と n：「＋」の上に「受信箱｜今日」から選ぶ欄を開く。Esc で閉じたら returnFocus（開く前にフォーカスのあった要素。
   * なければ「＋」）へ戻す。すでに開いていれば閉じて true を返す
   * （「＋」を押すたびに開閉する。欄の外を押すと閉じるが、「＋」を押したときは欄が閉じずにここへ来る）
   */
  toggleFromFab(returnFocus: Element | null = null): boolean {
    if (this.request?.anchor === null) {
      this.close();
      return true;
    }
    this.open({ kind: "choice" }, null, returnFocus);
    return false;
  }

  /** 閉じる（消えるときのフェードのあいだは描き続ける）。id を渡すと、それが開いているときだけ閉じる */
  close(id?: number): void {
    const request = this.request;
    if (!request || (id !== undefined && request.id !== id)) return;
    this.leaving = request;
    this.request = null;
  }

  /** フェードなしで閉じる（画面ごと消えたとき） */
  dismiss(): void {
    this.request = null;
    this.leaving = null;
  }

  /** id の欄の、消えるときのフェードが終わった（描くのをやめる） */
  left(id: number): void {
    if (this.leaving?.id === id) this.leaving = null;
  }

  addHost(): void {
    this.hosts += 1;
  }

  removeHost(): void {
    this.hosts = Math.max(0, this.hosts - 1);
    if (this.hosts === 0) this.dismiss();
  }
}

const states = new WeakMap<ListUi, QuickAddState>();

/** 一覧の状態ごとの小さな追加欄 */
export function quickAddOf(ui: ListUi): QuickAddState {
  let state = states.get(ui);
  if (!state) {
    state = new QuickAddState(ui);
    states.set(ui, state);
  }
  return state;
}

/** 小さな追加欄を置いている画面（QuickAddHost を置く画面を足したら、ここも直す） */
export const QUICK_ADD_SCREENS = "カレンダー・タイムライン・ショートカット";

/**
 * 小さな追加欄の n。一覧の追加欄（features/core の `task.add`。一覧の画面があるときだけ効く）が使えず、
 * 小さな追加欄を描ける画面（QuickAddHost を置いたカレンダー・タイムライン・ショートカットのページ）が出ているときだけ効く。
 * 右下の「＋」も、`task.add` が使えないときはこれを呼ぶ（shell/add-button.tsx）
 */
registerKeyBindings({
  id: QUICK_ADD_BINDING_ID,
  label: "追加",
  group: "タスク",
  keys: ["n"],
  // ショートカットのページで一覧の画面の「追加」と並ぶので、どこで効くかを添える
  where: QUICK_ADD_SCREENS,
  // 一覧の画面の n（task.add）とは同時に効かない（こちらは一覧の画面がないときだけ）
  scope: "quick-add",
  when: ({ ui }) => ui.view === null && quickAddOf(ui).available,
  run: ({ ui }) => {
    // 開く前にフォーカスのあった要素（Tab で移ったタスクなど）へ、Esc で閉じたら戻す。
    // 右下の「＋」は押してもフォーカスを奪わないので、押したときも同じ
    const active = document.activeElement;
    const closed = quickAddOf(ui).toggleFromFab(
      active instanceof HTMLElement && active !== document.body ? active : null,
    );
    // 「＋」を押して閉じたら、「＋」にフォーカスを置く（欄の中にあったフォーカスの行き場をなくさない）
    if (closed) document.getElementById(ADD_BUTTON_ELEMENT_ID)?.focus();
  },
});
