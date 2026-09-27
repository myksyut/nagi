import { MotionGlobalConfig } from "motion/react";
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * prefers-reduced-motion のときは、Motion の動きをすべて止める（行の出入りと詰まり、opacity、丸のチェックの pathLength）。
 * Motion の `reducedMotion="user"` は transform と layout しか止めないので、全体の設定で飛ばす。
 * CSS の動き（トースト、ポップオーバー、矢印、ダイアログの背景、border-beam）は styles.css の同じメディアクエリで止める。
 * どちらも色の変化だけは残す。設定が途中で変わっても追いかける。戻り値を呼ぶとやめる
 */
export function followReducedMotion(win: Window = window): () => void {
  const query = win.matchMedia?.(QUERY);
  if (!query) return () => {};
  // すでに飛ばす設定なら（テストなど）、そのまま残す
  const base = MotionGlobalConfig.skipAnimations;
  const apply = () => {
    MotionGlobalConfig.skipAnimations = base || query.matches;
  };
  apply();
  query.addEventListener("change", apply);
  return () => {
    query.removeEventListener("change", apply);
    MotionGlobalConfig.skipAnimations = base;
  };
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia?.(QUERY);
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/**
 * prefers-reduced-motion が変わったら onChange を呼ぶ（部品の外の飾りが、動いている途中で設定が変わったときに外すため）。
 * 戻り値を呼ぶとやめる
 */
export function watchReducedMotion(
  onChange: (reduced: boolean) => void,
  win: Window = window,
): () => void {
  const query = win.matchMedia?.(QUERY);
  if (!query) return () => {};
  const listener = () => onChange(query.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

/** 今 prefers-reduced-motion か（部品の外で、動く飾りを置くかどうかを決めるとき） */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.(QUERY).matches ?? false;
}

/** prefers-reduced-motion か（動きのある飾りを出すかどうかを決めるとき）。設定が変わったら描き直す */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
