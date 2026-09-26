/**
 * 論理日付：APP_TIMEZONE（Asia/Tokyo）での現在時刻から 4 時間引いた日付（YYYY-MM-DD）。
 * 午前4時に日付が切り替わる。テストで時刻を差し替えられるよう、現在時刻は引数で受ける
 */

export const APP_TIME_ZONE = "Asia/Tokyo";
/** この時刻（時）に論理日付が切り替わる */
export const DAY_START_HOUR = 4;

const HOUR_MS = 60 * 60 * 1000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function logicalDate(now: Date, timeZone: string = APP_TIME_ZONE): string {
  const shifted = new Date(now.getTime() - DAY_START_HOUR * HOUR_MS);
  const parts = formatterFor(timeZone).formatToParts(shifted);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}
