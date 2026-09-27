import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";
import { TIMELINE_PATH, timelineNav } from "./timeline-nav";

/**
 * 14 の登録：タイムラインを開く 7 と、タイムラインの中の [ ]（1週ずつ前後へスクロール）。
 * [ ] はカレンダー（13 の前後の月）と同じキーなので、場面（scope）を分け、タイムラインが開いているときだけ効かせる。
 * タイムラインの画面そのもの（timeline-screen.tsx）は後から読み込むので、ここからは import しない
 */

export const TIMELINE_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "go.timeline",
    label: "タイムラインを開く",
    group: "リスト",
    keys: ["7"],
    allowBeforeLoad: true,
    run: ({ navigate }) => navigate(TIMELINE_PATH),
  },
  {
    id: "timeline.previousWeek",
    label: "前の週へ",
    group: "移動",
    keys: ["["],
    scope: "timeline",
    when: () => timelineNav.active,
    run: () => timelineNav.scroller?.scrollWeeks(-1),
  },
  {
    id: "timeline.nextWeek",
    label: "次の週へ",
    group: "移動",
    keys: ["]"],
    scope: "timeline",
    when: () => timelineNav.active,
    run: () => timelineNav.scroller?.scrollWeeks(1),
  },
];

registerKeyBindings(TIMELINE_KEY_BINDINGS);
