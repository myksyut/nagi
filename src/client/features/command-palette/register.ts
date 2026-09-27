import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { overlaysOf } from "./overlays";

/**
 * 7 の登録：⌘K（検索とコマンド）と `?`（ショートカット一覧）。
 * ⌘K は入力欄にいるときも開ける。部品は command-palette.tsx と shortcuts-dialog.tsx で、アプリの外枠が描く
 */

export const PALETTE_BINDING_ID = "palette.open";

export const PALETTE_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: PALETTE_BINDING_ID,
    label: "検索とコマンド",
    group: "全体",
    keys: ["Mod+k"],
    allowInInput: true,
    allowBeforeLoad: true,
    run: ({ ui }) => overlaysOf(ui).openPalette(),
  },
  {
    id: "shortcuts.open",
    label: "ショートカット一覧",
    group: "全体",
    keys: ["?"],
    allowBeforeLoad: true,
    run: ({ ui }) => overlaysOf(ui).openShortcuts(),
  },
];

registerKeyBindings(PALETTE_KEY_BINDINGS);
