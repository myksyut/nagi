import { observable, runInAction } from "mobx";
import { type KeyBinding, registerKeyBindings } from "@/keyboard/keymap";

/**
 * タイムラインの画面が開いているあいだだけ効くキー（[ ] で1週ずつ前後へスクロール）と、そのための口。
 * 画面（timeline-screen.tsx）がスクロールのしかたを渡し、キーの割り当てはここを見る。
 * 画面と一緒に後から読み込む（起動の道筋から import しない）。キーは、このモジュールが読み込まれたとき
 * （起動のあとの空いた時間の先読み）に登録する。[ ] はカレンダーの前後の月と同じキーなので、場面（scope）を分ける
 */

export type TimelineScroller = {
  /** 1週（delta が負なら前へ）ずつ横にスクロールする */
  scrollWeeks(delta: number): void;
  /** 今日の位置へ横にスクロールする */
  scrollToToday(): void;
};

const current = observable.box<TimelineScroller | null>(null, { deep: false });

export const timelineNav = {
  /** タイムラインの画面が開いているか */
  get active(): boolean {
    return current.get() !== null;
  },
  get scroller(): TimelineScroller | null {
    return current.get();
  },
  /** 画面が開いたときに渡す。戻り値を呼ぶと外す */
  attach(scroller: TimelineScroller): () => void {
    runInAction(() => current.set(scroller));
    return () =>
      runInAction(() => {
        if (current.get() === scroller) current.set(null);
      });
  },
};

/** タイムラインの画面が開いているときだけ効く割り当ての場面（カレンダーの [ ] とは別） */
const SCOPE = "timeline";

export const TIMELINE_KEY_BINDINGS: readonly KeyBinding[] = [
  {
    id: "timeline.previousWeek",
    label: "前の週へ",
    group: "移動",
    keys: ["["],
    scope: SCOPE,
    when: () => timelineNav.active,
    run: () => timelineNav.scroller?.scrollWeeks(-1),
  },
  {
    id: "timeline.nextWeek",
    label: "次の週へ",
    group: "移動",
    keys: ["]"],
    scope: SCOPE,
    when: () => timelineNav.active,
    run: () => timelineNav.scroller?.scrollWeeks(1),
  },
];

registerKeyBindings(TIMELINE_KEY_BINDINGS);
