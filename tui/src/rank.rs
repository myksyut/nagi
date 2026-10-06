//! 置き場の中の並び順キー（fractional index）。文字列の大小（バイトの順）で並ぶ。
//! Worker 側（src/shared/rank.ts が使う fractional-indexing）と同じキーを作るように移したもの
//! （同じ入力から同じキーが出ることを、JS の実装で作った正解データで確かめている）

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/// 整数部の先頭の文字（A〜Z は負の長さ、a〜z は正の長さ）
const INT_DIGITS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO: u8 = b'0';
const HALF: usize = INT_DIGITS.len() / 2;

/// 並び順キーの長さの上限（Worker と共通）
pub const MAX_RANK_LENGTH: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RankError(pub String);

type Result<T> = std::result::Result<T, RankError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(RankError(message.into()))
}

/// 桁の値。桁でない文字は 0（JS の実装と同じ）
fn digit_index(byte: u8) -> usize {
    DIGITS.iter().position(|&d| d == byte).unwrap_or(0)
}

fn midpoint(a: &[u8], b: Option<&[u8]>) -> Result<Vec<u8>> {
    if let Some(b) = b
        && a >= b
    {
        return err("a >= b");
    }
    if a.last() == Some(&ZERO) || b.is_some_and(|b| b.last() == Some(&ZERO)) {
        return err("trailing zero");
    }
    if let Some(b) = b.filter(|b| !b.is_empty()) {
        // 共通の先頭を外す（a が短ければ 0 で埋めて比べる）
        let mut n = 0;
        while n < b.len() && a.get(n).copied().unwrap_or(ZERO) == b[n] {
            n += 1;
        }
        if n > 0 {
            let mut out = b[..n].to_vec();
            out.extend(midpoint(a.get(n..).unwrap_or(&[]), Some(&b[n..]))?);
            return Ok(out);
        }
    }
    let digit_a = a.first().map_or(0, |&byte| digit_index(byte));
    let digit_b = match b {
        Some(b) => b.first().map_or(0, |&byte| digit_index(byte)),
        None => DIGITS.len(),
    };
    if digit_b > digit_a + 1 {
        // Math.round(0.5 * (a + b))：.5 は切り上げ
        return Ok(vec![DIGITS[(digit_a + digit_b).div_ceil(2)]]);
    }
    match b {
        Some(b) if b.len() > 1 => Ok(b[..1].to_vec()),
        _ => {
            let mut out = vec![DIGITS[digit_a]];
            out.extend(midpoint(a.get(1..).unwrap_or(&[]), None)?);
            Ok(out)
        }
    }
}

fn integer_length(head: u8) -> Result<usize> {
    match INT_DIGITS.iter().position(|&d| d == head) {
        Some(i) if i < HALF => Ok(HALF - i + 1),
        Some(i) => Ok(i - HALF + 2),
        None => err("invalid order key head"),
    }
}

fn integer_part(key: &[u8]) -> Result<&[u8]> {
    let Some(&head) = key.first() else {
        return err("invalid order key");
    };
    let length = integer_length(head)?;
    if length > key.len() {
        return err("invalid order key");
    }
    Ok(&key[..length])
}

fn is_smallest_integer(key: &[u8]) -> bool {
    key.len() == HALF + 1 && key[0] == INT_DIGITS[0] && key[1..].iter().all(|&b| b == ZERO)
}

fn validate_order_key(key: &[u8]) -> Result<()> {
    if is_smallest_integer(key) {
        return err("invalid order key");
    }
    let integer = integer_part(key)?;
    if key.len() > integer.len() && key.last() == Some(&ZERO) {
        return err("invalid order key");
    }
    Ok(())
}

/// 整数部を1つ進める。一番大きい整数なら None
fn increment_integer(x: &[u8]) -> Result<Option<Vec<u8>>> {
    step_integer(x, true)
}

/// 整数部を1つ戻す。一番小さい整数なら None
fn decrement_integer(x: &[u8]) -> Result<Option<Vec<u8>>> {
    step_integer(x, false)
}

fn step_integer(x: &[u8], up: bool) -> Result<Option<Vec<u8>>> {
    let head = *x.first().ok_or(RankError("invalid integer".into()))?;
    if x.len() != integer_length(head)? {
        return err("invalid integer part of order key");
    }
    // 繰り上がり（繰り下がり）で折り返した桁に入れる文字
    let wrapped = if up { ZERO } else { DIGITS[DIGITS.len() - 1] };
    let mut trailing = 0;
    for i in (1..x.len()).rev() {
        let digit = digit_index(x[i]);
        let stepped = if up {
            (digit + 1 < DIGITS.len()).then(|| digit + 1)
        } else {
            digit.checked_sub(1)
        };
        match stepped {
            None => trailing += 1,
            Some(d) => {
                let mut out = x[..i].to_vec();
                out.push(DIGITS[d]);
                out.extend(std::iter::repeat_n(wrapped, trailing));
                return Ok(Some(out));
            }
        }
    }
    let head_index = INT_DIGITS
        .iter()
        .position(|&d| d == head)
        .ok_or(RankError("invalid order key head".into()))?;
    let next_index = if up {
        (head_index + 1 < INT_DIGITS.len()).then_some(head_index + 1)
    } else {
        head_index.checked_sub(1)
    };
    let Some(next_index) = next_index else {
        return Ok(None);
    };
    let next_head = INT_DIGITS[next_index];
    let length = integer_length(next_head)?;
    let mut out = vec![next_head];
    out.extend(std::iter::repeat_n(wrapped, length - 1));
    Ok(Some(out))
}

fn to_string(bytes: Vec<u8>) -> String {
    String::from_utf8(bytes).unwrap_or_default()
}

/// a の後ろ、b の前に入るキー。None は端（先頭・末尾）
pub fn key_between(a: Option<&str>, b: Option<&str>) -> Result<String> {
    let mut a = a.map(str::as_bytes);
    let mut b = b.map(str::as_bytes);
    if let Some(a) = a {
        validate_order_key(a)?;
    }
    if let Some(b) = b {
        validate_order_key(b)?;
    }
    if let (Some(x), Some(y)) = (a, b)
        && x > y
    {
        (a, b) = (Some(y), Some(x));
    }

    let (a, b) = match (a, b) {
        (None, None) => return Ok(to_string(vec![INT_DIGITS[HALF], ZERO])),
        (None, Some(b)) => {
            let ib = integer_part(b)?;
            let fb = &b[ib.len()..];
            if is_smallest_integer(ib) {
                let mut out = ib.to_vec();
                out.extend(midpoint(b"", Some(fb))?);
                return Ok(to_string(out));
            }
            if ib < b {
                return Ok(to_string(ib.to_vec()));
            }
            return match decrement_integer(ib)? {
                Some(out) => Ok(to_string(out)),
                None => err("cannot decrement any more"),
            };
        }
        (Some(a), None) => {
            let ia = integer_part(a)?;
            let fa = &a[ia.len()..];
            return Ok(to_string(match increment_integer(ia)? {
                Some(out) => out,
                None => {
                    let mut out = ia.to_vec();
                    out.extend(midpoint(fa, None)?);
                    out
                }
            }));
        }
        (Some(a), Some(b)) => (a, b),
    };

    let ia = integer_part(a)?;
    let fa = &a[ia.len()..];
    let ib = integer_part(b)?;
    let fb = &b[ib.len()..];
    if ia == ib {
        let mut out = ia.to_vec();
        out.extend(midpoint(fa, Some(fb))?);
        return Ok(to_string(out));
    }
    let Some(next) = increment_integer(ia)? else {
        return err("cannot increment any more");
    };
    if next.as_slice() < b {
        return Ok(to_string(next));
    }
    let mut out = ia.to_vec();
    out.extend(midpoint(fa, None)?);
    Ok(to_string(out))
}

/// a の後ろ、b の前に入る n 個のキー（小さい順）
pub fn n_keys_between(a: Option<&str>, b: Option<&str>, n: usize) -> Result<Vec<String>> {
    if n == 0 {
        return Ok(Vec::new());
    }
    if n == 1 {
        return Ok(vec![key_between(a, b)?]);
    }
    if b.is_none() {
        let mut result = vec![key_between(a, None)?];
        for i in 1..n {
            result.push(key_between(Some(&result[i - 1]), None)?);
        }
        return Ok(result);
    }
    if a.is_none() {
        let mut result = vec![key_between(None, b)?];
        for i in 1..n {
            result.push(key_between(None, Some(&result[i - 1]))?);
        }
        result.reverse();
        return Ok(result);
    }
    let mid = n / 2;
    let c = key_between(a, b)?;
    let mut result = n_keys_between(a, Some(&c), mid)?;
    let upper = n_keys_between(Some(&c), b, n - mid - 1)?;
    result.push(c);
    result.extend(upper);
    Ok(result)
}

/// 並び順キーとして正しい形か（Worker が保存する前に確かめるのと同じ決まり）
pub fn is_valid_rank(rank: &str) -> bool {
    !rank.is_empty()
        && rank.len() <= MAX_RANK_LENGTH
        && rank.bytes().all(|b| b.is_ascii_alphanumeric())
        && key_between(Some(rank), None).is_ok()
}

/// after が before 以下のとき（rank が重なっているとき）は、上の端を外して before の後ろに作る
fn upper_bound<'a>(before: Option<&str>, after: Option<&'a str>) -> Option<&'a str> {
    match (before, after) {
        (Some(before), Some(after)) if after <= before => None,
        _ => after,
    }
}

/// before の後ろ、after の前に入る n 個のキー（小さい順）。None は端。作れなければ空
pub fn ranks_between(before: Option<&str>, after: Option<&str>, n: usize) -> Vec<String> {
    n_keys_between(before, upper_bound(before, after), n).unwrap_or_default()
}

/// rank の順。重なったら id の順
pub fn compare_rank(a: (&str, &str), b: (&str, &str)) -> std::cmp::Ordering {
    a.0.cmp(b.0).then_with(|| a.1.cmp(b.1))
}

/// 日付の到来や締切で今日に入る n 件のキー（小さい順）。位置は「今日来たタスク（arrivedOn が today）の後ろ、
/// それ以外の今日のタスクの前」。今日来たタスクがなければ一番上。
/// today_tasks は今日の置き場にある未完了・未削除のタスクの (id, rank, arrivedOn)
pub fn arrival_ranks(
    today_tasks: &[(&str, &str, Option<&str>)],
    today: &str,
    n: usize,
) -> Vec<String> {
    if n == 0 {
        return Vec::new();
    }
    let mut sorted = today_tasks.to_vec();
    sorted.sort_by(|a, b| compare_rank((a.1, a.0), (b.1, b.0)));
    let last_arrived = sorted.iter().rposition(|task| task.2 == Some(today));
    let before = last_arrived.map(|i| sorted[i].1);
    let after = sorted[last_arrived.map_or(0, |i| i + 1)..]
        .iter()
        .find(|task| before.is_none_or(|before| task.1 > before))
        .map(|task| task.1);
    ranks_between(before, after, n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    struct BetweenCase {
        a: Option<String>,
        b: Option<String>,
        out: Option<String>,
        err: bool,
    }

    #[derive(Deserialize)]
    struct NCase {
        a: Option<String>,
        b: Option<String>,
        n: usize,
        out: Vec<String>,
    }

    #[derive(Deserialize)]
    struct Golden {
        between: Vec<BetweenCase>,
        n: Vec<NCase>,
    }

    fn golden() -> Golden {
        serde_json::from_str(include_str!("testdata/rank_golden.json")).unwrap()
    }

    #[test]
    fn js_の実装と同じキーを作る() {
        for case in golden().between {
            let result = key_between(case.a.as_deref(), case.b.as_deref());
            if case.err {
                assert!(result.is_err(), "{:?} {:?} は失敗するはず", case.a, case.b);
            } else {
                assert_eq!(result.ok(), case.out, "{:?} {:?}", case.a, case.b);
            }
        }
    }

    #[test]
    fn js_の実装と同じ_n_個のキーを作る() {
        for case in golden().n {
            let result = n_keys_between(case.a.as_deref(), case.b.as_deref(), case.n).unwrap();
            assert_eq!(result, case.out, "{:?} {:?} {}", case.a, case.b, case.n);
        }
    }

    #[test]
    fn 正しい形だけを通す() {
        assert!(is_valid_rank("a0"));
        assert!(is_valid_rank("Zz"));
        assert!(!is_valid_rank(""));
        assert!(!is_valid_rank("!!"));
        assert!(!is_valid_rank("a00"));
        let of_length = |length: usize| format!("a0{}1", "0".repeat(length - 3));
        assert!(is_valid_rank(&of_length(1024)));
        assert!(!is_valid_rank(&of_length(1025)));
    }

    #[test]
    fn 同じ隙間へ入れ続けても_1000_回までは上限に届かない() {
        let mut upper = "a1".to_string();
        for _ in 0..1000 {
            upper = ranks_between(Some("a0"), Some(&upper), 1).remove(0);
            assert!(is_valid_rank(&upper));
        }
    }

    #[test]
    fn rank_が重なっていたら_before_の後ろに作る() {
        let keys = ranks_between(Some("a1"), Some("a1"), 2);
        assert_eq!(keys.len(), 2);
        assert!(keys[0].as_str() > "a1" && keys[0] < keys[1]);
    }

    #[test]
    fn 到着の位置は_今日来たタスクの後ろ_ほかのタスクの前() {
        let today = "2026-10-06";
        let tasks = [
            ("1", "a0", Some(today)),
            ("2", "a1", Some(today)),
            ("3", "a2", None),
            ("4", "a3", Some("2026-10-05")),
        ];
        let keys = arrival_ranks(&tasks, today, 2);
        assert_eq!(keys.len(), 2);
        assert!(keys[0].as_str() > "a1" && keys[1].as_str() < "a2" && keys[0] < keys[1]);
        // 今日来たタスクがなければ一番上
        let keys = arrival_ranks(&tasks[2..], today, 1);
        assert!(keys[0].as_str() < "a2");
        assert!(arrival_ranks(&[], today, 1) == vec!["a0".to_string()]);
    }
}
