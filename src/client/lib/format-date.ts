const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function parts(date: string): { year: number; month: number; day: number; weekday: string } {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  return { year, month, day, weekday };
}

/**
 * 見出しの日付（例：「9月28日 月曜日」）。date は論理日付（YYYY-MM-DD）。
 * today と年が違うときだけ年を付ける（「2025年12月3日 水曜日」）
 */
export function formatDayHeading(date: string, today: string = date): string {
  const { year, month, day, weekday } = parts(date);
  const prefix = year === Number(today.slice(0, 4)) ? "" : `${year}年`;
  return `${prefix}${month}月${day}日 ${weekday}曜日`;
}
