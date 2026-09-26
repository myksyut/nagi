import { describe, expect, it } from "vitest";
import { LOGBOOK_PAGE_SIZE, nextLogbookLimit } from "./logbook-screen";

/** 4-修正1の4：完了ログの続きの表示の上限は、全部表示していたら増やさない */
describe("nextLogbookLimit", () => {
  it("まだ隠れている行があれば、1ページぶん増やす", () => {
    expect(nextLogbookLimit(LOGBOOK_PAGE_SIZE, LOGBOOK_PAGE_SIZE * 3)).toBe(LOGBOOK_PAGE_SIZE * 2);
  });

  it("全部表示していたら増やさない", () => {
    expect(nextLogbookLimit(LOGBOOK_PAGE_SIZE, LOGBOOK_PAGE_SIZE)).toBe(LOGBOOK_PAGE_SIZE);
    expect(nextLogbookLimit(LOGBOOK_PAGE_SIZE, 10)).toBe(LOGBOOK_PAGE_SIZE);
  });

  it("上限を超えたところで、次の増分がちょうど総件数と一致しても増やしすぎない", () => {
    const total = LOGBOOK_PAGE_SIZE + 5;
    expect(nextLogbookLimit(LOGBOOK_PAGE_SIZE, total)).toBe(LOGBOOK_PAGE_SIZE * 2);
    expect(nextLogbookLimit(LOGBOOK_PAGE_SIZE * 2, total)).toBe(LOGBOOK_PAGE_SIZE * 2);
  });
});
