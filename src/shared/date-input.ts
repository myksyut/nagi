/**
 * 日付の入力（d と ⇧D）を読む小さな自前のパーサー。基準は論理日付（today、YYYY-MM-DD）で、結果も YYYY-MM-DD。
 * 読めるもの：
 * - 今日・明日・明後日・明々後日（きょう・あした・あす・あさって・しあさって・本日 も）
 * - 曜日（「金」「金曜」「金曜日」）：今日より後で一番近いその曜日（今日が金曜なら来週の金曜）
 * - 今週・来週・再来週＋曜日（「来週月曜」「来週の月曜日」）：週は月曜始まり。今週の過ぎた曜日はそのまま過去の日付
 * - N日後・N週間後（「3日後」「2週間後」）
 * - 月/日（「10/3」「10月3日」）：今日以降で一番近いその日（今年のその日が過ぎていれば来年。2/29 は次のうるう年）
 * - 日だけ（「15日」）：今日以降で一番近いその日（今月のその日が過ぎていれば来月）
 * - 年/月/日（「2026-10-03」「2026/10/3」「2026年10月3日」）
 * 全角の数字・記号と空白は吸収し、後ろの「まで」「までに」「に」と、表示の形の曜日「(月)」は読み飛ばす。
 * 読めなければ null（画面は「日付として読めません」とだけ出す）
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

const RELATIVE_DAYS: Record<string, number> = {
  今日: 0,
  きょう: 0,
  本日: 0,
  明日: 1,
  あした: 1,
  あす: 1,
  明後日: 2,
  あさって: 2,
  明々後日: 3,
  明明後日: 3,
  しあさって: 3,
};

const WEEK_OFFSETS: Record<string, number> = { 今週: 0, 来週: 1, 再来週: 2 };

/** N日後・N週間後の N の上限（打ち間違いで遠い未来にしない） */
const MAX_OFFSET_DAYS = 3660;

/** うるう年の間隔の最大（2096 年の次は 2104 年） */
const MAX_LEAP_GAP_YEARS = 8;

function toUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function toIso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function fromIso(date: string): Date {
  return toUtc(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10)));
}

function addDays(date: string, days: number): string {
  const base = fromIso(date);
  base.setUTCDate(base.getUTCDate() + days);
  return toIso(base);
}

/** 実在する日付なら YYYY-MM-DD（2/30 などは null） */
function validDate(year: number, month: number, day: number): string | null {
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = toUtc(year, month, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return toIso(date);
}

/** 月曜を 0、日曜を 6 とした曜日の番号 */
function mondayIndex(sundayIndex: number): number {
  return (sundayIndex + 6) % 7;
}

function normalize(input: string): string {
  return input
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/(までに|まで|に)$/, "")
    .replace(/\([日月火水木金土]\)$/, "");
}

export function parseDateInput(input: string, today: string): string | null {
  const text = normalize(input);
  if (text === "") return null;

  const relative = RELATIVE_DAYS[text];
  if (relative !== undefined) return addDays(today, relative);

  const weekday = text.match(/^(今週|来週|再来週)?の?([日月火水木金土])(?:曜日?)?$/);
  if (weekday) {
    const [, week, name] = weekday;
    const target = WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
    const current = fromIso(today).getUTCDay();
    if (week === undefined) {
      // 曜日だけ：今日より後の一番近い日（1〜7日後）
      return addDays(today, (target - current + 7) % 7 || 7);
    }
    const monday = addDays(today, -mondayIndex(current));
    return addDays(monday, (WEEK_OFFSETS[week] ?? 0) * 7 + mondayIndex(target));
  }

  const offset = text.match(/^(\d+)(日|週間|週)後$/);
  if (offset) {
    const days = Number(offset[1]) * (offset[2] === "日" ? 1 : 7);
    return days <= MAX_OFFSET_DAYS ? addDays(today, days) : null;
  }

  const full = text.match(/^(\d{4})(?:[-/.](\d{1,2})[-/.](\d{1,2})|年(\d{1,2})月(\d{1,2})日?)$/);
  if (full) {
    const [, year, month = full[4], day = full[5]] = full;
    return validDate(Number(year), Number(month), Number(day));
  }

  const monthDay = text.match(/^(?:(\d{1,2})\/(\d{1,2})|(\d{1,2})月(\d{1,2})日?)$/);
  if (monthDay) {
    const month = Number(monthDay[1] ?? monthDay[3]);
    const day = Number(monthDay[2] ?? monthDay[4]);
    const year = Number(today.slice(0, 4));
    // 今日以降で、その日がある一番近い年。2/29 は次のうるう年（2100 年のような世紀の年を挟むと 8 年あく）
    for (let ahead = 0; ahead <= MAX_LEAP_GAP_YEARS; ahead++) {
      const date = validDate(year + ahead, month, day);
      if (date !== null && date >= today) return date;
    }
    return null;
  }

  const dayOfMonth = text.match(/^(\d{1,2})日$/);
  if (dayOfMonth) {
    // 日だけ：今日以降で一番近いその日（今月のその日が過ぎていれば来月。31日のない月は飛ばす）
    const day = Number(dayOfMonth[1]);
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    for (let ahead = 0; ahead <= 12; ahead++) {
      const date = validDate(
        year + Math.floor((month - 1 + ahead) / 12),
        ((month - 1 + ahead) % 12) + 1,
        day,
      );
      if (date !== null && date >= today) return date;
    }
    return null;
  }

  return null;
}
