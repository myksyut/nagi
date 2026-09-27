import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { SHORTCUTS } from "@/navigation";
import { shortcutsPageOf } from "./state";

/**
 * 17 の登録：`?` でショートカットのページを開き、ページでは Esc か `?` で前の画面に戻る。
 * ⌘K の「ショートカット一覧」も同じ割り当て。ページの部品は shortcuts-screen.tsx（後から読み込む。lazy.tsx）。
 * ページの Esc は、絞り込みの欄の中でも外でも同じ割り当て（`shortcuts.escape`）が受け、文字があれば先に消す。
 * `?` は1文字のキーなので、欄の中では文字として入り、外でだけ戻る
 */

export const SHORTCUTS_OPEN_BINDING_ID = "shortcuts.open";
export const SHORTCUTS_ESCAPE_BINDING_ID = "shortcuts.escape";
export const SHORTCUTS_CLOSE_BINDING_ID = "shortcuts.close";

/** ページが出ているときだけ効く割り当ての場面（一覧の Esc・`?` を開く割り当てとは同時に効かない） */
const SCOPE = "shortcuts";

export const SHORTCUTS_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: SHORTCUTS_OPEN_BINDING_ID,
    label: "ショートカット一覧",
    group: "全体",
    keys: ["?"],
    allowBeforeLoad: true,
    when: ({ ui }) => !shortcutsPageOf(ui).active,
    run: (context) => shortcutsPageOf(context.ui).open(context),
  },
  {
    id: SHORTCUTS_ESCAPE_BINDING_ID,
    label: "絞り込みを消す・前の画面に戻る",
    group: "全体",
    keys: ["Escape"],
    where: SHORTCUTS.label,
    // 絞り込みの欄の中でも効かせる（欄の中の Esc も、ここで文字を消すか戻るかを決める）
    allowInInput: true,
    allowBeforeLoad: true,
    scope: SCOPE,
    when: ({ ui }) => shortcutsPageOf(ui).active,
    run: (context) => shortcutsPageOf(context.ui).escape(context),
  },
  {
    id: SHORTCUTS_CLOSE_BINDING_ID,
    label: "前の画面に戻る",
    group: "全体",
    keys: ["?"],
    where: SHORTCUTS.label,
    allowBeforeLoad: true,
    scope: SCOPE,
    when: ({ ui }) => shortcutsPageOf(ui).active,
    run: (context) => shortcutsPageOf(context.ui).close(context),
  },
];

registerKeyBindings(SHORTCUTS_KEY_BINDINGS);
