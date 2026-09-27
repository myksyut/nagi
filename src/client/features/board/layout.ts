import { action, makeObservable, observable } from "mobx";
import type { ListUi } from "@/tasks/list-ui";

/**
 * 今日と各プロジェクトの画面を、リストで見るかボードで見るか。画面ごとに覚え、localStorage に残す
 * （再読み込みしても残る。残せないときは、そのタブのあいだだけ覚える）。
 * 画面の名前は、その画面の一覧の名前（ListView.key。今日は `today`、プロジェクトは `project:<id>`）。
 * ボードの画面そのもの（board.tsx）は後から読み込むので、ここには切り替えの状態だけを置く
 */

export type ScreenLayout = "list" | "board";

const STORAGE_KEY = "nagi:board-screens";

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export class ScreenLayouts {
  /** 切り替えられる画面のうち、今開いているもの（v が効く）。なければ null */
  screen: string | null = null;
  /** ボードで見ている画面（ほかはリスト） */
  readonly #boards = observable.set<string>();
  readonly #storage: Storage | null;

  constructor(storage: Storage | null = defaultStorage()) {
    this.#storage = storage;
    this.#boards.replace(this.#load());
    makeObservable<ScreenLayouts, "setScreen">(this, {
      screen: observable,
      set: action,
      setScreen: action,
    });
  }

  layoutOf(screen: string): ScreenLayout {
    return this.#boards.has(screen) ? "board" : "list";
  }

  set(screen: string, layout: ScreenLayout): void {
    if (this.layoutOf(screen) === layout) return;
    if (layout === "board") this.#boards.add(screen);
    else this.#boards.delete(screen);
    this.#save();
  }

  toggle(screen: string): void {
    this.set(screen, this.layoutOf(screen) === "board" ? "list" : "board");
  }

  /** 切り替えられる画面が開いた（v が効くようになる）。戻り値を呼ぶと閉じたことにする */
  open(screen: string): () => void {
    this.setScreen(screen);
    return () => {
      if (this.screen === screen) this.setScreen(null);
    };
  }

  protected setScreen(screen: string | null): void {
    this.screen = screen;
  }

  #load(): string[] {
    try {
      const parsed: unknown = JSON.parse(this.#storage?.getItem(STORAGE_KEY) ?? "[]");
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === "string")
        : [];
    } catch {
      return [];
    }
  }

  #save(): void {
    try {
      if (this.#boards.size === 0) this.#storage?.removeItem(STORAGE_KEY);
      else this.#storage?.setItem(STORAGE_KEY, JSON.stringify([...this.#boards]));
    } catch {
      // 書けなければ（容量切れなど）、このタブのあいだだけ覚える
    }
  }
}

const layouts = new WeakMap<ListUi, ScreenLayouts>();

/** その一覧の状態に付いた、画面ごとの切り替え（アプリの外枠ごとに1つ） */
export function screenLayoutsOf(ui: ListUi): ScreenLayouts {
  let value = layouts.get(ui);
  if (!value) {
    value = new ScreenLayouts();
    layouts.set(ui, value);
  }
  return value;
}
