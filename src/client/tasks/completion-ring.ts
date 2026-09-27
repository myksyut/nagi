import { prefersReducedMotion, watchReducedMotion } from "@/lib/reduced-motion";

/**
 * 完了の光の輪。完了にした行の丸から、光の輪が一瞬（300ms）広がって消える（Core Flows「フロー4」）。
 * 行はすぐ「完了 N件」へ抜けていく（150ms でフェード）ので、輪は行の中ではなく、画面に固定した要素として
 * 丸のあった位置に置き、動き終わったら外す。React の描き直しはしない（完了のキーを重くしない）。
 * 動かすのは輪の要素の transform（scale）と opacity だけ（styles.css の .complete-ring）。
 * prefers-reduced-motion のときは置かない。動いている途中で設定が変わったら、出ている輪をすぐ外す
 */

/** 輪の動きの長さ（styles.css の --duration-complete-ring と同じ） */
export const COMPLETE_RING_MS = 300;

/** 一度に出す輪の数の上限（まとめて完了したとき。見えている行だけに出す） */
export const MAX_RINGS = 20;

/** 丸（CompleteButton）の要素の id。完了にしたタスクの id から、丸を直接引く */
export function completeButtonId(taskId: string): string {
  return `complete-${taskId}`;
}

/**
 * 完了にしたタスクの丸から、光の輪を出す。操作が受け付けられた直後に呼ぶ
 * （断られた操作では呼ばない。受け付けた直後は、React がまだ描き直していないので、丸は元の位置にある）。
 * 丸は id から直接引き、画面に見えている丸だけを、最大 MAX_RINGS 個読む。
 * ids は上から見えている順（選んでいる行の順）なので、画面の下に外れた丸が出てきたら、それより後ろは読まない
 */
export function playCompletionRings(ids: readonly string[], doc: Document = document): void {
  if (ids.length === 0 || prefersReducedMotion()) return;
  const viewHeight = doc.defaultView?.innerHeight ?? 0;
  let shown = 0;
  for (const id of ids) {
    if (shown >= MAX_RINGS) break;
    const button = doc.getElementById(completeButtonId(id));
    if (!button) continue;
    const rect = button.getBoundingClientRect();
    // 画面より上の丸は飛ばし、画面より下の丸が出てきたら終わる
    if (rect.bottom < 0) continue;
    if (rect.top > viewHeight) break;
    spawnRing(doc, rect);
    shown++;
  }
}

/** 出ている輪（設定が reduced motion に変わったら、まとめて外す） */
const liveRings = new Set<HTMLElement>();
let stopWatching: (() => void) | null = null;

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
  liveRings.add(ring);
  const win = doc.defaultView;
  if (win && !stopWatching) {
    stopWatching = watchReducedMotion((reduced) => {
      if (reduced) for (const live of [...liveRings]) removeRing(live);
    }, win);
  }
  ring.addEventListener("animationend", () => removeRing(ring), { once: true });
  // animationend が届かないとき（タブが裏にある）も必ず外す
  win?.setTimeout(() => removeRing(ring), COMPLETE_RING_MS + 100);
}

function removeRing(ring: HTMLElement): void {
  ring.remove();
  liveRings.delete(ring);
  if (liveRings.size === 0 && stopWatching) {
    stopWatching();
    stopWatching = null;
  }
}
