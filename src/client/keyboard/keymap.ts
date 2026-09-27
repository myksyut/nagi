import { createAtom } from "mobx";
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
 * ⌘K のコマンド一覧、ショートカットのページ（features/shortcuts）、ツールチップのキー表示は、
 * この一覧（keymap.list()）から作る。候補や欄の中のキー（部品が直接扱うキー）は、説明だけを field-keys.ts に登録する
 */

/** キーが押されたときに割り当てへ渡すもの */
export type KeyContext = {
  store: AppStore;
  ui: ListUi;
  /** 画面を移る。replace なら今の画面の履歴を置き換える（ショートカットのページから戻るとき） */
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

/** ショートカットのページと ⌘K でのまとまり */
export type KeyGroup = "移動" | "リスト" | "タスク" | "いつやる" | "全体";

/** ショートカットのページと ⌘K に並べるまとまりの順 */
export const KEY_GROUP_ORDER: readonly KeyGroup[] = [
  "タスク",
  "いつやる",
  "移動",
  "リスト",
  "全体",
];

export type KeyBinding = {
  /** 一意の名前（例：`task.complete`）。同じ id で登録し直すと置き換わる */
  id: string;
  /** ⌘K・ショートカットのページに出す名前 */
  label: string;
  group: KeyGroup;
  /**
   * 割り当てるキー（keys.ts の書き方）。先頭が一覧に出す代表のキー。
   * 空にすると、キーのない操作になる（⌘K からだけ実行する。ショートカットのページには「キーなし」で出す）
   */
  keys: readonly string[];
  /**
   * 決まった画面だけで効くキーの、効く画面の名前（例：「ボード」）。ショートカットのページで操作の名前に添える
   */
  where?: string;
  /** 入力欄にいるあいだも効かせる。1文字のキーには使わない（入力欄では1文字のキーを無効にする決まり） */
  allowInInput?: boolean;
  /** 手元の控えを読み終える前（store.loaded が false）でも効かせる。データを変えない割り当てだけ */
  allowBeforeLoad?: boolean;
  /** 押しっぱなしの繰り返しでも動かす（↑↓ など） */
  repeat?: boolean;
  /** 今使えるか。false のときはキーを奪わない（ブラウザの既定の動きに任せる） */
  when?: (ctx: KeyContext) => boolean;
  run: (ctx: KeyContext) => void;
  /**
   * このキーが効く場面の名前（省略すると既定の場面）。同じ場面で同じキーを別の id に割り当てると、
   * 開発とテストでは登録で例外になる（本番はコンソールに出し、先に登録したほうが動く）。
   * 同じキーを場面ごとに使い分けるときだけ別の名前を付け、when で同時に効かないようにする
   */
  scope?: string;
};

type Entry = { binding: KeyBinding; combos: KeyCombo[] };

const DEFAULT_SCOPE = "default";

/** 同じキーか（英字は大文字と小文字を区別しない。`D` と `d` は同じ Shift なしの d） */
function sameCombo(a: KeyCombo, b: KeyCombo): boolean {
  const key = (combo: KeyCombo) =>
    /^[a-z]$/i.test(combo.key) ? combo.key.toLowerCase() : combo.key;
  return key(a) === key(b) && a.mod === b.mod && a.shift === b.shift && a.alt === b.alt;
}

export class Keymap {
  readonly #entries = new Map<string, Entry>();
  /**
   * 登録の出入りを MobX に知らせる（list() を読む observer の部品が描き直す）。画面の中だけで効くキーは、
   * 画面と一緒に後から読み込むモジュールが登録するので、開いているショートカットのページにも後から出る
   */
  readonly #atom = createAtom("keymap");

  /**
   * 割り当てを足す。戻り値を呼ぶと外す。
   * 同じ場面（scope）で同じキーがほかの id に割り当て済みなら、開発とテストでは例外にする
   * （5 と 6 が並行してキーを足したときに、表示と実際に動く操作がずれないように）
   */
  register(bindings: KeyBinding | readonly KeyBinding[]): () => void {
    const list: readonly KeyBinding[] = Array.isArray(bindings) ? bindings : [bindings];
    const entries = list.map((binding): Entry => {
      if (binding.allowInInput && binding.keys.some((key) => isPlainCharacter(key))) {
        throw new Error(`1文字のキーは入力欄で効かせられません：${binding.id}`);
      }
      return { binding, combos: binding.keys.map(parseKey) };
    });
    const conflicts = this.#conflicts(entries);
    if (conflicts.length > 0) {
      const message = `同じ場面で同じキーが重なっています：${conflicts.join("、")}`;
      if (import.meta.env.DEV) throw new Error(message);
      console.error(message);
    }
    for (const entry of entries) this.#entries.set(entry.binding.id, entry);
    this.#atom.reportChanged();
    return () => {
      for (const binding of list) {
        if (this.#entries.get(binding.id)?.binding === binding) this.#entries.delete(binding.id);
      }
      this.#atom.reportChanged();
    };
  }

  /** 登録されている割り当て（登録した順）。observer の中で読むと、登録が変わったときに描き直す */
  list(): KeyBinding[] {
    this.#atom.reportObserved();
    return Array.from(this.#entries.values(), (entry) => entry.binding);
  }

  get(id: string): KeyBinding | undefined {
    return this.#entries.get(id)?.binding;
  }

  /**
   * その割り当てを今使えるか（手元の控えを読み終えたか、when）。キーでも ⌘K でも同じ決まりで判断する
   */
  canRun(binding: KeyBinding, context: KeyContext): boolean {
    if (!context.store.loaded && !binding.allowBeforeLoad) return false;
    return !binding.when || binding.when(context);
  }

  /** ⌘K などから、キーを押したときと同じ run を呼ぶ。今使えなければ呼ばずに false */
  run(id: string, context: KeyContext): boolean {
    const binding = this.get(id);
    if (!binding || !this.canRun(binding, context)) return false;
    binding.run(context);
    return true;
  }

  /** 足そうとしている割り当てと、登録済み（同じ id は置き換えるので除く）・互いのあいだで重なるキー */
  #conflicts(adding: readonly Entry[]): string[] {
    const replacing = new Set(adding.map((entry) => entry.binding.id));
    const existing = Array.from(this.#entries.values()).filter(
      (entry) => !replacing.has(entry.binding.id),
    );
    const conflicts: string[] = [];
    const checked: Entry[] = [...existing];
    for (const entry of adding) {
      const scope = entry.binding.scope ?? DEFAULT_SCOPE;
      for (const other of checked) {
        if ((other.binding.scope ?? DEFAULT_SCOPE) !== scope) continue;
        entry.binding.keys.forEach((key, i) => {
          const combo = entry.combos[i];
          if (combo && other.combos.some((o) => sameCombo(o, combo))) {
            conflicts.push(`${key}（${entry.binding.id} と ${other.binding.id}）`);
          }
        });
      }
      checked.push(entry);
    }
    return conflicts;
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
      if (!this.canRun(binding, context)) continue;
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
