import { action, makeObservable, observable } from "mobx";
import type { ListUi } from "@/tasks/list-ui";

/**
 * ⌘K（検索とコマンド）と `?`（ショートカット一覧）の開閉。一覧の状態（ListUi）ごとに1つ。
 * 部品（command-palette.tsx・shortcuts-dialog.tsx）とは分けて持つ（8 で部品を後から読み込めるように）
 */
export class Overlays {
  palette = false;
  shortcuts = false;
  /**
   * ⌘K で選んだコマンド。⌘K が外れた直後に呼ぶ（閉じる途中のダイアログにフォーカスを取られないように）。
   * これがあるあいだは、閉じたときに元の場所へフォーカスを戻さない
   */
  pendingRun: (() => void) | null = null;
  /** ⌘K を開く前にフォーカスがあった要素（Esc などで閉じたら、ここへ戻す） */
  returnFocus: Element | null = null;

  constructor() {
    makeObservable(this, {
      palette: observable,
      shortcuts: observable,
      openPalette: action,
      closePalette: action,
      runFromPalette: action,
      openShortcuts: action,
      closeShortcuts: action,
    });
  }

  openPalette(): void {
    if (!this.palette) this.returnFocus = document.activeElement;
    this.shortcuts = false;
    this.palette = true;
  }

  closePalette(): void {
    this.palette = false;
  }

  /** ⌘K を閉じ、閉じ終えたら run を呼ぶ */
  runFromPalette(run: () => void): void {
    this.pendingRun = run;
    this.palette = false;
  }

  /** 閉じ終えたときに、選んだコマンドを取り出す */
  takePendingRun(): (() => void) | null {
    const run = this.pendingRun;
    this.pendingRun = null;
    return run;
  }

  openShortcuts(): void {
    this.palette = false;
    this.shortcuts = true;
  }

  closeShortcuts(): void {
    this.shortcuts = false;
  }
}

const overlays = new WeakMap<ListUi, Overlays>();

export function overlaysOf(ui: ListUi): Overlays {
  let value = overlays.get(ui);
  if (!value) {
    value = new Overlays();
    overlays.set(ui, value);
  }
  return value;
}
