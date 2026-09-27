import { type DateChange, placementAfter } from "@/data/actions";
import { addDays } from "@/data/logical-day";
import { daysBetween } from "@/features/dates/labels";
import { doOnOf, type OpenBucket } from "./timeline-model";

/**
 * 棒のドラッグ（ポインタのイベントで作り、日単位でぴったり止める）。どこをつかんだかで変えるものが決まる
 * - start：棒の左端。やる日を変える（d と同じ決まり。今日か過去の日なら今日へ）
 * - end：棒の右端（右端の◆を含む）。締切を変える（⇧D と同じ決まり）。締切のない1日の棒なら、締切が付く
 * - move：棒の真ん中。やる日と締切を同じ日数だけずらす（1つの操作）
 * - deadline：◆だけのタスクの◆と、やる日より前にある離れた◆。締切を変える
 * 棒は裏返らない：左端は締切の日より右へ、右端はやる日より左へは引けない（ドラッグの途中で止める）。
 * 離したあとの置き場と日付（締切による今日への到着を含む）は、データ層の placementAfter で決める
 * （操作と同じ決まりを使い、ドラッグ中の形を、確定したあとの形とそろえる）
 */
export type DragEdge = "start" | "end" | "move" | "deadline";

/** ドラッグの対象：未完了のタスクの置き場と日付 */
export type DragSubject = {
  bucket: OpenBucket;
  scheduledOn: string | null;
  deadlineOn: string | null;
};

/** 締切がやる日以降にあって、棒の右端に付いているときの締切 */
function attachedDeadline(doOn: string | null, deadlineOn: string | null): string | null {
  return doOn !== null && deadlineOn !== null && deadlineOn >= doOn ? deadlineOn : null;
}

/** 引いた日数を、棒が裏返らない範囲に収める */
export function clampDragDays(
  edge: DragEdge,
  subject: DragSubject,
  days: number,
  today: string,
): number {
  const doOn = doOnOf(subject.bucket, subject.scheduledOn, today);
  if (doOn === null) return days;
  const attached = attachedDeadline(doOn, subject.deadlineOn);
  if (edge === "start" && attached !== null) return Math.min(days, daysBetween(doOn, attached));
  if (edge === "end") return Math.max(days, daysBetween(attached ?? doOn, doOn));
  return days;
}

/** days 日（収めたあと）引いて離したときに送る日付の操作。変えるものがなければ null */
export function dragChange(
  edge: DragEdge,
  subject: DragSubject,
  days: number,
  today: string,
): DateChange | null {
  if (days === 0) return null;
  const doOn = doOnOf(subject.bucket, subject.scheduledOn, today);
  switch (edge) {
    case "start":
      return doOn === null ? null : { kind: "schedule", on: addDays(doOn, days) };
    case "end":
      return doOn === null
        ? null
        : {
            kind: "deadline",
            on: addDays(attachedDeadline(doOn, subject.deadlineOn) ?? doOn, days),
          };
    case "move":
      return { kind: "shift", days };
    case "deadline":
      return subject.deadlineOn === null
        ? null
        : { kind: "deadline", on: addDays(subject.deadlineOn, days) };
  }
}

/**
 * days 日（収めたあと）引いて離したときの、やる日と締切（ドラッグ中に描く形）。
 * 今日か過去のやる日は今日に、予定・あとでで締切が今日以前になれば今日へ移る（データ層と同じ決まり）
 */
export function draggedDates(
  edge: DragEdge,
  subject: DragSubject,
  days: number,
  today: string,
): { doOn: string | null; deadlineOn: string | null } {
  const change = dragChange(edge, subject, days, today);
  const after =
    change === null ? subject : placementAfter({ ...subject, completedAt: null }, change, today);
  return { doOn: doOnOf(after.bucket, after.scheduledOn, today), deadlineOn: after.deadlineOn };
}
