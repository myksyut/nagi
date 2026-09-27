import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { overlaysOf } from "./overlays";

/**
 * 7 の登録：⌘K（検索とコマンド）。入力欄にいるときも開ける。部品は command-palette.tsx で、アプリの外枠が描く。
 * `?`（ショートカットのページ）は features/shortcuts が登録する
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
];

registerKeyBindings(PALETTE_KEY_BINDINGS);
