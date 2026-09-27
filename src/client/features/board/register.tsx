import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { screenLayoutsOf } from "./layout";

/**
 * 12 の登録：v（リスト／ボードの切り替え）と、ボードの ←→（列の移動）。
 * ↑↓・⇧↑↓ はリストと同じ割り当て（features/core）で、ボードでは ListUi が同じ列の中だけを動かす。
 * x・s・t・d・l・p・⇧D・⌘⌫・⌥↑↓・Enter もリストと同じ割り当てが、選んでいるカードに働く。
 * ボードの画面（board.tsx）は後から読み込むので、ここでは読み込まない
 */

/** ボードの割り当ての場面（←→ は、列のある一覧のときだけ効く） */
const BOARD_SCOPE = "board";

export const BOARD_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "view.toggleBoard",
    label: "リスト／ボードの切り替え",
    group: "リスト",
    keys: ["v"],
    when: ({ ui }) => screenLayoutsOf(ui).screen !== null,
    run: ({ ui }) => {
      const layouts = screenLayoutsOf(ui);
      if (layouts.screen !== null) layouts.toggle(layouts.screen);
    },
  },
  {
    id: "board.left",
    label: "左の列へ",
    group: "移動",
    keys: ["ArrowLeft"],
    repeat: true,
    scope: BOARD_SCOPE,
    when: ({ ui }) => ui.columns.length > 0,
    run: ({ ui }) => {
      ui.moveColumn(-1);
      ui.focusList();
    },
  },
  {
    id: "board.right",
    label: "右の列へ",
    group: "移動",
    keys: ["ArrowRight"],
    repeat: true,
    scope: BOARD_SCOPE,
    when: ({ ui }) => ui.columns.length > 0,
    run: ({ ui }) => {
      ui.moveColumn(1);
      ui.focusList();
    },
  },
];

registerKeyBindings(BOARD_KEY_BINDINGS);
