import { APP_TIME_ZONE, DAY_START_HOUR, logicalDate } from "@shared/logical-date";
import { computed, makeObservable, observable, runInAction } from "mobx";

/**
 * 画面側の論理日付（午前4時に切り替わる日付）。MobX の値として持ち、午前4時ちょうどにタイマーで更新する。
 * 今日の「完了 N件」と到着の印はこの値から計算するので、日付が変わっても書き込みは要らない
 */

/**
 * タイマーの最長の待ち時間。スリープなどでタイマーが遅れても、1時間以内に確かめ直す
 * （午前4時ちょうどの更新は、最後の待ち時間を境目までの時間にすることで守る）
 */
const MAX_TIMER_MS = 60 * 60 * 1000;

function parseDate(date: string): [number, number, number] {
  return [Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))];
}

/** YYYY-MM-DD に日数を足す */
export function addDays(date: string, days: number): string {
  const [year, month, day] = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** その時刻での timeZone の時差（ミリ秒。東京なら +9 時間） */
function offsetMs(instant: number, timeZone: string): number {
  const parts = wallClockFormatter(timeZone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClock = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  return wallClock - Math.floor(instant / 1000) * 1000;
}

/** 論理日付 date が始まる時刻（timeZone での、その日の午前4時） */
export function dayStart(date: string, timeZone: string = APP_TIME_ZONE): Date {
  const [year, month, day] = parseDate(date);
  const wallClock = Date.UTC(year, month - 1, day, DAY_START_HOUR);
  const guess = wallClock - offsetMs(wallClock, timeZone);
  // 夏時間のある時間帯で、境目をまたいだときのずれを1回だけ直す（東京には夏時間はない）
  return new Date(wallClock - offsetMs(guess, timeZone));
}

export type LogicalDayOptions = {
  /** 現在時刻。テストで差し替える */
  now: () => Date;
  timeZone?: string;
  /** 論理日付が変わったとき（タイマーか refresh() で気づいたとき）に呼ぶ */
  onChange?: (today: string) => void;
};

export class LogicalDay {
  /** 今日の論理日付（YYYY-MM-DD） */
  today: string;

  readonly timeZone: string;
  readonly #now: () => Date;
  readonly #onChange: (today: string) => void;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor({ now, timeZone = APP_TIME_ZONE, onChange = () => {} }: LogicalDayOptions) {
    this.#now = now;
    this.timeZone = timeZone;
    this.#onChange = onChange;
    this.today = logicalDate(now(), timeZone);
    makeObservable(this, { today: observable, startsAt: computed, endsAt: computed });
  }

  /** 今日が始まった時刻（ISO 8601 の UTC）。これ以降に完了したものが今日の「完了 N件」に入る */
  get startsAt(): string {
    return dayStart(this.today, this.timeZone).toISOString();
  }

  /** 明日が始まる時刻（ISO 8601 の UTC） */
  get endsAt(): string {
    return dayStart(addDays(this.today, 1), this.timeZone).toISOString();
  }

  /** 午前4時のタイマーを動かす */
  start(): void {
    this.#schedule();
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** 今の時刻で論理日付を確かめ直す。変わっていたら更新して onChange を呼び、true を返す */
  refresh(): boolean {
    const next = logicalDate(this.#now(), this.timeZone);
    if (next === this.today) return false;
    runInAction(() => {
      this.today = next;
    });
    this.#onChange(next);
    return true;
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    const now = this.#now().getTime();
    const tomorrow = addDays(logicalDate(new Date(now), this.timeZone), 1);
    const boundary = dayStart(tomorrow, this.timeZone).getTime();
    const delay = Math.max(0, Math.min(boundary - now, MAX_TIMER_MS));
    this.#timer = setTimeout(() => {
      this.refresh();
      this.#schedule();
    }, delay);
  }
}
