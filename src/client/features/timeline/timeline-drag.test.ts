import { describe, expect, it } from "vitest";
import { clampDragDays, type DragSubject, dragChange, draggedDates } from "./timeline-drag";

/**
 * チケット14：棒のドラッグの日数の決め方（timeline-drag.ts）。完了の条件2「左端・右端・真ん中のドラッグで、
 * それぞれやる日・締切・両方が変わり」の単体（clampDragDays・dragChange・draggedDates）。裏返らない決まりと、
 * 「過去の日へ左端を引くと今日へ入る」（完了の条件3）、締切による今日への到着（14-修正1）のプレビューの形をここで確かめる
 */

const TODAY = "2026-09-27";

/** 予定のタスク（やる日＝予定の日付） */
function scheduled(on: string, deadlineOn: string | null): DragSubject {
  return { bucket: "scheduled", scheduledOn: on, deadlineOn };
}

describe("clampDragDays：棒が裏返らない範囲に収める", () => {
  it("左端（start）：締切が付いていれば、締切の日より右へは行かない", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(clampDragDays("start", subject, 3, TODAY)).toBe(3);
    expect(clampDragDays("start", subject, 4, TODAY)).toBe(4);
    expect(clampDragDays("start", subject, 10, TODAY)).toBe(4); // 10/1 + 4 = 10/5（締切と同じ日まで）
  });

  it("左端：締切がない、または締切がやる日より前（離れた◆）なら、右への制限はない", () => {
    expect(clampDragDays("start", scheduled("2026-10-01", null), 100, TODAY)).toBe(100);
    expect(clampDragDays("start", scheduled("2026-10-05", "2026-10-01"), 100, TODAY)).toBe(100);
  });

  it("右端（end）：やる日より左へは行かない", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(clampDragDays("end", subject, -4, TODAY)).toBe(-4); // 10/5 - 4 = 10/1（やる日と同じ日まで）
    expect(clampDragDays("end", subject, -10, TODAY)).toBe(-4);
  });

  it("右端：締切のない1日の棒と、離れた◆（まだ付いていない）は、やる日を基準に制限する", () => {
    for (const subject of [scheduled("2026-10-01", null), scheduled("2026-10-05", "2026-10-01")]) {
      expect(clampDragDays("end", subject, 0, TODAY)).toBe(0);
      expect(clampDragDays("end", subject, -5, TODAY)).toBe(0);
      expect(clampDragDays("end", subject, 5, TODAY)).toBe(5);
    }
  });

  it("今日のタスクのやる日は今日（右端は今日より左へ行かない）", () => {
    const today: DragSubject = { bucket: "today", scheduledOn: null, deadlineOn: "2026-09-30" };
    expect(clampDragDays("end", today, -10, TODAY)).toBe(-3);
    expect(clampDragDays("start", today, 10, TODAY)).toBe(3);
  });

  it("真ん中（move）・◆（deadline）は制限しない", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(clampDragDays("move", subject, 100, TODAY)).toBe(100);
    expect(clampDragDays("move", subject, -100, TODAY)).toBe(-100);
    expect(clampDragDays("deadline", subject, -100, TODAY)).toBe(-100);
  });
});

describe("dragChange：離したときに送る日付の操作", () => {
  it("左端は d、右端と◆は ⇧D、真ん中はずらす。0 日なら送らない", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(dragChange("start", subject, 2, TODAY)).toEqual({ kind: "schedule", on: "2026-10-03" });
    expect(dragChange("end", subject, 2, TODAY)).toEqual({ kind: "deadline", on: "2026-10-07" });
    expect(dragChange("deadline", subject, -2, TODAY)).toEqual({
      kind: "deadline",
      on: "2026-10-03",
    });
    expect(dragChange("move", subject, 2, TODAY)).toEqual({ kind: "shift", days: 2 });
    expect(dragChange("move", subject, 0, TODAY)).toBeNull();
  });

  it("締切のない1日の棒の右端は、やる日から数えて締切を付ける", () => {
    expect(dragChange("end", scheduled("2026-10-01", null), 2, TODAY)).toEqual({
      kind: "deadline",
      on: "2026-10-03",
    });
  });
});

describe("draggedDates：離したときの、やる日と締切（プレビュー。データ層と同じ決まり）", () => {
  it("左端：やる日だけ動く。今日か過去になれば今日に丸められる", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(draggedDates("start", subject, 2, TODAY)).toEqual({
      doOn: "2026-10-03",
      deadlineOn: "2026-10-05",
    });
    expect(draggedDates("start", subject, -100, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-10-05",
    });
  });

  it("右端：締切だけ動く（付いている締切、締切のない棒と離れた◆はやる日から）", () => {
    expect(draggedDates("end", scheduled("2026-10-01", "2026-10-05"), 3, TODAY)).toEqual({
      doOn: "2026-10-01",
      deadlineOn: "2026-10-08",
    });
    expect(draggedDates("end", scheduled("2026-10-01", null), 2, TODAY)).toEqual({
      doOn: "2026-10-01",
      deadlineOn: "2026-10-03",
    });
    expect(draggedDates("end", scheduled("2026-10-05", "2026-10-01"), 2, TODAY)).toEqual({
      doOn: "2026-10-05",
      deadlineOn: "2026-10-07",
    });
  });

  it("真ん中：やる日と締切が同じ日数だけ動く。やる日が今日以前になれば今日に丸められる（締切はそのまま動く）", () => {
    const subject = scheduled("2026-10-01", "2026-10-05");
    expect(draggedDates("move", subject, 3, TODAY)).toEqual({
      doOn: "2026-10-04",
      deadlineOn: "2026-10-08",
    });
    expect(draggedDates("move", subject, -100, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-06-27",
    });
  });

  it("受信箱の◆：締切だけ動く（今日以前にしても受信箱のまま）", () => {
    const inbox: DragSubject = { bucket: "inbox", scheduledOn: null, deadlineOn: "2026-10-05" };
    expect(draggedDates("deadline", inbox, 5, TODAY)).toEqual({
      doOn: null,
      deadlineOn: "2026-10-10",
    });
    expect(draggedDates("deadline", inbox, -10, TODAY)).toEqual({
      doOn: null,
      deadlineOn: "2026-09-25",
    });
  });

  it("あとでの◆を今日以前へ引くと、今日へ到着する（やる日が今日になる）", () => {
    const later: DragSubject = { bucket: "later", scheduledOn: null, deadlineOn: "2026-10-01" };
    expect(draggedDates("deadline", later, -4, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: TODAY,
    });
    expect(draggedDates("deadline", later, -1, TODAY)).toEqual({
      doOn: null,
      deadlineOn: "2026-09-30",
    });
  });

  it("予定の棒の離れた◆を今日より前へ引くと、今日へ到着する（予定の日付は外れる）", () => {
    expect(draggedDates("deadline", scheduled("2026-10-10", "2026-10-01"), -5, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-09-26",
    });
  });

  it("真ん中：予定の日付は今日より後のまま、締切だけ今日以前になると、今日へ到着する", () => {
    expect(draggedDates("move", scheduled("2026-10-10", "2026-10-01"), -6, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-09-25",
    });
  });
});
