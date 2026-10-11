/**
 * 論理日付：タイムゾーン（既定は APP_TIME_ZONE の Asia/Tokyo。クラウドの利用者は自分のゾーン）での日付（YYYY-MM-DD）。
 * ただし、その土地の時計で午前4時より前は前の日。経過時間で 4 時間引いてから変換すると、夏時間の切り替えの日に
 * 境目が 3 時や 5 時にずれるので、土地の日付と時で決める。TUI の dates.rs の logical_date と同じ決まり。
 * テストで時刻を差し替えられるよう、現在時刻は引数で受ける
 */

export const APP_TIME_ZONE = "Asia/Tokyo";
/** この時刻（時）に論理日付が切り替わる */
export const DAY_START_HOUR = 4;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function logicalDate(now: Date, timeZone: string = APP_TIME_ZONE): string {
  const parts = formatterFor(timeZone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const dayShift = part("hour") < DAY_START_HOUR ? 1 : 0;
  const date = new Date(Date.UTC(part("year"), part("month") - 1, part("day") - dayShift));
  return date.toISOString().slice(0, 10);
}
