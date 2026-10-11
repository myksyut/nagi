//! 日付の計算と文言。日付は論理日付（YYYY-MM-DD の文字列。文字列の大小で比べられる）で持つ。
//! 論理日付：タイムゾーンでの日付。ただし、その土地の時計で午前4時より前は前の日（Worker と同じ決まり）。
//! クラウドの利用者のタイムゾーンは Worker が持ち（同期の応答の timeZone）、ない人は APP_TIME_ZONE の Asia/Tokyo

use std::sync::LazyLock;

use crate::i18n::{Msg, fill, t};
use chrono::{DateTime, Datelike, Duration, NaiveDate, SecondsFormat, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use regex::Regex;
use unicode_normalization::UnicodeNormalization;

pub const APP_TIME_ZONE: Tz = chrono_tz::Asia::Tokyo;

/// この端末のタイムゾーン（この端末だけで使うとき、日付の切り替えと「今日」に使う）。
/// 環境変数 TZ（IANA の名前。例：Asia/Tokyo）があればそれ、なければ OS の設定。分からなければ APP_TIME_ZONE
pub fn device_time_zone() -> Tz {
    let named = |name: String| name.parse::<Tz>().ok();
    std::env::var("TZ")
        .ok()
        .and_then(named)
        .or_else(|| iana_time_zone::get_timezone().ok().and_then(named))
        .unwrap_or(APP_TIME_ZONE)
}
/// この時刻（時）に論理日付が切り替わる
pub const DAY_START_HOUR: u32 = 4;

/// 入力を読むための曜日（表示は weekday_name）
const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];
const WEEKDAY_NAMES: [Msg; 7] = [
    Msg::WeekdaySun,
    Msg::WeekdayMon,
    Msg::WeekdayTue,
    Msg::WeekdayWed,
    Msg::WeekdayThu,
    Msg::WeekdayFri,
    Msg::WeekdaySat,
];
const WEEKDAY_LONG_NAMES: [Msg; 7] = [
    Msg::WeekdayLongSun,
    Msg::WeekdayLongMon,
    Msg::WeekdayLongTue,
    Msg::WeekdayLongWed,
    Msg::WeekdayLongThu,
    Msg::WeekdayLongFri,
    Msg::WeekdayLongSat,
];
const MONTH_SHORT_NAMES: [Msg; 12] = [
    Msg::MonthShort1,
    Msg::MonthShort2,
    Msg::MonthShort3,
    Msg::MonthShort4,
    Msg::MonthShort5,
    Msg::MonthShort6,
    Msg::MonthShort7,
    Msg::MonthShort8,
    Msg::MonthShort9,
    Msg::MonthShort10,
    Msg::MonthShort11,
    Msg::MonthShort12,
];
const MONTH_FULL_NAMES: [Msg; 12] = [
    Msg::MonthFull1,
    Msg::MonthFull2,
    Msg::MonthFull3,
    Msg::MonthFull4,
    Msg::MonthFull5,
    Msg::MonthFull6,
    Msg::MonthFull7,
    Msg::MonthFull8,
    Msg::MonthFull9,
    Msg::MonthFull10,
    Msg::MonthFull11,
    Msg::MonthFull12,
];
/// 入力を読むための英語の曜日（短い形と長い形。表示は weekday_name）。日曜を 0 とする
const ENGLISH_WEEKDAYS: [[&str; 2]; 7] = [
    ["sun", "sunday"],
    ["mon", "monday"],
    ["tue", "tuesday"],
    ["wed", "wednesday"],
    ["thu", "thursday"],
    ["fri", "friday"],
    ["sat", "saturday"],
];

/// 時刻を ISO 8601 の UTC（ミリ秒まで。JS の toISOString と同じ形）にする
pub fn iso(time: DateTime<Utc>) -> String {
    time.to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn parse_iso(time: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(time)
        .ok()
        .map(|time| time.with_timezone(&Utc))
}

pub fn to_naive(date: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()
}

pub fn from_naive(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// 経過時間で 4 時間引いてから変換すると、夏時間の切り替えの日に境目が 3 時や 5 時にずれるので、
/// 土地の日付と時で決める
pub fn logical_date(now: DateTime<Utc>, tz: Tz) -> String {
    let local = now.with_timezone(&tz);
    let date = local.date_naive();
    if local.hour() < DAY_START_HOUR {
        from_naive(date.pred_opt().unwrap_or(date))
    } else {
        from_naive(date)
    }
}

/// YYYY-MM-DD に日数を足す（読めない日付はそのまま返す）
pub fn add_days(date: &str, days: i64) -> String {
    match to_naive(date).and_then(|d| d.checked_add_signed(Duration::days(days))) {
        Some(next) => from_naive(next),
        None => date.to_string(),
    }
}

/// from から to までの日数（to が前なら負）
pub fn days_between(from: &str, to: &str) -> i64 {
    match (to_naive(from), to_naive(to)) {
        (Some(from), Some(to)) => (to - from).num_days(),
        _ => 0,
    }
}

/// 論理日付 date が始まる時刻（tz での、その日の午前4時）
pub fn day_start(date: &str, tz: Tz) -> DateTime<Utc> {
    let naive = to_naive(date)
        .and_then(|d| d.and_hms_opt(DAY_START_HOUR, 0, 0))
        .unwrap_or_default();
    tz.from_local_datetime(&naive)
        .earliest()
        .map(|time| time.with_timezone(&Utc))
        .unwrap_or_else(|| Utc.from_utc_datetime(&naive))
}

/// 日曜を 0 とした曜日の番号
pub fn weekday_index(date: &str) -> usize {
    to_naive(date).map_or(0, |d| d.weekday().num_days_from_sunday() as usize)
}

/// 日曜を 0 とした曜日の名前
pub fn weekday_name(index: usize) -> &'static str {
    t(WEEKDAY_NAMES[index])
}

pub fn weekday_label(date: &str) -> &'static str {
    weekday_name(weekday_index(date))
}

/// 日曜を 0 とした曜日の長い名前（見出し用。日本語は「月曜日」、英語は「Monday」）
pub fn weekday_long_name(index: usize) -> &'static str {
    t(WEEKDAY_LONG_NAMES[index])
}

/// 月の短い名前（1〜12。日本語は「10月」、英語は「Oct」）
pub fn month_short(month: u32) -> &'static str {
    t(MONTH_SHORT_NAMES[(month as usize).clamp(1, 12) - 1])
}

/// 月の名前（1〜12。日本語は「10月」、英語は「October」）
pub fn month_full(month: u32) -> &'static str {
    t(MONTH_FULL_NAMES[(month as usize).clamp(1, 12) - 1])
}

/// その月の1日（YYYY-MM-01）
pub fn month_start(date: &str) -> String {
    format!("{}-01", &date[..7.min(date.len())])
}

/// 月を足す（1日にそろえる）
pub fn add_months(date: &str, months: i32) -> String {
    let Some(d) = to_naive(date) else {
        return date.to_string();
    };
    let total = d.year() * 12 + d.month0() as i32 + months;
    let (year, month0) = (total.div_euclid(12), total.rem_euclid(12));
    format!("{year:04}-{:02}-01", month0 + 1)
}

fn ymd(date: &str) -> (i32, u32, u32) {
    to_naive(date).map_or((0, 1, 1), |d| (d.year(), d.month(), d.day()))
}

// --- 日付の入力（d と ⇧D） --------------------------------------------------------------

/// N日後・N週間後の N の上限（打ち間違いで遠い未来にしない）
const MAX_OFFSET_DAYS: i64 = 3660;
/// うるう年の間隔の最大（2096 年の次は 2104 年）
const MAX_LEAP_GAP_YEARS: i32 = 8;

static SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(までに|まで|に)$").unwrap());
static SHOWN_WEEKDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\([日月火水木金土]\)$").unwrap());
static WEEKDAY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(今週|来週|再来週)?の?([日月火水木金土])(?:曜日?)?$").unwrap());
static OFFSET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]+)(日|週間|週)後$").unwrap());
static FULL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"^([0-9]{4})(?:[-/.]([0-9]{1,2})[-/.]([0-9]{1,2})|年([0-9]{1,2})月([0-9]{1,2})日?)$",
    )
    .unwrap()
});
static MONTH_DAY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:([0-9]{1,2})/([0-9]{1,2})|([0-9]{1,2})月([0-9]{1,2})日?)$").unwrap()
});
static DAY_OF_MONTH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]{1,2})日$").unwrap());

fn relative_days(text: &str) -> Option<i64> {
    Some(match text {
        "今日" | "きょう" | "本日" => 0,
        "明日" | "あした" | "あす" => 1,
        "明後日" | "あさって" => 2,
        "明々後日" | "明明後日" | "しあさって" => 3,
        _ => return None,
    })
}

/// 実在する日付なら YYYY-MM-DD（2/30 などは None）
fn valid_date(year: i32, month: u32, day: u32) -> Option<String> {
    if !(1000..=9999).contains(&year) {
        return None;
    }
    NaiveDate::from_ymd_opt(year, month, day).map(from_naive)
}

/// 月曜を 0、日曜を 6 とした曜日の番号
fn monday_index(sunday_index: usize) -> i64 {
    ((sunday_index + 6) % 7) as i64
}

fn normalize(input: &str) -> String {
    let text: String = input.nfkc().filter(|c: &char| !c.is_whitespace()).collect();
    let text = SUFFIX.replace(&text, "");
    SHOWN_WEEKDAY.replace(&text, "").into_owned()
}

/// 日付の入力を読む。基準は論理日付（today）で、結果も YYYY-MM-DD。読めなければ None。
/// 読めるもの：今日・明日・明後日・明々後日、曜日（今日より後で一番近い日）、今週・来週・再来週＋曜日（月曜始まり）、
/// N日後・N週間後、月/日（今日以降で一番近いその日）、日だけ、年/月/日。
/// 全角の数字・記号と空白は吸収し、後ろの「まで」「までに」「に」と、表示の形の曜日「(月)」は読み飛ばす
pub fn parse_date_input(input: &str, today: &str) -> Option<String> {
    let text = normalize(input);
    if text.is_empty() {
        return None;
    }
    if let Some(days) = relative_days(&text) {
        return Some(add_days(today, days));
    }

    if let Some(found) = WEEKDAY.captures(&text) {
        let target = WEEKDAYS.iter().position(|w| *w == &found[2])?;
        let current = weekday_index(today);
        return Some(match found.get(1).map(|m| m.as_str()) {
            // 曜日だけ：今日より後の一番近い日（1〜7日後）
            None => {
                let ahead = (target + 7 - current) % 7;
                add_days(today, if ahead == 0 { 7 } else { ahead as i64 })
            }
            Some(week) => {
                let offset = match week {
                    "来週" => 1,
                    "再来週" => 2,
                    _ => 0,
                };
                let monday = add_days(today, -monday_index(current));
                add_days(&monday, offset * 7 + monday_index(target))
            }
        });
    }

    if let Some(found) = OFFSET.captures(&text) {
        let n: i64 = found[1].parse().ok()?;
        let days = n.checked_mul(if &found[2] == "日" { 1 } else { 7 })?;
        return (days <= MAX_OFFSET_DAYS).then(|| add_days(today, days));
    }

    if let Some(found) = FULL.captures(&text) {
        let number = |a: usize, b: usize| -> Option<u32> {
            found.get(a).or(found.get(b))?.as_str().parse().ok()
        };
        return valid_date(found[1].parse().ok()?, number(2, 4)?, number(3, 5)?);
    }

    let (today_year, today_month, _) = ymd(today);

    if let Some(found) = MONTH_DAY.captures(&text) {
        let number = |a: usize, b: usize| -> Option<u32> {
            found.get(a).or(found.get(b))?.as_str().parse().ok()
        };
        let (month, day) = (number(1, 3)?, number(2, 4)?);
        // 今日以降で、その日がある一番近い年。2/29 は次のうるう年
        return (0..=MAX_LEAP_GAP_YEARS)
            .filter_map(|ahead| valid_date(today_year + ahead, month, day))
            .find(|date| date.as_str() >= today);
    }

    if let Some(found) = DAY_OF_MONTH.captures(&text) {
        // 日だけ：今日以降で一番近いその日（31日のない月は飛ばす）
        let day: u32 = found[1].parse().ok()?;
        return (0..=12u32)
            .filter_map(|ahead| {
                let month0 = today_month - 1 + ahead;
                valid_date(today_year + (month0 / 12) as i32, month0 % 12 + 1, day)
            })
            .find(|date| date.as_str() >= today);
    }

    parse_english(input, today)
}

/// 英語の入力を読む。日本語の読みが外れたときだけ呼ぶ。小文字にして、空白を 1 つにまとめてから読む
/// （日本語の `normalize` は空白を消すので、「in 3 days」が崩れる）。
/// 読めるもの：today・tomorrow、曜日（mon〜sun・monday〜sunday。今日より後で一番近い日）、
/// next ＋曜日（来週の同じ曜日。「来週月曜」と同じ日）、in N day(s)・in N week(s)
fn parse_english(input: &str, today: &str) -> Option<String> {
    let text = input.nfkc().collect::<String>().to_lowercase();
    let words: Vec<&str> = text.split_whitespace().collect();
    let weekday = |word: &str| {
        ENGLISH_WEEKDAYS
            .iter()
            .position(|names| names.contains(&word))
    };
    match words.as_slice() {
        ["today"] => Some(today.to_string()),
        ["tomorrow"] => Some(add_days(today, 1)),
        [word] => {
            let ahead = (weekday(word)? + 7 - weekday_index(today)) % 7;
            Some(add_days(today, if ahead == 0 { 7 } else { ahead as i64 }))
        }
        ["next", word] => {
            let monday = add_days(today, -monday_index(weekday_index(today)));
            Some(add_days(&monday, 7 + monday_index(weekday(word)?)))
        }
        ["in", count, unit @ ("day" | "days" | "week" | "weeks")] => {
            if !count.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            let n: i64 = count.parse().ok()?;
            let days = n.checked_mul(if unit.starts_with("day") { 1 } else { 7 })?;
            (days <= MAX_OFFSET_DAYS).then(|| add_days(today, days))
        }
        _ => None,
    }
}

// --- 表示の文言 -------------------------------------------------------------------------

fn same_year(date: &str, today: &str) -> bool {
    date.get(..4) == today.get(..4)
}

/// 「10/2」（年が違えば、日本語は「2027/1/4」、英語は「1/4/2027」）
pub fn format_short_date(date: &str, today: &str) -> String {
    let (year, month, day) = ymd(date);
    if same_year(date, today) {
        fill(Msg::DateShort, &[&month, &day])
    } else {
        fill(Msg::DateShortWithYear, &[&year, &month, &day])
    }
}

/// 日本語は「10/2(金)」、英語は「Fri 10/2」
pub fn format_short_date_with_weekday(date: &str, today: &str) -> String {
    fill(
        Msg::DateShortWeekday,
        &[&format_short_date(date, today), &weekday_label(date)],
    )
}

/// 日本語は「10月5日(月)」、英語は「Mon, Oct 5」（年が違えば「2027年1月4日(月)」「Mon, Jan 4, 2027」）
pub fn format_long_date(date: &str, today: &str) -> String {
    let (year, month, day) = ymd(date);
    let (month, weekday) = (month_short(month), weekday_label(date));
    if same_year(date, today) {
        fill(Msg::DateLong, &[&month, &day, &weekday])
    } else {
        fill(Msg::DateLongWithYear, &[&year, &month, &day, &weekday])
    }
}

/// 見出しの日付：日本語は「9月28日 月曜日」、英語は「Monday, September 28」（年が違えば年を付ける）
pub fn format_day_heading(date: &str, today: &str) -> String {
    let (year, month, day) = ymd(date);
    let (month, weekday) = (month_full(month), weekday_long_name(weekday_index(date)));
    if same_year(date, today) {
        fill(Msg::DateHeading, &[&month, &day, &weekday])
    } else {
        fill(Msg::DateHeadingWithYear, &[&year, &month, &day, &weekday])
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeadlineTone {
    Plain,
    Soon,
    Today,
    Overdue,
}

/// 行の右側の締切の表示。4日以上先は「締切 10/2」（英語は「due 10/2」）、3日以内は「あとN日」（「N days left」）、
/// 当日は「今日まで」（「due today」）、過ぎたら「N日超過」（「N days overdue」）
pub fn deadline_status(deadline_on: &str, today: &str) -> (DeadlineTone, String) {
    let days = days_between(today, deadline_on);
    if days >= 4 {
        (
            DeadlineTone::Plain,
            fill(Msg::DeadlineFar, &[&format_short_date(deadline_on, today)]),
        )
    } else if days >= 1 {
        let msg = if days == 1 {
            Msg::DaysLeftOne
        } else {
            Msg::DaysLeftMany
        };
        (DeadlineTone::Soon, fill(msg, &[&days]))
    } else if days == 0 {
        (DeadlineTone::Today, t(Msg::DeadlineToday).to_string())
    } else {
        let msg = if days == -1 {
            Msg::DaysOverdueOne
        } else {
            Msg::DaysOverdueMany
        };
        (DeadlineTone::Overdue, fill(msg, &[&-days]))
    }
}

/// 予定のまとまりの見出し：「今日」「明日」「10/2(金)」（英語は「Today」「Tomorrow」「Fri 10/2」）
pub fn schedule_heading(date: &str, today: &str) -> String {
    if date == today {
        t(Msg::ListToday).to_string()
    } else if date == add_days(today, 1) {
        t(Msg::DateTomorrow).to_string()
    } else {
        format_short_date_with_weekday(date, today)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::i18n::{Lang, with_lang};

    const SUNDAY: &str = "2026-09-27";
    const MONDAY: &str = "2026-09-28";

    fn parse(text: &str, today: &str) -> Option<String> {
        parse_date_input(text, today)
    }

    fn some(date: &str) -> Option<String> {
        Some(date.to_string())
    }

    #[test]
    fn 論理日付は午前4時に切り替わる() {
        let at = |time: &str| logical_date(parse_iso(time).unwrap(), APP_TIME_ZONE);
        // 東京の 10/6 03:59 はまだ 10/5、04:00 から 10/6
        assert_eq!(at("2026-10-05T18:59:59.000Z"), "2026-10-05");
        assert_eq!(at("2026-10-05T19:00:00.000Z"), "2026-10-06");
        assert_eq!(
            iso(day_start("2026-10-06", APP_TIME_ZONE)),
            "2026-10-05T19:00:00.000Z"
        );
    }

    #[test]
    fn 夏時間の切り替えの日も_土地の時計の午前4時に切り替わる() {
        let at = |time: &str, tz: Tz| logical_date(parse_iso(time).unwrap(), tz);
        let los_angeles = chrono_tz::America::Los_Angeles;
        let sydney = chrono_tz::Australia::Sydney;
        let kathmandu = chrono_tz::Asia::Kathmandu;
        for (time, tz, expected) in [
            // ロサンゼルス 3/8：2 時に夏時間（-07:00）が始まる。04:00 は 11:00Z
            ("2026-03-08T10:59:59.000Z", los_angeles, "2026-03-07"),
            ("2026-03-08T11:00:00.000Z", los_angeles, "2026-03-08"),
            // ロサンゼルス 11/1：2 時に夏時間が終わる（-08:00）。04:00 は 12:00Z
            ("2026-11-01T11:59:59.000Z", los_angeles, "2026-10-31"),
            ("2026-11-01T12:00:00.000Z", los_angeles, "2026-11-01"),
            // シドニー 4/5：3 時に夏時間が終わる（+10:00）。04:00 は 4/4 18:00Z
            ("2026-04-04T17:59:59.000Z", sydney, "2026-04-04"),
            ("2026-04-04T18:00:00.000Z", sydney, "2026-04-05"),
            // シドニー 10/4：2 時に夏時間（+11:00）が始まる。04:00 は 10/3 17:00Z
            ("2026-10-03T16:59:59.000Z", sydney, "2026-10-03"),
            ("2026-10-03T17:00:00.000Z", sydney, "2026-10-04"),
            // カトマンズ（+05:45）の 10/6 04:00 は 10/5 22:15Z
            ("2026-10-05T22:14:59.000Z", kathmandu, "2026-10-05"),
            ("2026-10-05T22:15:00.000Z", kathmandu, "2026-10-06"),
        ] {
            assert_eq!(at(time, tz), expected, "{time} {tz}");
        }
    }

    #[test]
    fn 日付の足し引き() {
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(days_between("2026-09-27", "2026-10-03"), 6);
        assert_eq!(days_between("2026-10-03", "2026-09-27"), -6);
        assert_eq!(add_months("2026-12-15", 1), "2027-01-01");
        assert_eq!(add_months("2026-01-15", -1), "2025-12-01");
        assert_eq!(weekday_label(SUNDAY), "日");
    }

    #[test]
    fn 相対日() {
        for (text, expected) in [
            ("今日", SUNDAY),
            ("きょう", SUNDAY),
            ("本日", SUNDAY),
            ("明日", "2026-09-28"),
            ("あした", "2026-09-28"),
            ("あす", "2026-09-28"),
            ("明後日", "2026-09-29"),
            ("あさって", "2026-09-29"),
            ("明々後日", "2026-09-30"),
            ("しあさって", "2026-09-30"),
        ] {
            assert_eq!(parse(text, SUNDAY), some(expected), "{text}");
        }
    }

    #[test]
    fn 曜日だけは今日より後の一番近い日() {
        assert_eq!(parse("月曜", MONDAY), some("2026-10-05"));
        assert_eq!(parse("金曜", MONDAY), some("2026-10-02"));
        assert_eq!(parse("金", MONDAY), some("2026-10-02"));
        assert_eq!(parse("金曜日", MONDAY), some("2026-10-02"));
    }

    #[test]
    fn 週と曜日は月曜始まり() {
        assert_eq!(parse("来週月曜", SUNDAY), some("2026-09-28"));
        assert_eq!(parse("来週月曜", MONDAY), some("2026-10-05"));
        assert_eq!(parse("来週日曜", MONDAY), some("2026-10-11"));
        assert_eq!(parse("来週日曜", SUNDAY), some("2026-10-04"));
        assert_eq!(parse("来週の月曜日", SUNDAY), some("2026-09-28"));
        assert_eq!(parse("今週月曜", SUNDAY), some("2026-09-21"));
        assert_eq!(parse("今週日曜", MONDAY), some("2026-10-04"));
        assert_eq!(parse("再来週月曜", MONDAY), some("2026-10-12"));
    }

    #[test]
    fn n日後と_n週間後() {
        assert_eq!(parse("3日後", SUNDAY), some("2026-09-30"));
        assert_eq!(parse("2週間後", SUNDAY), some("2026-10-11"));
        assert_eq!(parse("３日後", SUNDAY), some("2026-09-30"));
        assert_eq!(parse("99999日後", SUNDAY), None);
        assert_eq!(parse("99999999999999999999999日後", SUNDAY), None);
    }

    #[test]
    fn 月と日は今日以降で一番近いその日() {
        assert_eq!(parse("10/3", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("１０／３", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("9/27", SUNDAY), some("2026-09-27"));
        assert_eq!(parse("9/26", SUNDAY), some("2027-09-26"));
        assert_eq!(parse("10月3日", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("10月5日(月)", SUNDAY), some("2026-10-05"));
        assert_eq!(parse("金曜まで", MONDAY), some("2026-10-02"));
        assert_eq!(parse("10/3までに", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("10/3に", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("明日", "2026-12-31"), some("2027-01-01"));
        assert_eq!(parse("1/5", "2026-12-31"), some("2027-01-05"));
    }

    #[test]
    fn うるう日は次にその日がある年() {
        assert_eq!(parse("2/29", "2026-03-01"), some("2028-02-29"));
        assert_eq!(parse("2月29日", "2026-03-01"), some("2028-02-29"));
        assert_eq!(parse("2/29", "2024-03-01"), some("2028-02-29"));
        assert_eq!(parse("2/29", "2028-01-10"), some("2028-02-29"));
        assert_eq!(parse("2/29", "2097-03-01"), some("2104-02-29"));
        assert_eq!(parse("2/30", "2026-03-01"), None);
        assert_eq!(parse("4/31", "2026-03-01"), None);
    }

    #[test]
    fn 年月日と日だけ() {
        assert_eq!(parse("2026-10-03", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("2026/10/3", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("2026年10月3日", SUNDAY), some("2026-10-03"));
        assert_eq!(parse("15日", SUNDAY), some("2026-10-15"));
        assert_eq!(parse("1日", SUNDAY), some("2026-10-01"));
        assert_eq!(parse("27日", SUNDAY), some("2026-09-27"));
        assert_eq!(parse("31日", "2026-09-30"), some("2026-10-31"));
    }

    #[test]
    fn 読めないものは_none() {
        for text in ["xyz", "", "来週", "2026/2/30", "あいうえお", "13月1日"] {
            assert_eq!(parse(text, SUNDAY), None, "{text}");
        }
    }

    #[test]
    fn 表示の文言() {
        assert_eq!(format_short_date("2026-10-02", SUNDAY), "10/2");
        assert_eq!(format_short_date("2027-01-04", SUNDAY), "2027/1/4");
        assert_eq!(
            format_short_date_with_weekday("2026-10-02", SUNDAY),
            "10/2(金)"
        );
        assert_eq!(format_long_date("2026-10-05", SUNDAY), "10月5日(月)");
        assert_eq!(format_long_date("2027-01-04", SUNDAY), "2027年1月4日(月)");
        assert_eq!(format_day_heading(MONDAY, MONDAY), "9月28日 月曜日");
        assert_eq!(schedule_heading(MONDAY, SUNDAY), "明日");
        assert_eq!(schedule_heading("2026-10-02", SUNDAY), "10/2(金)");
        assert_eq!(
            deadline_status("2026-10-02", SUNDAY),
            (DeadlineTone::Plain, "締切 10/2".to_string())
        );
        assert_eq!(deadline_status("2026-09-30", SUNDAY).1, "あと3日");
        assert_eq!(deadline_status(SUNDAY, SUNDAY).1, "今日まで");
        assert_eq!(deadline_status("2026-09-25", SUNDAY).1, "2日超過");
    }

    /// 英語の入力のテストは、今日を 2026-10-12（月曜）にする
    const ENGLISH_TODAY: &str = "2026-10-12";

    #[test]
    fn 英語の日付の入力() {
        for (text, expected) in [
            ("today", "2026-10-12"),
            ("tomorrow", "2026-10-13"),
            ("fri", "2026-10-16"),
            ("Friday", "2026-10-16"),
            ("monday", "2026-10-19"),
            ("mon", "2026-10-19"),
            ("next monday", "2026-10-19"),
            ("next friday", "2026-10-23"),
            ("next sunday", "2026-10-25"),
            ("in 3 days", "2026-10-15"),
            ("in 1 day", "2026-10-13"),
            ("in 2 weeks", "2026-10-26"),
            ("In  3   Days", "2026-10-15"),
            ("  TOMORROW ", "2026-10-13"),
            ("2026-12-24", "2026-12-24"),
            ("10/3", "2027-10-03"),
            ("10/30", "2026-10-30"),
        ] {
            assert_eq!(parse(text, ENGLISH_TODAY), some(expected), "{text}");
        }
    }

    #[test]
    fn 英語の次の曜日は_日本語の来週と同じ日() {
        for (english, japanese) in [
            ("next monday", "来週月曜"),
            ("next friday", "来週金曜"),
            ("next sunday", "来週日曜"),
        ] {
            for today in [ENGLISH_TODAY, SUNDAY, "2026-10-17"] {
                assert_eq!(
                    parse(english, today),
                    parse(japanese, today),
                    "{english} {today}"
                );
            }
        }
    }

    #[test]
    fn 英語で読めないものは_none() {
        for text in [
            "in 3661 days",
            "in 99999999999999999999999 days",
            "in 600 weeks",
            "next",
            "nextday",
            "next next monday",
            "in 3",
            "in days",
            "in -3 days",
            "funday",
            "in 3 fortnights",
        ] {
            assert_eq!(parse(text, ENGLISH_TODAY), None, "{text}");
        }
        assert_eq!(parse("in 3660 days", ENGLISH_TODAY), some("2036-10-19"));
    }

    #[test]
    fn 日本語の入力は_どちらの表示の言語でも読める() {
        for lang in [Lang::Ja, Lang::En] {
            with_lang(lang, || {
                assert_eq!(parse("来週月曜", ENGLISH_TODAY), some("2026-10-19"));
                assert_eq!(parse("3日後", ENGLISH_TODAY), some("2026-10-15"));
                assert_eq!(parse("tomorrow", ENGLISH_TODAY), some("2026-10-13"));
            });
        }
    }

    #[test]
    fn 英語の表示の文言() {
        with_lang(Lang::En, || {
            let today = ENGLISH_TODAY;
            assert_eq!(format_short_date("2026-10-02", today), "10/2");
            assert_eq!(format_short_date("2027-01-04", today), "1/4/2027");
            assert_eq!(
                format_short_date_with_weekday("2026-10-02", today),
                "Fri 10/2"
            );
            assert_eq!(format_long_date("2026-10-05", today), "Mon, Oct 5");
            assert_eq!(format_long_date("2027-01-04", today), "Mon, Jan 4, 2027");
            assert_eq!(
                format_day_heading("2026-09-28", today),
                "Monday, September 28"
            );
            assert_eq!(
                format_day_heading("2027-01-04", today),
                "Monday, January 4, 2027"
            );
            assert_eq!(schedule_heading(today, today), "Today");
            assert_eq!(schedule_heading("2026-10-13", today), "Tomorrow");
            assert_eq!(schedule_heading("2026-10-16", today), "Fri 10/16");
            for (deadline, expected) in [
                ("2026-10-16", "due 10/16"),
                ("2026-10-15", "3 days left"),
                ("2026-10-14", "2 days left"),
                ("2026-10-13", "1 day left"),
                (today, "due today"),
                ("2026-10-11", "1 day overdue"),
                ("2026-10-10", "2 days overdue"),
            ] {
                assert_eq!(deadline_status(deadline, today).1, expected, "{deadline}");
            }
        });
    }

    #[test]
    fn 日本語の締切は_1日でも同じ形() {
        with_lang(Lang::Ja, || {
            assert_eq!(deadline_status("2026-10-13", ENGLISH_TODAY).1, "あと1日");
            assert_eq!(deadline_status("2026-10-11", ENGLISH_TODAY).1, "1日超過");
        });
    }
}
