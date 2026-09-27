import { action, makeObservable, observable } from "mobx";
import type { KeyContext } from "@/keyboard/keymap";
import { HOME_PATH, SHORTCUTS } from "@/navigation";
import type { ListUi } from "@/tasks/list-ui";

/**
 * ショートカットのページの状態（一覧の状態（ListUi）ごとに1つ）：ページが出ているか（Esc と `?` で戻るため）と、
 * 戻る先（ページを開く前にいた画面）。戻る先は、アプリの外枠が画面を移るたびに知らせる（noteLocation）。
 * 起動の道筋から使うので、ページの部品（後から読み込む）とは分けて持つ
 */
export class ShortcutsPage {
  /** ページが出ている */
  active = false;
  /** 戻る先。ページを直接開いたとき（アプリの中で前の画面がない）は null で、今日へ戻る */
  returnPath: string | null = null;

  constructor() {
    makeObservable(this, { active: observable, show: action, hide: action });
  }

  show(): void {
    this.active = true;
  }

  hide(): void {
    this.active = false;
  }

  /** 画面を移った。ページのほかの画面なら、戻る先として覚える */
  noteLocation(path: string): void {
    if (path !== SHORTCUTS.path) this.returnPath = path;
  }

  /** ページを開く */
  open(context: KeyContext): void {
    context.navigate(SHORTCUTS.path);
  }

  /** 前の画面に戻る（ページの履歴を置き換える。戻る先がなければ今日へ） */
  close(context: KeyContext): void {
    context.navigate(this.returnPath ?? HOME_PATH, { replace: true });
  }
}

const pages = new WeakMap<ListUi, ShortcutsPage>();

export function shortcutsPageOf(ui: ListUi): ShortcutsPage {
  let page = pages.get(ui);
  if (!page) {
    page = new ShortcutsPage();
    pages.set(ui, page);
  }
  return page;
}
