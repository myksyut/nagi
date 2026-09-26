import type { AppStore } from "@/data";
import type { ListUi } from "@/tasks/list-ui";
import {
  isActivatableTarget,
  isComposingKey,
  isEditableTarget,
  type KeyCombo,
  matchesKey,
  parseKey,
} from "./keys";

/**
 * キーの割り当ての一覧（キーマップ）。割り当ては登録式で、各機能が自分のキーを registerKeyBindings で足す
 * （4 の割り当ては features/core、5 と 6 は features/ の下の自分のモジュールで登録する）。
 * ⌘K のコマンド一覧、`?` のショートカット一覧、ツールチップのキー表示は、この一覧（keymap.list()）から作る
 */

/** キーが押されたときに割り当てへ渡すもの */
export type KeyContext = {
  store: AppStore;
  ui: ListUi;
  navigate: (path: string) => void;
};

/** `?` の一覧でのまとまり */
export type KeyGroup = "移動" | "リスト" | "タスク" | "いつやる";

export type KeyBinding = {
  /** 一意の名前（例：`task.complete`）。同じ id で登録し直すと置き換わる */
  id: string;
  /** ⌘K・`?` の一覧に出す名前 */
  label: string;
  group: KeyGroup;
  /** 割り当てるキー（keys.ts の書き方）。先頭が一覧に出す代表のキー */
  keys: readonly string[];
  /** 入力欄にいるあいだも効かせる。1文字のキーには使わない（入力欄では1文字のキーを無効にする決まり） */
  allowInInput?: boolean;
  /** 手元の控えを読み終える前（store.loaded が false）でも効かせる。データを変えない割り当てだけ */
  allowBeforeLoad?: boolean;
  /** 押しっぱなしの繰り返しでも動かす（↑↓ など） */
  repeat?: boolean;
  /** 今使えるか。false のときはキーを奪わない（ブラウザの既定の動きに任せる） */
  when?: (ctx: KeyContext) => boolean;
  run: (ctx: KeyContext) => void;
};

type Entry = { binding: KeyBinding; combos: KeyCombo[] };

export class Keymap {
  readonly #entries = new Map<string, Entry>();

  /** 割り当てを足す。戻り値を呼ぶと外す */
  register(bindings: KeyBinding | readonly KeyBinding[]): () => void {
    const list: readonly KeyBinding[] = Array.isArray(bindings) ? bindings : [bindings];
    for (const binding of list) {
      if (binding.allowInInput && binding.keys.some((key) => isPlainCharacter(key))) {
        throw new Error(`1文字のキーは入力欄で効かせられません：${binding.id}`);
      }
      this.#entries.set(binding.id, { binding, combos: binding.keys.map(parseKey) });
    }
    return () => {
      for (const binding of list) {
        if (this.#entries.get(binding.id)?.binding === binding) this.#entries.delete(binding.id);
      }
    };
  }

  /** 登録されている割り当て（登録した順） */
  list(): KeyBinding[] {
    return Array.from(this.#entries.values(), (entry) => entry.binding);
  }

  get(id: string): KeyBinding | undefined {
    return this.#entries.get(id)?.binding;
  }

  /**
   * キーボードのイベントを割り当てに渡す。当たって動かしたら true（既定の動きは止める）。
   * - 日本語入力の変換中（確定の Enter を含む）は何もしない
   * - 入力欄にいるあいだは allowInInput の割り当てだけ
   * - ボタンやリンクの上での Enter と Space は、その部品に任せる
   * - `data-keymap="off"` の要素の中（5 以降のポップオーバーなど）では何もしない
   */
  dispatch(event: KeyboardEvent, context: KeyContext): boolean {
    if (event.defaultPrevented || isComposingKey(event)) return false;
    const target = event.target;
    if (target instanceof Element && target.closest("[data-keymap='off']")) return false;
    const editable = isEditableTarget(target);
    const activatable = (event.key === "Enter" || event.key === " ") && isActivatableTarget(target);
    for (const { binding, combos } of this.#entries.values()) {
      if (!combos.some((combo) => matchesKey(combo, event))) continue;
      if (editable && !binding.allowInInput) continue;
      if (activatable) continue;
      if (event.repeat && !binding.repeat) continue;
      if (!context.store.loaded && !binding.allowBeforeLoad) continue;
      if (binding.when && !binding.when(context)) continue;
      event.preventDefault();
      binding.run(context);
      return true;
    }
    return false;
  }
}

function isPlainCharacter(spec: string): boolean {
  const combo = parseKey(spec);
  return [...combo.key].length === 1 && !combo.mod && !combo.alt;
}

/** アプリのキーマップ（1つだけ） */
export const keymap = new Keymap();

/** 割り当てを足す（5・6 はこれを使う）。戻り値を呼ぶと外す */
export function registerKeyBindings(bindings: KeyBinding | readonly KeyBinding[]): () => void {
  return keymap.register(bindings);
}
