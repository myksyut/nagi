import type { Placement } from "@/data";

/**
 * 並べ替えの計算（⌥↑↓ とドラッグ）。まとまりの今の並び（id の列）と動かす行から、
 * データ層の reorderTasks に渡す「どの行を、見えているどの行のあいだへ入れるか」を作る。
 * 動かさない行どうしの順は変えない。変わらないときは null
 */

/** 新しい並びから、動かした行の連なりごとに、前後の動かさない行を拾う */
function placementsFor(order: readonly string[], moving: ReadonlySet<string>): Placement[] {
  const placements: Placement[] = [];
  let run: string[] = [];
  let after: string | null = null;
  for (const id of order) {
    if (moving.has(id)) {
      run.push(id);
      continue;
    }
    if (run.length > 0) placements.push({ ids: run, after, before: id });
    run = [];
    after = id;
  }
  if (run.length > 0) placements.push({ ids: run, after, before: null });
  return placements;
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * ⌥↑（delta = -1）・⌥↓（delta = 1）：選んだ行を、まとめて1つ上・下へ。
 * 離れて選んだ行は、それぞれが隣の動かさない行を1つ越える。どれかがもう端にあれば動かさない
 */
export function planStep(
  order: readonly string[],
  selected: ReadonlySet<string>,
  delta: -1 | 1,
): Placement[] | null {
  const moving = new Set(order.filter((id) => selected.has(id)));
  if (moving.size === 0 || moving.size === order.length) return null;
  const next = delta < 0 ? [...order] : [...order].reverse();
  if (moving.has(next[0] ?? "")) return null;
  for (let i = 1; i < next.length; i++) {
    const current = next[i];
    const previous = next[i - 1];
    if (current === undefined || previous === undefined) continue;
    if (moving.has(current) && !moving.has(previous)) {
      next[i - 1] = current;
      next[i] = previous;
    }
  }
  if (delta > 0) next.reverse();
  return placementsFor(next, moving);
}

/**
 * ドラッグで落とした：動かす行（今の並びの順で）を、target の行の前（edge = "before"）か後ろへまとめて入れる
 */
export function planDrop(
  order: readonly string[],
  movingIds: readonly string[],
  target: string,
  edge: "before" | "after",
): Placement[] | null {
  const moving = new Set(movingIds);
  if (moving.has(target) || !order.includes(target)) return null;
  const rest = order.filter((id) => !moving.has(id));
  const at = rest.indexOf(target) + (edge === "after" ? 1 : 0);
  const block = order.filter((id) => moving.has(id));
  if (block.length === 0) return null;
  const next = [...rest.slice(0, at), ...block, ...rest.slice(at)];
  if (sameOrder(next, order)) return null;
  return placementsFor(next, moving);
}
