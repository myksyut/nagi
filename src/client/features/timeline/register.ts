import { registerKeyBindings } from "@/keyboard/keymap";
import { TIMELINE } from "@/navigation";

/**
 * タイムラインを開くキー（7）。画面（timeline-screen.tsx）と、画面の中だけで効くキー（[ ]。timeline-nav.ts）は後から読み込む
 */
registerKeyBindings({
  id: "go.timeline",
  label: `${TIMELINE.label}を開く`,
  group: "リスト",
  keys: ["7"],
  allowBeforeLoad: true,
  run: ({ navigate }) => navigate(TIMELINE.path),
});
