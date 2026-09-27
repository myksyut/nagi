import { describe, expect, it } from "vitest";
import { clampDragDays, type DragDates, draggedDates } from "./timeline-drag";

/**
 * チケット14：棒のドラッグの日数の決め方（timeline-drag.ts）。完了の条件2「左端・右端・真ん中のドラッグで、
 * それぞれやる日・締切・両方が変わり」の単体（clampDragDays・draggedDates）。裏返らない決まりと、
 * 「過去の日へ左端を引くと今日へ入る」（完了の条件3）のプレビューの形をここで確かめる
 */

const TODAY = "2026-09-27";

describe("clampDragDays：棒が裏返らない範囲に収める", () => {
  it("左端（start）：締切が付いていれば、締切の日より右へは行かない", () => {
    const dates: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(clampDragDays("start", dates, 3)).toBe(3);
    expect(clampDragDays("start", dates, 4)).toBe(4);
    expect(clampDragDays("start", dates, 10)).toBe(4); // 10/1 + 4 = 10/5（締切と同じ日まで）
  });

  it("左端：締切がない、または締切がやる日より前（離れた◆）なら、右への制限はない", () => {
    const noDeadline: DragDates = { doOn: "2026-10-01", deadlineOn: null };
    expect(clampDragDays("start", noDeadline, 100)).toBe(100);
    const looseDeadline: DragDates = { doOn: "2026-10-05", deadlineOn: "2026-10-01" };
    expect(clampDragDays("start", looseDeadline, 100)).toBe(100);
  });

  it("右端（end）：やる日より左へは行かない", () => {
    const withDeadline: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(clampDragDays("end", withDeadline, -4)).toBe(-4); // 10/5 - 4 = 10/1（やる日と同じ日まで）
    expect(clampDragDays("end", withDeadline, -10)).toBe(-4);
  });

  it("右端：締切のない1日の棒は、やる日を基準に制限する", () => {
    const noDeadline: DragDates = { doOn: "2026-10-01", deadlineOn: null };
    expect(clampDragDays("end", noDeadline, 0)).toBe(0);
    expect(clampDragDays("end", noDeadline, -5)).toBe(0); // やる日より左へは行けない
    expect(clampDragDays("end", noDeadline, 5)).toBe(5);
  });

  it("右端：離れた◆（締切がやる日より前）は、まだ付いていないので、やる日そのものを基準に制限する", () => {
    const looseDeadline: DragDates = { doOn: "2026-10-05", deadlineOn: "2026-10-01" };
    expect(clampDragDays("end", looseDeadline, 0)).toBe(0);
    expect(clampDragDays("end", looseDeadline, -5)).toBe(0); // やる日より左へは行けない
    expect(clampDragDays("end", looseDeadline, 5)).toBe(5);
  });

  it("真ん中（move）・◆だけ（deadline）は制限しない", () => {
    const dates: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(clampDragDays("move", dates, 100)).toBe(100);
    expect(clampDragDays("move", dates, -100)).toBe(-100);
    expect(clampDragDays("deadline", dates, -100)).toBe(-100);
  });
});

describe("draggedDates：ドラッグの先の日付（プレビュー）", () => {
  it("左端：やる日だけ動く。今日か過去になれば今日に丸められる", () => {
    const dates: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(draggedDates("start", dates, 2, TODAY)).toEqual({
      doOn: "2026-10-03",
      deadlineOn: "2026-10-05",
    });
    expect(draggedDates("start", dates, -100, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-10-05",
    });
  });

  it("右端：締切だけ動く（付いている締切、または締切のない棒の1日目から）", () => {
    const withDeadline: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(draggedDates("end", withDeadline, 3, TODAY)).toEqual({
      doOn: "2026-10-01",
      deadlineOn: "2026-10-08",
    });
    const noDeadline: DragDates = { doOn: "2026-10-01", deadlineOn: null };
    expect(draggedDates("end", noDeadline, 2, TODAY)).toEqual({
      doOn: "2026-10-01",
      deadlineOn: "2026-10-03",
    });
  });

  it("右端：離れた◆（まだ付いていない）は、やる日から動いて締切が付く", () => {
    const looseDeadline: DragDates = { doOn: "2026-10-05", deadlineOn: "2026-10-01" };
    expect(draggedDates("end", looseDeadline, 2, TODAY)).toEqual({
      doOn: "2026-10-05",
      deadlineOn: "2026-10-07",
    });
  });

  it("真ん中：やる日と締切が同じ日数だけ動く。やる日が今日以前になれば今日に丸められる（締切はそのまま動く）", () => {
    const dates: DragDates = { doOn: "2026-10-01", deadlineOn: "2026-10-05" };
    expect(draggedDates("move", dates, 3, TODAY)).toEqual({
      doOn: "2026-10-04",
      deadlineOn: "2026-10-08",
    });
    expect(draggedDates("move", dates, -100, TODAY)).toEqual({
      doOn: TODAY,
      deadlineOn: "2026-06-27",
    });
  });

  it("◆だけ（やる日なし）：締切だけ動く", () => {
    const dates: DragDates = { doOn: null, deadlineOn: "2026-10-05" };
    expect(draggedDates("deadline", dates, 5, TODAY)).toEqual({
      doOn: null,
      deadlineOn: "2026-10-10",
    });
  });
});
