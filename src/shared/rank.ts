import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * 置き場の中の並び順キー（fractional index）。文字列の大小（コード単位の順）で並ぶ。
 * localeCompare は使わない（SQLite の既定の比較と同じ順にするため）
 */

const RANK_PATTERN = /^[0-9A-Za-z]+$/;
/**
 * 並び順キーの長さの上限（画面とサーバーで共通）。同じ2行のあいだへ別々の行を入れ続けると、
 * 6 回ほどで 1 文字ずつ伸びる（128 文字では 757 回目で届いた）。振り直しはしないので、長めにとる
 */
export const MAX_RANK_LENGTH = 1024;

/** 並び順キーとして正しい形か（サーバーで保存する前にも確かめる） */
export function isValidRank(rank: string): boolean {
  if (rank.length === 0 || rank.length > MAX_RANK_LENGTH || !RANK_PATTERN.test(rank)) {
    return false;
  }
  try {
    generateKeyBetween(rank, null);
    return true;
  } catch {
    return false;
  }
}

/** rank の順。rank が重なったら（2つのタブで同じ位置に入れたとき）id の順 */
export function compareRank(
  a: { rank: string; id: string },
  b: { rank: string; id: string },
): number {
  if (a.rank !== b.rank) return a.rank < b.rank ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** after が before 以下のとき（rank が重なっているとき）は、上の端を外して before の後ろに作る */
function upperBound(before: string | null, after: string | null): string | null {
  return before !== null && after !== null && after <= before ? null : after;
}

/** before の後ろ、after の前に入る n 個のキー（小さい順）。null は端（先頭・末尾） */
export function ranksBetween(before: string | null, after: string | null, n: number): string[] {
  return generateNKeysBetween(before, upperBound(before, after), n);
}

/** before の後ろ、after の前に入るキー。null は端（先頭・末尾） */
export function rankBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, upperBound(before, after));
}

/** 一番下に入れるときのキー。last はいまの最後の rank（空なら null） */
export function rankAfter(last: string | null): string {
  return rankBetween(last, null);
}

/** 一番上に入れるときのキー。first はいまの最初の rank（空なら null） */
export function rankBefore(first: string | null): string {
  return rankBetween(null, first);
}

/**
 * 日付の到来や締切で今日に入る n 件のキー（小さい順。入れる順に割り当てる）。
 * 位置は「今日来たタスク（arrivedOn が today）の後ろ、それ以外の今日のタスクの前」。
 * 今日来たタスクがなければ一番上。todayTasks は今日の置き場にある未完了・未削除のタスク
 */
export function arrivalRanks(
  todayTasks: readonly { id: string; rank: string; arrivedOn: string | null }[],
  today: string,
  n: number,
): string[] {
  if (n === 0) return [];
  const sorted = [...todayTasks].sort(compareRank);
  const lastArrived = sorted.findLastIndex((task) => task.arrivedOn === today);
  const before = sorted[lastArrived]?.rank ?? null;
  const after =
    sorted.slice(lastArrived + 1).find((task) => before === null || task.rank > before)?.rank ??
    null;
  return ranksBetween(before, after, n);
}
