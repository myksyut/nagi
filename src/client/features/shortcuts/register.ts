import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { SHORTCUTS } from "@/navigation";
import { shortcutsPageOf } from "./state";

/**
 * 17 の登録：`?` でショートカットのページを開き、ページでは Esc か `?` で前の画面に戻る。
 * ⌘K の「ショートカット一覧」も同じ割り当て。ページの部品は shortcuts-screen.tsx（後から読み込む。lazy.tsx）。
 * 絞り込みの欄の中の Esc（文字を消す・空なら戻る）は、ページの部品が自分で扱う
 */

export const SHORTCUTS_OPEN_BINDING_ID = "shortcuts.open";
export const SHORTCUTS_CLOSE_BINDING_ID = "shortcuts.close";

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
    id: SHORTCUTS_CLOSE_BINDING_ID,
    label: "前の画面に戻る",
    group: "全体",
    keys: ["Escape", "?"],
    where: SHORTCUTS.label,
    allowBeforeLoad: true,
    // ページが出ているときだけ効く（一覧の Esc・`?` を開く割り当てとは同時に効かない）
    scope: "shortcuts",
    when: ({ ui }) => shortcutsPageOf(ui).active,
    run: (context) => shortcutsPageOf(context.ui).close(context),
  },
];

registerKeyBindings(SHORTCUTS_KEY_BINDINGS);
