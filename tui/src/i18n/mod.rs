//! 画面と CLI の文字の表。文は `messages.rs` の 1 か所にあり、鍵（`Msg`）で引く。
//! 文はビルドのときに決まる `&'static str` で、鍵の書き忘れ・打ち間違いはビルドで落ちる

use std::fmt::{Display, Write};
use std::sync::OnceLock;

mod messages;

pub use messages::Msg;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ja,
}

impl Lang {
    /// `--lang` に渡せる値
    pub const CODES: [&str; 1] = ["ja"];

    fn from_code(code: &str) -> Option<Lang> {
        match code {
            "ja" => Some(Lang::Ja),
            _ => None,
        }
    }
}

/// 言語を決める手がかり。見る順に並んでいる
#[derive(Clone, Copy, Debug, Default)]
pub struct LangSources<'a> {
    /// `--lang`
    pub flag: Option<&'a str>,
    /// `prefs.json` の `lang`
    pub prefs: Option<&'a str>,
    pub lc_all: Option<&'a str>,
    pub lc_messages: Option<&'a str>,
    pub lang: Option<&'a str>,
}

impl<'a> LangSources<'a> {
    /// 最初の空でない値
    fn first_set(&self) -> Option<&'a str> {
        [
            self.flag,
            self.prefs,
            self.lc_all,
            self.lc_messages,
            self.lang,
        ]
        .into_iter()
        .flatten()
        .find(|value| !value.is_empty())
    }
}

/// 使う言語を決める。`--lang`、覚え書き、`LC_ALL`、`LC_MESSAGES`、`LANG` の順に見て、最初の空でない値を使う
pub fn resolve_lang(sources: &LangSources) -> Lang {
    match sources.first_set() {
        Some(value) if value.starts_with("ja") => Lang::Ja,
        // 言語は日本語だけなので、どの値でも日本語になる
        _ => Lang::Ja,
    }
}

/// `--lang` の値を確かめる。`resolve_lang` と違い、知らない値は断る
pub fn check_lang_flag(value: &str) -> Result<(), String> {
    match Lang::from_code(value) {
        Some(_) => Ok(()),
        None => Err(fill(
            Msg::LangUnsupported,
            &[&value, &Lang::CODES.join(t(Msg::ListSeparator))],
        )),
    }
}

static CURRENT: OnceLock<Lang> = OnceLock::new();

/// 画面と CLI の言語を決める。引数の誤りの文も表を通すので、引数を読む前に呼ぶ
pub fn init(lang: Lang) {
    let _ = CURRENT.set(lang);
}

impl Msg {
    fn text(self, lang: Lang) -> &'static str {
        match lang {
            Lang::Ja => self.ja(),
        }
    }
}

pub fn t(msg: Msg) -> &'static str {
    msg.text(CURRENT.get().copied().unwrap_or(Lang::Ja))
}

/// `{0}`・`{1}` の番号の穴に値を入れる。言語で語順が変わっても書けるように、番号で指す
pub fn fill(msg: Msg, args: &[&dyn Display]) -> String {
    let template = t(msg);
    let mut out = String::with_capacity(template.len() + 16);
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        match hole(after) {
            Some((number, len)) => {
                let _ = write!(out, "{}", args[number]);
                rest = &after[len..];
            }
            None => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `{` の直後から、`番号}` を読む。番号と、`}` までを含む長さを返す
fn hole(after: &str) -> Option<(usize, usize)> {
    let close = after.find('}')?;
    let number = after[..close].parse().ok()?;
    Some((number, close + 1))
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use super::*;

    fn holes(template: &str) -> Vec<usize> {
        let mut found = Vec::new();
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            let after = &rest[open + 1..];
            match hole(after) {
                Some((number, len)) => {
                    found.push(number);
                    rest = &after[len..];
                }
                None => rest = after,
            }
        }
        found
    }

    struct Literal {
        line: usize,
        column: usize,
        text: String,
        raw: bool,
    }

    /// ソースの文字列リテラルを集める。コメントと、`mod tests` から後ろは見ない
    fn string_literals(source: &str) -> Vec<Literal> {
        let lines: Vec<&str> = source.lines().collect();
        let end = (0..lines.len().saturating_sub(1))
            .find(|&i| lines[i].trim() == "#[cfg(test)]" && lines[i + 1].starts_with("mod "))
            .unwrap_or(lines.len());
        let chars: Vec<char> = lines[..end].join("\n").chars().collect();
        let is_ident = |c: char| c.is_alphanumeric() || c == '_';
        let (mut i, mut line, mut line_start) = (0, 1, 0);
        let mut found = Vec::new();
        while i < chars.len() {
            match chars[i] {
                '\n' => {
                    line += 1;
                    i += 1;
                    line_start = i;
                }
                '/' if chars.get(i + 1) == Some(&'/') => {
                    while i < chars.len() && chars[i] != '\n' {
                        i += 1;
                    }
                }
                '/' if chars.get(i + 1) == Some(&'*') => {
                    while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                        if chars[i] == '\n' {
                            line += 1;
                            line_start = i + 1;
                        }
                        i += 1;
                    }
                    i += 2;
                }
                '\'' => {
                    if chars.get(i + 1) == Some(&'\\') {
                        i += 2;
                        while i < chars.len() && chars[i] != '\'' {
                            i += 1;
                        }
                        i += 1;
                    } else if chars.get(i + 2) == Some(&'\'') {
                        i += 3;
                    } else {
                        i += 1;
                    }
                }
                'r' if i == 0 || !is_ident(chars[i - 1]) => {
                    let hashes = chars[i + 1..].iter().take_while(|&&c| c == '#').count();
                    if chars.get(i + 1 + hashes) != Some(&'"') {
                        i += 1;
                        continue;
                    }
                    let (start_line, column) = (line, i - line_start);
                    let body = i + 2 + hashes;
                    let mut close = body;
                    while close < chars.len()
                        && !(chars[close] == '"'
                            && chars[close + 1..].iter().take(hashes).all(|&c| c == '#'))
                    {
                        if chars[close] == '\n' {
                            line += 1;
                            line_start = close + 1;
                        }
                        close += 1;
                    }
                    found.push(Literal {
                        line: start_line,
                        column,
                        text: chars[body..close].iter().collect(),
                        raw: true,
                    });
                    i = close + 1 + hashes;
                }
                '"' => {
                    let (start_line, column) = (line, i - line_start);
                    let body = i + 1;
                    let mut close = body;
                    while close < chars.len() && chars[close] != '"' {
                        if chars[close] == '\\' {
                            close += 1;
                        }
                        if chars.get(close) == Some(&'\n') {
                            line += 1;
                            line_start = close + 1;
                        }
                        close += 1;
                    }
                    found.push(Literal {
                        line: start_line,
                        column,
                        text: chars[body..close.min(chars.len())].iter().collect(),
                        raw: false,
                    });
                    i = close + 1;
                }
                _ => i += 1,
            }
        }
        found
    }

    fn is_japanese(c: char) -> bool {
        matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{4dbf}' | '\u{4e00}'..='\u{9fff}')
    }

    fn rust_files(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                rust_files(&path, found);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                found.push(path);
            }
        }
    }

    /// 入力を読むための語の場所（表に移さず、今の場所に残す）：`match` の腕の左側の語、
    /// 日付の入力を読む正規表現（raw string）、曜日の入力の表
    const INPUT_WORDS: [(&str, &str); 2] = [
        ("dates.rs", "const WEEKDAYS:"),
        ("dates.rs", "found[2] == "),
    ];

    #[test]
    fn no_user_literal_outside_catalog() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        rust_files(&src, &mut files);
        let mut offenders = Vec::new();
        for file in files {
            let relative = file
                .strip_prefix(&src)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if relative.starts_with("i18n/") || relative == "data/tests.rs" {
                continue;
            }
            let source = std::fs::read_to_string(&file).unwrap();
            let lines: Vec<&str> = source.lines().collect();
            for literal in string_literals(&source) {
                if literal.raw || !literal.text.chars().any(is_japanese) {
                    continue;
                }
                let line = lines[literal.line - 1];
                let is_match_pattern = line.trim_start().starts_with('"')
                    && line.find("=>").is_some_and(|arrow| {
                        let byte = line
                            .char_indices()
                            .nth(literal.column)
                            .map_or(0, |(b, _)| b);
                        byte < arrow
                    });
                let is_input_table = INPUT_WORDS
                    .iter()
                    .any(|(name, fragment)| relative == *name && line.contains(fragment));
                if !is_match_pattern && !is_input_table {
                    offenders.push(format!("{relative}:{}: {}", literal.line, line.trim()));
                }
            }
        }
        assert!(
            offenders.is_empty(),
            "日本語の文字列リテラルは i18n/messages.rs の表に置く：\n{}",
            offenders.join("\n")
        );
    }

    #[test]
    fn every_message_has_japanese() {
        for msg in Msg::ALL {
            let text = msg.ja();
            assert!(!text.is_empty(), "{msg:?} が空です");
            let mut numbers = holes(text);
            numbers.sort_unstable();
            numbers.dedup();
            let expected: Vec<usize> = (0..numbers.len()).collect();
            assert_eq!(
                numbers, expected,
                "{msg:?} の穴の番号が 0 から続いていません"
            );
        }
    }

    #[test]
    fn fill_puts_values_by_number() {
        assert_eq!(
            fill(Msg::LangUnsupported, &[&"fr", &"ja"]),
            "知らない言語です：fr（使える値：ja）"
        );
    }

    #[test]
    fn lang_flag_accepts_only_known_codes() {
        assert_eq!(check_lang_flag("ja"), Ok(()));
        assert_eq!(
            check_lang_flag("fr"),
            Err("知らない言語です：fr（使える値：ja）".to_string())
        );
    }

    #[test]
    fn sources_are_read_in_order() {
        let all = LangSources {
            flag: Some("flag"),
            prefs: Some("prefs"),
            lc_all: Some("lc_all"),
            lc_messages: Some("lc_messages"),
            lang: Some("lang"),
        };
        assert_eq!(all.first_set(), Some("flag"));
        let without = |drop: fn(&mut LangSources<'static>)| {
            let mut sources = all;
            drop(&mut sources);
            sources.first_set()
        };
        assert_eq!(without(|s| s.flag = None), Some("prefs"));
        assert_eq!(
            without(|s| {
                s.flag = None;
                s.prefs = None;
            }),
            Some("lc_all")
        );
        assert_eq!(
            without(|s| {
                s.flag = None;
                s.prefs = None;
                s.lc_all = None;
            }),
            Some("lc_messages")
        );
        assert_eq!(
            without(|s| {
                s.flag = None;
                s.prefs = None;
                s.lc_all = None;
                s.lc_messages = None;
            }),
            Some("lang")
        );
    }

    #[test]
    fn empty_sources_are_skipped() {
        let sources = LangSources {
            flag: Some(""),
            prefs: Some(""),
            lc_all: Some("ja_JP.UTF-8"),
            lc_messages: Some("C"),
            lang: Some("C"),
        };
        assert_eq!(sources.first_set(), Some("ja_JP.UTF-8"));
        assert_eq!(LangSources::default().first_set(), None);
        assert_eq!(resolve_lang(&sources), Lang::Ja);
        assert_eq!(resolve_lang(&LangSources::default()), Lang::Ja);
    }
}
