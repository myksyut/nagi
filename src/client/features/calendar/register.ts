import { registerKeyBindings } from "@/keyboard/keymap";
import { CALENDAR } from "@/navigation";

/**
 * カレンダーを開くキー（6）。画面（calendar-screen.tsx）と、画面の中だけで効くキー（[ ]。state.ts）は後から読み込む
 */
registerKeyBindings({
  id: "go.calendar",
  label: `${CALENDAR.label}を開く`,
  group: "リスト",
  keys: ["6"],
  allowBeforeLoad: true,
  run: ({ navigate }) => navigate(CALENDAR.path),
});
