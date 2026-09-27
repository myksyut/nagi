import { describe, expect, it } from "vitest";
import { parseDateInput } from "./date-input";

/**
 * 日本語の日付パーサーのテスト。チケット5と Core Flows に出てくる例をすべて確かめる。
 * 基準日は日曜 2026-09-27 と月曜 2026-09-28（週の始まりの確認用）を使い分ける
 */

const SUNDAY = "2026-09-27";
const MONDAY = "2026-09-28";

describe("相対日", () => {
  it.each([
    ["今日", SUNDAY, SUNDAY],
    ["きょう", SUNDAY, SUNDAY],
    ["本日", SUNDAY, SUNDAY],
    ["明日", SUNDAY, "2026-09-28"],
    ["あした", SUNDAY, "2026-09-28"],
    ["あす", SUNDAY, "2026-09-28"],
    ["明後日", SUNDAY, "2026-09-29"],
    ["あさって", SUNDAY, "2026-09-29"],
    ["明々後日", SUNDAY, "2026-09-30"],
    ["しあさって", SUNDAY, "2026-09-30"],
  ])("%s（%s 基準）→ %s", (text, today, expected) => {
    expect(parseDateInput(text, today)).toBe(expected);
  });
});

describe("曜日だけ：今日より後の一番近い日", () => {
  it("月曜 9/28 に「月曜」→ 来週の月曜 10/5（今日と同じ曜日は7日後）", () => {
    expect(parseDateInput("月曜", MONDAY)).toBe("2026-10-05");
  });

  it("月曜 9/28 に「金曜」→ 同じ週の金曜 10/2", () => {
    expect(parseDateInput("金曜", MONDAY)).toBe("2026-10-02");
  });

  it("「金」「金曜」「金曜日」はどれも同じ結果", () => {
    expect(parseDateInput("金", MONDAY)).toBe("2026-10-02");
    expect(parseDateInput("金曜", MONDAY)).toBe("2026-10-02");
    expect(parseDateInput("金曜日", MONDAY)).toBe("2026-10-02");
  });
});

describe("週＋曜日：週は月曜始まり", () => {
  it("日曜 9/27 に「来週月曜」→ 2026-09-28", () => {
    expect(parseDateInput("来週月曜", SUNDAY)).toBe("2026-09-28");
  });

  it("月曜 9/28 に「来週月曜」→ 2026-10-05", () => {
    expect(parseDateInput("来週月曜", MONDAY)).toBe("2026-10-05");
  });

  it("月曜 9/28 に「来週日曜」→ 2026-10-11", () => {
    expect(parseDateInput("来週日曜", MONDAY)).toBe("2026-10-11");
  });

  it("日曜 9/27 に「来週日曜」→ 2026-10-04", () => {
    expect(parseDateInput("来週日曜", SUNDAY)).toBe("2026-10-04");
  });

  it("「来週の月曜日」のような書き方も読める", () => {
    expect(parseDateInput("来週の月曜日", SUNDAY)).toBe("2026-09-28");
  });

  it("今週の過ぎた曜日は、そのまま過去の日付になる", () => {
    // 日曜 9/27 の「今週」（月曜始まり）は 9/21〜9/27 なので、今週月曜は過去の 9/21
    expect(parseDateInput("今週月曜", SUNDAY)).toBe("2026-09-21");
  });

  it("今週の先の曜日は、その週の中の日になる", () => {
    // 月曜 9/28 の「今週」（月曜始まり）は 9/28〜10/4 なので、今週日曜は 10/4
    expect(parseDateInput("今週日曜", MONDAY)).toBe("2026-10-04");
  });

  it("再来週の月曜", () => {
    expect(parseDateInput("再来週月曜", MONDAY)).toBe("2026-10-12");
  });
});

describe("N日後・N週間後", () => {
  it("3日後", () => {
    expect(parseDateInput("3日後", SUNDAY)).toBe("2026-09-30");
  });

  it("2週間後", () => {
    expect(parseDateInput("2週間後", SUNDAY)).toBe("2026-10-11");
  });

  it("全角の数字も読める（３日後）", () => {
    expect(parseDateInput("３日後", SUNDAY)).toBe("2026-09-30");
  });

  it("大きすぎる N は読めない", () => {
    expect(parseDateInput("99999日後", SUNDAY)).toBeNull();
  });
});

describe("月/日：今日以降で一番近いその日", () => {
  it("10/3（今日より先）", () => {
    expect(parseDateInput("10/3", SUNDAY)).toBe("2026-10-03");
  });

  it("全角のスラッシュと数字（１０／３）", () => {
    expect(parseDateInput("１０／３", SUNDAY)).toBe("2026-10-03");
  });

  it("今日ちょうど（9/27）はその日", () => {
    expect(parseDateInput("9/27", SUNDAY)).toBe("2026-09-27");
  });

  it("過ぎていれば来年（9/27 に「9/26」→ 2027-09-26）", () => {
    expect(parseDateInput("9/26", SUNDAY)).toBe("2027-09-26");
  });

  it("「10月3日」の書き方でも読める", () => {
    expect(parseDateInput("10月3日", SUNDAY)).toBe("2026-10-03");
  });

  it("表示の形の曜日「10月5日(月)」も読み飛ばして読める", () => {
    expect(parseDateInput("10月5日(月)", SUNDAY)).toBe("2026-10-05");
  });

  it("「金曜まで」「までに」「に」の後置きは読み飛ばす", () => {
    expect(parseDateInput("金曜まで", MONDAY)).toBe("2026-10-02");
    expect(parseDateInput("10/3までに", SUNDAY)).toBe("2026-10-03");
    expect(parseDateInput("10/3に", SUNDAY)).toBe("2026-10-03");
  });

  it("年またぎ（12/31 の「明日」→ 翌年 1/1）", () => {
    expect(parseDateInput("明日", "2026-12-31")).toBe("2027-01-01");
  });

  it("年またぎの月/日（12/31 に「1/5」→ 来年の 1/5）", () => {
    expect(parseDateInput("1/5", "2026-12-31")).toBe("2027-01-05");
  });
});

describe("2/29：今日以降で一番近い、その日がある年", () => {
  it("うるう年でない年の 3/1 に「2/29」→ 次のうるう年（2026-03-01 → 2028-02-29）", () => {
    expect(parseDateInput("2/29", "2026-03-01")).toBe("2028-02-29");
    expect(parseDateInput("2月29日", "2026-03-01")).toBe("2028-02-29");
  });

  it("うるう年の 2/29 を過ぎたら、次のうるう年（2024-03-01 → 2028-02-29）", () => {
    expect(parseDateInput("2/29", "2024-03-01")).toBe("2028-02-29");
  });

  it("うるう年の 2/29 より前なら、その年（2028-01-10 → 2028-02-29）", () => {
    expect(parseDateInput("2/29", "2028-01-10")).toBe("2028-02-29");
  });

  it("うるう年でない世紀の年は飛ばす（2097-03-01 → 2100 年ではなく 2104-02-29）", () => {
    expect(parseDateInput("2/29", "2097-03-01")).toBe("2104-02-29");
  });

  it("存在しない日付（2/30・4/31）は、どの年でも null", () => {
    expect(parseDateInput("2/30", "2026-03-01")).toBeNull();
    expect(parseDateInput("4/31", "2026-03-01")).toBeNull();
  });
});

describe("年/月/日", () => {
  it("2026-10-03", () => {
    expect(parseDateInput("2026-10-03", SUNDAY)).toBe("2026-10-03");
  });

  it("2026/10/3", () => {
    expect(parseDateInput("2026/10/3", SUNDAY)).toBe("2026-10-03");
  });

  it("2026年10月3日", () => {
    expect(parseDateInput("2026年10月3日", SUNDAY)).toBe("2026-10-03");
  });
});

describe("日だけ：今日以降で一番近いその日", () => {
  it("15日（今月の15日がまだ先）", () => {
    expect(parseDateInput("15日", SUNDAY)).toBe("2026-10-15");
  });

  it("今日以前の日は来月（9/27 に「1日」→ 10/1）", () => {
    expect(parseDateInput("1日", SUNDAY)).toBe("2026-10-01");
  });

  it("ちょうど今日の日（9/27 に「27日」→ 今日）", () => {
    expect(parseDateInput("27日", SUNDAY)).toBe("2026-09-27");
  });
});

describe("読めないもの → null", () => {
  it.each([["xyz"], [""], ["来週"], ["2026/2/30"], ["あいうえお"], ["13月1日"]])(
    "%s は null",
    (text) => {
      expect(parseDateInput(text, SUNDAY)).toBeNull();
    },
  );
});
