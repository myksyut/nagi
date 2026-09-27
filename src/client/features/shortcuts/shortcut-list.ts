import type { FieldKeyScene } from "@/keyboard/field-keys";
import { KEY_GROUP_ORDER, type KeyBinding, type KeyGroup } from "@/keyboard/keymap";
import { formatKey, parseKey } from "@/keyboard/keys";

/**
 * ショートカットのページに並べるもの（純粋な関数）。キーマップの割り当てをまとまりごとに、
 * 候補や欄の中のキーを場面ごとに並べ、絞り込みの文字（操作の名前かキーの一部）で絞る。
 * ページの部品（shortcuts-screen.tsx）と一緒に後から読み込む
 */

export type ShortcutRow = {
  /** 一意の値 */
  key: string;
  label: string;
  /** 決まった画面だけで効くキーの、効く画面 */
  where?: string;
  /** キー（keys.ts の書き方）。空ならキーのない操作 */
  keys: readonly string[];
};

export type ShortcutSection = {
  /** 一意の値（まとまりの名前か、場面の id） */
  key: string;
  title: string;
  rows: ShortcutRow[];
};

/** 比べ方：全角と半角、大文字と小文字を区別しない */
export function normalizeFilter(text: string): string {
  return text.normalize("NFKC").trim().toLowerCase();
}

const MODIFIER_SYMBOLS = ["⌘", "⇧", "⌥"];

/** キーの名前の読み方（2文字以上で絞り込むとき。「enter」「esc」「cmd+z」など） */
const KEY_ALIASES: Record<string, readonly string[]> = {
  Enter: ["enter", "return"],
  Escape: ["escape", "esc"],
  Backspace: ["backspace", "delete"],
  Delete: ["delete"],
  ArrowUp: ["arrowup", "up"],
  ArrowDown: ["arrowdown", "down"],
  ArrowLeft: ["arrowleft", "left"],
  ArrowRight: ["arrowright", "right"],
  " ": ["space"],
  Tab: ["tab"],
};

function keyWords(spec: string): string[] {
  const combo = parseKey(spec);
  const names = KEY_ALIASES[combo.key] ?? [combo.key.toLowerCase()];
  const modifiers = [
    combo.mod ? ["cmd", "command"] : [],
    combo.shift ? ["shift"] : [],
    combo.alt ? ["option", "alt"] : [],
  ];
  // 「cmd+z」「shift+d」のように修飾キーと続けて打ったときも当てる
  const prefixes = modifiers.reduce<string[]>(
    (acc, words) => (words.length === 0 ? acc : acc.flatMap((p) => words.map((w) => `${p}${w}+`))),
    [""],
  );
  return prefixes.flatMap((prefix) => names.map((name) => `${prefix}${name}`));
}

/**
 * キーが絞り込みの文字に当たるか。
 * 1文字なら、修飾キーを除いたキーそのもの（「d」で d と ⇧D、「↑」で ↑ と ⌥↑）か、修飾キーの記号（「⌘」で ⌘ 付き）。
 * 2文字以上なら、画面に出す表記（「⇧d」「⌘z」「esc」）か、キーの名前（「enter」「cmd+z」）の一部
 */
export function keyMatches(spec: string, query: string): boolean {
  const shown = formatKey(spec).toLowerCase();
  if ([...query].length === 1) {
    if (MODIFIER_SYMBOLS.includes(query)) return shown.includes(query);
    return shown.replace(/^[⌥⇧⌘]+/u, "") === query;
  }
  return shown.includes(query) || keyWords(spec).some((word) => word.includes(query));
}

function rowMatches(row: ShortcutRow, query: string): boolean {
  if (query === "") return true;
  if (normalizeFilter(row.label).includes(query)) return true;
  if (row.where !== undefined && normalizeFilter(row.where).includes(query)) return true;
  return row.keys.some((key) => keyMatches(key, query));
}

/**
 * 決まった画面だけで効くキーは、どこでも効くキーの後ろに、効く画面ごとにまとめる
 * （画面の中だけで効くキーは後から読み込むモジュールが登録するので、登録した順は読み込みの順で変わる）
 */
function compareWhere(a: KeyBinding, b: KeyBinding): number {
  if (a.where === b.where) return 0;
  if (a.where === undefined) return -1;
  if (b.where === undefined) return 1;
  return a.where.localeCompare(b.where, "ja");
}

/**
 * キーマップの割り当てを、まとまりごとに（まとまりの順は ⌘K と同じ）。まとまりの中は登録した順で、
 * 決まった画面だけで効くキーは後ろに、効く画面ごとに並べる
 */
export function bindingSections(
  bindings: readonly KeyBinding[],
  filter: string,
): ShortcutSection[] {
  const query = normalizeFilter(filter);
  const byGroup = new Map<KeyGroup, ShortcutRow[]>();
  for (const binding of [...bindings].sort(compareWhere)) {
    const row: ShortcutRow = {
      key: binding.id,
      label: binding.label,
      where: binding.where,
      keys: binding.keys,
    };
    if (!rowMatches(row, query)) continue;
    const rows = byGroup.get(binding.group);
    if (rows) rows.push(row);
    else byGroup.set(binding.group, [row]);
  }
  return KEY_GROUP_ORDER.flatMap((group) => {
    const rows = byGroup.get(group);
    return rows ? [{ key: group, title: group, rows }] : [];
  });
}

/**
 * 候補や欄の中のキーを、場面ごとに。場面の名前が絞り込みの文字に当たれば、その場面の操作をすべて出す
 * （「チェックリスト」で絞ると、チェックリストの中のキーが並ぶ）
 */
export function fieldKeySections(
  scenes: readonly FieldKeyScene[],
  filter: string,
): ShortcutSection[] {
  const query = normalizeFilter(filter);
  return scenes.flatMap((scene) => {
    const sceneMatches = query === "" || normalizeFilter(scene.label).includes(query);
    const rows = scene.keys
      .map(
        (fieldKey, i): ShortcutRow => ({
          key: `${scene.id}:${i}`,
          label: fieldKey.label,
          keys: fieldKey.keys,
        }),
      )
      .filter((row) => sceneMatches || rowMatches(row, query));
    return rows.length > 0 ? [{ key: scene.id, title: scene.label, rows }] : [];
  });
}
