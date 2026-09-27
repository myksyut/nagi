import type { TaskRow } from "@/data";
import { addDays } from "@/data/logical-day";
import type { TaskSection } from "@/tasks/list-ui";

/**
 * 日付と締切の表示の文言。date と today は論理日付（YYYY-MM-DD）。
 * 今日と年が違うときだけ年を付ける
 */

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

function parts(date: string) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()] ?? "";
  return { year, month, day, weekday, sameYear: (today: string) => today.startsWith(`${year}-`) };
}

/** from から to までの日数（to が前なら負） */
export function daysBetween(from: string, to: string): number {
  const utc = (date: string) =>
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return Math.round((utc(to) - utc(from)) / DAY_MS);
}

/** 「10/2」（年が違えば「2027/1/4」） */
export function formatShortDate(date: string, today: string): string {
  const { year, month, day, sameYear } = parts(date);
  return sameYear(today) ? `${month}/${day}` : `${year}/${month}/${day}`;
}

/** 「10/2(金)」（年が違えば「2027/1/4(月)」） */
export function formatShortDateWithWeekday(date: string, today: string): string {
  return `${formatShortDate(date, today)}(${parts(date).weekday})`;
}

/** 日付の入力で解釈した日付：「10月5日(月)」（年が違えば「2027年1月4日(月)」） */
export function formatLongDate(date: string, today: string): string {
  const { year, month, day, weekday, sameYear } = parts(date);
  return `${sameYear(today) ? "" : `${year}年`}${month}月${day}日(${weekday})`;
}

export type DeadlineTone = "plain" | "soon" | "today" | "overdue";

/**
 * 行の右側の締切の表示（Core Flows の4段階）。
 * 4日以上先は「締切 10/2」、3日以内は「あと N 日」（アクセント色）、当日は「今日まで」、過ぎたら「N 日超過」（控えめな赤の文字）
 */
export function deadlineStatus(
  deadlineOn: string,
  today: string,
): { tone: DeadlineTone; label: string } {
  const days = daysBetween(today, deadlineOn);
  if (days >= 4) return { tone: "plain", label: `締切 ${formatShortDate(deadlineOn, today)}` };
  if (days >= 1) return { tone: "soon", label: `あと${days}日` };
  if (days === 0) return { tone: "today", label: "今日まで" };
  return { tone: "overdue", label: `${-days}日超過` };
}

/** 予定のまとまりの見出し：「今日」「明日」「10/2(金)」 */
export function scheduleHeading(date: string, today: string): string {
  if (date === today) return "今日";
  if (date === addDays(today, 1)) return "明日";
  return formatShortDateWithWeekday(date, today);
}

/**
 * 予定の一覧（日付の順）を、日付ごとのまとまりにする。
 * 予定の日付はリストの並びに効く項目なので、変わればリストごと計算し直される。行は観測しない（peek）
 */
export function sectionsByDate(rows: readonly TaskRow[], today: string): TaskSection[] {
  const sections: { key: string; heading: string; rows: TaskRow[] }[] = [];
  for (const row of rows) {
    const date = row.peek().scheduledOn ?? "";
    let section = sections.at(-1);
    if (section?.key !== date) {
      section = { key: date, heading: date === "" ? "" : scheduleHeading(date, today), rows: [] };
      sections.push(section);
    }
    section.rows.push(row);
  }
  return sections;
}
