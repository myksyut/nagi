import { prefersReducedMotion } from "@/lib/reduced-motion";

/**
 * 完了の光の輪。完了にした行の丸から、光の輪が一瞬（300ms）広がって消える（Core Flows「フロー4」）。
 * 行はすぐ「完了 N件」へ抜けていく（150ms でフェード）ので、輪は行の中ではなく、画面に固定した要素として
 * 丸のあった位置に置き、動き終わったら外す。React の描き直しはしない（完了のキーを重くしない）。
 * 動かすのは輪の要素の transform（scale）と opacity だけ（styles.css の .complete-ring）。
 * prefers-reduced-motion のときは置かない
 */

/** 輪の動きの長さ（styles.css の --duration-complete-ring と同じ） */
export const COMPLETE_RING_MS = 300;

/** 一度に出す輪の数の上限（まとめて完了したとき。見えている行だけに出す） */
const MAX_RINGS = 20;

/** 丸（CompleteButton）に付ける印。値はタスクの id */
export const COMPLETE_FOR_ATTRIBUTE = "data-complete-for";

export type CompletionRings = { play(): void };

const NONE: CompletionRings = { play() {} };

/**
 * 完了にする前に、丸の位置を読んでおく（完了のあと、行はすぐ動く）。
 * 操作が受け付けられたら play() で輪を出す（オフラインなどで断られたら出さない）
 */
export function prepareCompletionRings(
  ids: readonly string[],
  doc: Document = document,
): CompletionRings {
  if (ids.length === 0 || prefersReducedMotion()) return NONE;
  const targets = new Set(ids);
  const viewHeight = doc.defaultView?.innerHeight ?? 0;
  const rects: DOMRect[] = [];
  for (const element of doc.querySelectorAll(`[${COMPLETE_FOR_ATTRIBUTE}]`)) {
    if (rects.length >= MAX_RINGS) break;
    if (!targets.has(element.getAttribute(COMPLETE_FOR_ATTRIBUTE) ?? "")) continue;
    const rect = element.getBoundingClientRect();
    // 画面の外の行には出さない
    if (rect.bottom < 0 || rect.top > viewHeight) continue;
    rects.push(rect);
  }
  if (rects.length === 0) return NONE;
  return {
    play() {
      for (const rect of rects) spawnRing(doc, rect);
    },
  };
}

function spawnRing(doc: Document, rect: DOMRect): void {
  const ring = doc.createElement("span");
  ring.className = "complete-ring";
  ring.setAttribute("aria-hidden", "true");
  ring.setAttribute("data-complete-ring", "");
  ring.style.left = `${rect.left}px`;
  ring.style.top = `${rect.top}px`;
  ring.style.width = `${rect.width}px`;
  ring.style.height = `${rect.height}px`;
  doc.body.append(ring);
  const remove = () => ring.remove();
  ring.addEventListener("animationend", remove, { once: true });
  // animationend が届かないとき（タブが裏にある・途中で動きを止める設定に変えた）も必ず外す
  doc.defaultView?.setTimeout(remove, COMPLETE_RING_MS + 100);
}
