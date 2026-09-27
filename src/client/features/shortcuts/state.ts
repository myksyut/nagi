import { action, makeObservable, observable } from "mobx";
import type { KeyContext } from "@/keyboard/keymap";
import { HOME_PATH, projectIdOfPath, SHORTCUTS } from "@/navigation";
import type { ListUi } from "@/tasks/list-ui";

/**
 * ショートカットのページの状態（一覧の状態（ListUi）ごとに1つ）：ページが出ているか（Esc と `?` で戻るため）、
 * 絞り込みの文字、戻る先（ページを開く前にいた画面）。戻る先は、アプリの外枠が画面を移るたびに知らせる（noteLocation）。
 * 絞り込みの文字をここで持つのは、Esc の判断（文字があれば消す、なければ戻る）を、絞り込みの欄の中からも外からも
 * 同じにするため（Esc はキーマップの割り当て `shortcuts.escape` が受ける）。
 * 起動の道筋から使うので、ページの部品（後から読み込む）とは分けて持つ
 */
export class ShortcutsPage {
  /** ページが出ている */
  active = false;
  /** 絞り込みの文字（ページを開くたびに空から） */
  filter = "";
  /** 戻る先。ページを直接開いたとき（アプリの中で前の画面がない）は null で、今日へ戻る */
  returnPath: string | null = null;

  constructor() {
    makeObservable(this, {
      active: observable,
      filter: observable,
      show: action,
      hide: action,
      setFilter: action,
    });
  }

  show(): void {
    this.active = true;
    this.filter = "";
  }

  hide(): void {
    this.active = false;
    this.filter = "";
  }

  setFilter(filter: string): void {
    this.filter = filter;
  }

  /** 画面を移った。ページのほかの画面なら、戻る先として覚える */
  noteLocation(path: string): void {
    if (path !== SHORTCUTS.path) this.returnPath = path;
  }

  /** ページを開く */
  open(context: KeyContext): void {
    context.navigate(SHORTCUTS.path);
  }

  /**
   * 前の画面に戻る（ページの履歴を置き換える）。戻る先がないとき（直接開いた）と、戻る先のプロジェクトが
   * ページを開いているあいだに消えたとき（作成の ⌘Z など）は今日へ
   */
  close(context: KeyContext): void {
    context.navigate(this.#returnPathFor(context), { replace: true });
  }

  /** Esc：絞り込みの文字があれば消し、なければ前の画面に戻る */
  escape(context: KeyContext): void {
    if (this.filter !== "") this.setFilter("");
    else this.close(context);
  }

  #returnPathFor({ store }: KeyContext): string {
    const path = this.returnPath;
    if (path === null) return HOME_PATH;
    const projectId = projectIdOfPath(path);
    if (projectId !== undefined) {
      const project = store.project(projectId);
      if (!project || project.deletedAt !== null) return HOME_PATH;
    }
    return path;
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
