import { addDays } from "@/data/logical-day";
import { daysBetween } from "@/features/dates/labels";

/**
 * 棒のドラッグ（ポインタのイベントで作り、日単位でぴったり止める）。どこをつかんだかで変えるものが決まる
 * - start：棒の左端。やる日を変える（d と同じ決まり。今日か過去の日なら今日へ）
 * - end：棒の右端（右端の◆を含む）。締切を変える（⇧D と同じ決まり）。締切のない1日の棒なら、締切が付く
 * - move：棒の真ん中。やる日と締切を同じ日数だけずらす（1つの操作）
 * - deadline：◆だけのタスクの◆と、やる日より前にある離れた◆。締切を変える
 * 棒は裏返らない：左端は締切の日より右へ、右端はやる日より左へは引けない（ドラッグの途中で止める）
 */
export type DragEdge = "start" | "end" | "move" | "deadline";

/** ドラッグの対象の日付（やる日は、予定は予定の日付、今日のタスクは今日） */
export type DragDates = { doOn: string | null; deadlineOn: string | null };

/** 締切がやる日以降にあって、棒の右端に付いているか */
function hasAttachedDeadline({ doOn, deadlineOn }: DragDates): boolean {
  return doOn !== null && deadlineOn !== null && deadlineOn >= doOn;
}

/** 引いた日数を、棒が裏返らない範囲に収める */
export function clampDragDays(edge: DragEdge, dates: DragDates, days: number): number {
  const { doOn, deadlineOn } = dates;
  if (edge === "start" && doOn !== null && deadlineOn !== null && hasAttachedDeadline(dates)) {
    return Math.min(days, daysBetween(doOn, deadlineOn));
  }
  if (edge === "end" && doOn !== null) {
    const base = hasAttachedDeadline(dates) && deadlineOn !== null ? deadlineOn : doOn;
    return Math.max(days, daysBetween(base, doOn));
  }
  return days;
}

/**
 * days 日（収めたあと）引いたときの、送る先の日付（プレビューに出す形）。今日か過去のやる日は今日になる
 * （d と同じ決まり。締切で今日へ移るかは、データ層が決める）
 */
export function draggedDates(
  edge: DragEdge,
  dates: DragDates,
  days: number,
  today: string,
): DragDates {
  const { doOn, deadlineOn } = dates;
  const atLeastToday = (date: string) => (date < today ? today : date);
  switch (edge) {
    case "start":
      return { doOn: doOn === null ? null : atLeastToday(addDays(doOn, days)), deadlineOn };
    case "end": {
      if (doOn === null) return dates;
      const base = hasAttachedDeadline(dates) && deadlineOn !== null ? deadlineOn : doOn;
      return { doOn, deadlineOn: addDays(base, days) };
    }
    case "move":
      return {
        doOn: doOn === null ? null : atLeastToday(addDays(doOn, days)),
        deadlineOn: deadlineOn === null ? null : addDays(deadlineOn, days),
      };
    case "deadline":
      return { doOn, deadlineOn: deadlineOn === null ? null : addDays(deadlineOn, days) };
  }
}
