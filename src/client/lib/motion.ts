import type { Transition } from "motion/react";
import { defer } from "./deferred";

/**
 * 動きの速さ（秒）。styles.css の --duration-* と同じ値にそろえる。
 * 動かすのは transform と opacity だけ。250ms を超える動きは使わない
 */
export const DURATION = {
  instant: 0,
  short: 0.1,
  base: 0.2,
  exit: 0.15,
} as const;

/** 行き過ぎずに止まる減速（跳ねない） */
export const EASE_OUT: [number, number, number, number] = [0.25, 1, 0.5, 1];

/** 行が別の位置へ移るとき（下の行が詰まる動きも含む） */
export const LAYOUT_TRANSITION: Transition = { duration: DURATION.base, ease: EASE_OUT };

/**
 * Motion の機能一式は後から読み込む（最初の JS には `m` の部品だけを入れる）。
 * アプリの外枠の LazyMotion に渡す。届くまでの最初の描画は動かないので、見た目は変わらない
 */
export const motionFeatures = defer(() =>
  import("./motion-features").then((module) => module.default),
);
