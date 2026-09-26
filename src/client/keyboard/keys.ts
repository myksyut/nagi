/**
 * キーの書き方と、キーボードのイベントとの照らし合わせ。
 * - 書き方：`x`・`?`・`1` のような1文字、`Enter`・`Escape`・`ArrowDown`・`Backspace` のような名前、
 *   修飾キーは `Mod+`（⌘）・`Shift+`・`Alt+` を前に付ける（例：`Mod+z`、`Mod+Backspace`、`Shift+d`、`Alt+ArrowUp`）
 * - Mac だけが対象なので、`Mod` は ⌘（metaKey）。Ctrl を押しているキーはどれにも当てない（ブラウザや OS に任せる）
 * - 1文字のキーは、修飾キーなしで押したときだけ当たる。Shift は `?` のように文字そのものに表れるので見ない
 *   （英字だけは `Shift+d` と書けば ⇧D、`d` と書けば Shift なしの d）
 */

export type KeyCombo = {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
};

const MODIFIERS = new Set(["Mod", "Shift", "Alt"]);

/** `Mod+Backspace` のような書き方を読む */
export function parseKey(spec: string): KeyCombo {
  const parts = spec.split("+");
  // `Mod++` のように + そのものを書いたときのために、最後の空の要素は + として読む
  const key = parts.length > 1 && parts.at(-1) === "" ? "+" : (parts.at(-1) ?? "");
  const modifiers = new Set(parts.slice(0, parts.at(-1) === "" ? -2 : -1));
  for (const modifier of modifiers) {
    if (!MODIFIERS.has(modifier)) throw new Error(`知らない修飾キーです：${modifier}（${spec}）`);
  }
  if (key === "") throw new Error(`キーがありません：${spec}`);
  return {
    key,
    mod: modifiers.has("Mod"),
    shift: modifiers.has("Shift"),
    alt: modifiers.has("Alt"),
  };
}

function isSingleCharacter(key: string): boolean {
  return [...key].length === 1;
}

function isLetter(key: string): boolean {
  return /^[a-z]$/i.test(key);
}

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** イベントがそのキーに当たるか */
export function matchesKey(combo: KeyCombo, event: KeyLike): boolean {
  if (event.ctrlKey) return false;
  if (event.metaKey !== combo.mod || event.altKey !== combo.alt) return false;
  if (isSingleCharacter(combo.key)) {
    if (isLetter(combo.key)) {
      // ⌘ を押したときの英字は小文字で届く。Shift は書き方どおりに見る
      return event.key.toLowerCase() === combo.key.toLowerCase() && event.shiftKey === combo.shift;
    }
    return event.key === combo.key;
  }
  return event.key === combo.key && event.shiftKey === combo.shift;
}

/**
 * 日本語入力の変換中のキーか（変換を確定する Enter を含む）。
 * Safari は確定の Enter で isComposing が false になることがあるので、keyCode 229 も見る
 */
export function isComposingKey(event: Pick<KeyboardEvent, "isComposing" | "keyCode">): boolean {
  return event.isComposing || event.keyCode === 229;
}

/** 文字を打てる場所（入力欄・テキストエリア・contenteditable・select） */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes(
      target.type,
    );
  }
  return target instanceof HTMLElement && target.isContentEditable;
}

/** Enter や Space で自分が動く部品（ボタン・リンクなど）。そこでの Enter は部品に任せる */
export function isActivatableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest("button, a[href], summary, [role='button'], [role='link']") !== null;
}

const KEY_LABELS: Record<string, string> = {
  Enter: "↩",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "⌦",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

/** 画面に出すキーの表記（例：`Mod+z` → `⌘Z`、`Shift+d` → `⇧D`） */
export function formatKey(spec: string): string {
  const combo = parseKey(spec);
  const key = KEY_LABELS[combo.key] ?? (isLetter(combo.key) ? combo.key.toUpperCase() : combo.key);
  return `${combo.alt ? "⌥" : ""}${combo.shift ? "⇧" : ""}${combo.mod ? "⌘" : ""}${key}`;
}
