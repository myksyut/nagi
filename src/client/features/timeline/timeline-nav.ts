import { observable, runInAction } from "mobx";

/**
 * タイムラインの画面が開いているあいだだけ、[ ]（1週ずつ前後へ）を効かせるための口。
 * 画面（後から読み込む）がスクロールのしかたを渡し、キーの割り当て（起動の道筋にある register.tsx）はここを見る。
 * 画面のモジュールを起動の道筋から import しないために、口だけをここに分けておく
 */

export type TimelineScroller = {
  /** 1週（delta が負なら前へ）ずつ横にスクロールする */
  scrollWeeks(delta: number): void;
  /** 今日の位置へ横にスクロールする */
  scrollToToday(): void;
};

/** タイムラインの画面の URL */
export const TIMELINE_PATH = "/timeline";

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
