import { action, makeObservable, observable, reaction } from "mobx";
import type { ListUi } from "@/tasks/list-ui";

/**
 * サイドバーを畳んでいるか（アイコンだけの細い帯。チケット20）。一覧の状態（ListUi）ごとに1つ。
 * その端末のブラウザに覚える（localStorage。残せないときは、そのタブのあいだだけ覚える）。
 * 見た目は `<html data-sidebar="rail">` を見て CSS が決める（--sidebar-width が帯の幅に替わり、本文の左の余白・
 * 上部の帯・トーストの位置も付いてくる。帯で隠す部品は styles.css の rail の書き方）。
 * index.html の小さなスクリプトも同じ値を読み、JavaScript が届く前の外枠から帯の幅で描く
 */

/** 覚えておく場所（index.html のスクリプトも同じ名前を読む） */
export const SIDEBAR_STORAGE_KEY = "nagi:sidebar";

/** 畳んでいるときの値（localStorage と `<html>` の data-sidebar に同じ値を入れる） */
const RAIL = "rail";

/** ⌘\・⌘K・サイドバーの一番下のボタンが呼ぶ割り当て（features/sidebar/register.ts） */
export const SIDEBAR_TOGGLE_BINDING_ID = "sidebar.toggle";

/**
 * 帯では見せない部品（プロジェクトの ＋ と名前の欄。create-field.tsx が data-sidebar-full-only を付ける）。
 * 畳むとき、ここにフォーカスがあれば一覧へ移す
 */
const FULL_ONLY_SELECTOR = "[data-sidebar-full-only]";

function loadRail(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === RAIL;
  } catch {
    return false;
  }
}

export class SidebarState {
  /** 畳んでいる（アイコンだけの細い帯） */
  rail = loadRail();

  constructor() {
    makeObservable(this, { rail: observable, setRail: action });
  }

  setRail(rail: boolean): void {
    this.rail = rail;
    try {
      if (rail) localStorage.setItem(SIDEBAR_STORAGE_KEY, RAIL);
      else localStorage.removeItem(SIDEBAR_STORAGE_KEY);
    } catch {
      // 書けなければ（容量切れなど）、このタブのあいだだけ覚える
    }
  }

  /**
   * `<html>` の data-sidebar を、畳んでいるかどうかに合わせ続ける（アプリの外枠が描かれているあいだ）。
   * 戻り値を呼ぶとやめて、data-sidebar を外す（外枠のない画面では、帯の幅を使わない）
   */
  mirrorTo(root: HTMLElement = document.documentElement): () => void {
    const stop = reaction(
      () => this.rail,
      (rail) => {
        if (rail) root.dataset.sidebar = RAIL;
        else delete root.dataset.sidebar;
      },
      { fireImmediately: true },
    );
    return () => {
      stop();
      delete root.dataset.sidebar;
    };
  }
}

const states = new WeakMap<ListUi, SidebarState>();

export function sidebarOf(ui: ListUi): SidebarState {
  let state = states.get(ui);
  if (!state) {
    state = new SidebarState();
    states.set(ui, state);
  }
  return state;
}

/**
 * 畳む・広げる。畳むとき、フォーカスが帯では見せない部品（プロジェクトの ＋ と名前の欄）にあれば、先に一覧へ移す
 * （一覧のない画面では、フォーカスを外す）。名前の欄は、打った名前があれば開いたまま残り、広げると元どおり出る
 */
export function toggleSidebar(ui: ListUi): void {
  const sidebar = sidebarOf(ui);
  if (!sidebar.rail) {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest(FULL_ONLY_SELECTOR)) {
      ui.focusList();
      if (document.activeElement === active) active.blur();
    }
  }
  sidebar.setRail(!sidebar.rail);
}
