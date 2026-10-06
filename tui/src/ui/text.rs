//! 文字の幅（全角は 2 桁）をそろえる道具と、入力欄（1行・複数行）

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

pub fn width(text: &str) -> usize {
    UnicodeWidthStr::width(text)
}

/// 表示の幅が max に収まるように切る（切ったら末尾に「…」）
pub fn truncate(text: &str, max: usize) -> String {
    if width(text) <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let mut out = String::new();
    let mut used = 0;
    for c in text.chars() {
        let w = c.width().unwrap_or(0);
        if used + w > max - 1 {
            break;
        }
        out.push(c);
        used += w;
    }
    out.push('…');
    out
}

/// 表示の幅が total になるように、右を空白で埋める（長ければ切る）
pub fn pad(text: &str, total: usize) -> String {
    let cut = truncate(text, total);
    let fill = total.saturating_sub(width(&cut));
    format!("{cut}{}", " ".repeat(fill))
}

/// 表示の幅で折り返す（改行でも区切る）
pub fn wrap(text: &str, max: usize) -> Vec<String> {
    let max = max.max(2);
    let mut lines = Vec::new();
    for raw in text.split('\n') {
        let mut line = String::new();
        let mut used = 0;
        for c in raw.chars() {
            let w = c.width().unwrap_or(0);
            if used + w > max {
                lines.push(std::mem::take(&mut line));
                used = 0;
            }
            line.push(c);
            used += w;
        }
        lines.push(line);
    }
    lines
}

/// 検索のために文字をそろえる（全角・半角と大文字・小文字の違いを吸収する）
pub fn fold(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    text.nfkc().collect::<String>().to_lowercase()
}

/// 空白で区切った言葉がすべて含まれるか
pub fn matches_query(haystack: &str, query: &str) -> bool {
    let haystack = fold(haystack);
    fold(query)
        .split_whitespace()
        .all(|word| haystack.contains(word))
}

/// 入力欄が受けたキーの結果
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InputOutcome {
    /// 文字やカーソルが変わった
    Changed,
    /// 入力欄では使わないキー（呼んだ側が Enter・Esc などを扱う）
    Ignored,
}

/// 1行の入力欄。カーソルは文字の位置（何文字目の前か）
#[derive(Clone, Debug, Default)]
pub struct TextInput {
    chars: Vec<char>,
    cursor: usize,
}

impl TextInput {
    pub fn new(text: &str) -> TextInput {
        let chars: Vec<char> = text.chars().filter(|c| *c != '\n').collect();
        TextInput {
            cursor: chars.len(),
            chars,
        }
    }

    pub fn text(&self) -> String {
        self.chars.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.chars.is_empty()
    }

    pub fn set(&mut self, text: &str) {
        *self = TextInput::new(text);
    }

    pub fn clear(&mut self) {
        self.chars.clear();
        self.cursor = 0;
    }

    pub fn insert_str(&mut self, text: &str) {
        for c in text.chars().filter(|c| !c.is_control()) {
            self.chars.insert(self.cursor, c);
            self.cursor += 1;
        }
    }

    /// カーソルの手前までの表示の幅
    pub fn cursor_width(&self) -> usize {
        self.chars[..self.cursor]
            .iter()
            .map(|c| c.width().unwrap_or(0))
            .sum()
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> InputOutcome {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Char('a') if ctrl => self.cursor = 0,
            KeyCode::Char('e') if ctrl => self.cursor = self.chars.len(),
            KeyCode::Char('u') if ctrl => {
                self.chars.drain(..self.cursor);
                self.cursor = 0;
            }
            KeyCode::Char('k') if ctrl => self.chars.truncate(self.cursor),
            KeyCode::Char('w') if ctrl => self.delete_word(),
            KeyCode::Backspace if alt => self.delete_word(),
            KeyCode::Char(c) if !ctrl && !alt => {
                self.chars.insert(self.cursor, c);
                self.cursor += 1;
            }
            KeyCode::Backspace => {
                if self.cursor == 0 {
                    return InputOutcome::Ignored;
                }
                self.cursor -= 1;
                self.chars.remove(self.cursor);
            }
            KeyCode::Delete => {
                if self.cursor < self.chars.len() {
                    self.chars.remove(self.cursor);
                }
            }
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.chars.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.chars.len(),
            _ => return InputOutcome::Ignored,
        }
        InputOutcome::Changed
    }

    fn delete_word(&mut self) {
        let mut start = self.cursor;
        while start > 0 && self.chars[start - 1].is_whitespace() {
            start -= 1;
        }
        while start > 0 && !self.chars[start - 1].is_whitespace() {
            start -= 1;
        }
        self.chars.drain(start..self.cursor);
        self.cursor = start;
    }

    /// 幅 max の欄に出す文字と、その中でのカーソルの位置（長いときはカーソルが見えるように左を切る）
    pub fn visible(&self, max: usize) -> (String, usize) {
        let max = max.max(1);
        let cursor_width = self.cursor_width();
        let mut skip = 0;
        let mut skipped_width = 0;
        while cursor_width - skipped_width >= max && skip < self.cursor {
            skipped_width += self.chars[skip].width().unwrap_or(0);
            skip += 1;
        }
        let mut out = String::new();
        let mut used = 0;
        for c in &self.chars[skip..] {
            let w = c.width().unwrap_or(0);
            if used + w > max {
                break;
            }
            out.push(*c);
            used += w;
        }
        (out, cursor_width - skipped_width)
    }
}

/// 複数行の入力欄（メモ）
#[derive(Clone, Debug)]
pub struct TextArea {
    lines: Vec<Vec<char>>,
    row: usize,
    col: usize,
}

impl TextArea {
    pub fn new(text: &str) -> TextArea {
        let lines: Vec<Vec<char>> = text
            .split('\n')
            .map(|line| line.chars().collect())
            .collect();
        let row = lines.len() - 1;
        let col = lines[row].len();
        TextArea { lines, row, col }
    }

    pub fn text(&self) -> String {
        self.lines
            .iter()
            .map(|line| line.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn lines(&self) -> Vec<String> {
        self.lines
            .iter()
            .map(|line| line.iter().collect())
            .collect()
    }

    /// カーソルの行と、その行の中での表示の幅
    pub fn cursor(&self) -> (usize, usize) {
        let width = self.lines[self.row][..self.col]
            .iter()
            .map(|c| c.width().unwrap_or(0))
            .sum();
        (self.row, width)
    }

    pub fn insert_str(&mut self, text: &str) {
        for c in text.chars() {
            match c {
                '\n' => self.newline(),
                '\r' => {}
                c if c.is_control() => {}
                c => {
                    self.lines[self.row].insert(self.col, c);
                    self.col += 1;
                }
            }
        }
    }

    fn newline(&mut self) {
        let rest = self.lines[self.row].split_off(self.col);
        self.lines.insert(self.row + 1, rest);
        self.row += 1;
        self.col = 0;
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> InputOutcome {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        match key.code {
            KeyCode::Char('a') if ctrl => self.col = 0,
            KeyCode::Char('e') if ctrl => self.col = self.lines[self.row].len(),
            KeyCode::Char('j') if ctrl => self.newline(),
            KeyCode::Char(c) if !ctrl && !alt => {
                self.lines[self.row].insert(self.col, c);
                self.col += 1;
            }
            KeyCode::Enter => self.newline(),
            KeyCode::Backspace => {
                if self.col > 0 {
                    self.col -= 1;
                    self.lines[self.row].remove(self.col);
                } else if self.row > 0 {
                    let line = self.lines.remove(self.row);
                    self.row -= 1;
                    self.col = self.lines[self.row].len();
                    self.lines[self.row].extend(line);
                }
            }
            KeyCode::Delete => {
                if self.col < self.lines[self.row].len() {
                    self.lines[self.row].remove(self.col);
                } else if self.row + 1 < self.lines.len() {
                    let line = self.lines.remove(self.row + 1);
                    self.lines[self.row].extend(line);
                }
            }
            KeyCode::Left => {
                if self.col > 0 {
                    self.col -= 1;
                } else if self.row > 0 {
                    self.row -= 1;
                    self.col = self.lines[self.row].len();
                }
            }
            KeyCode::Right => {
                if self.col < self.lines[self.row].len() {
                    self.col += 1;
                } else if self.row + 1 < self.lines.len() {
                    self.row += 1;
                    self.col = 0;
                }
            }
            KeyCode::Up => {
                if self.row == 0 {
                    return InputOutcome::Ignored;
                }
                self.row -= 1;
                self.col = self.col.min(self.lines[self.row].len());
            }
            KeyCode::Down => {
                if self.row + 1 >= self.lines.len() {
                    return InputOutcome::Ignored;
                }
                self.row += 1;
                self.col = self.col.min(self.lines[self.row].len());
            }
            KeyCode::Home => self.col = 0,
            KeyCode::End => self.col = self.lines[self.row].len(),
            _ => return InputOutcome::Ignored,
        }
        InputOutcome::Changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn 全角は2桁で数えて切る() {
        assert_eq!(width("見積もりabc"), 11);
        assert_eq!(truncate("見積もりの確認", 9), "見積もり…");
        assert_eq!(truncate("abc", 3), "abc");
        assert_eq!(pad("今日", 6), "今日  ");
        assert_eq!(wrap("あいうえお\nか", 6), vec!["あいう", "えお", "か"]);
    }

    #[test]
    fn 全角と半角_大文字と小文字を区別せずに探す() {
        assert!(matches_query("ＡＢＣ請求書の確認", "abc 確認"));
        assert!(!matches_query("請求書の確認", "見積"));
        assert!(matches_query("なんでも", ""));
    }

    #[test]
    fn 入力欄は文字の途中に入れたり消したりできる() {
        let mut input = TextInput::new("牛乳");
        input.handle_key(key(KeyCode::Left));
        input.insert_str("と卵と");
        assert_eq!(input.text(), "牛と卵と乳");
        input.handle_key(key(KeyCode::Backspace));
        assert_eq!(input.text(), "牛と卵乳");
        assert_eq!(input.cursor_width(), 6);
        assert_eq!(
            TextInput::new("").handle_key(key(KeyCode::Backspace)),
            InputOutcome::Ignored
        );
        // 長いときは、カーソルが見えるように左を切る
        let (shown, cursor) = TextInput::new("あいうえおかきくけこ").visible(8);
        assert_eq!((shown.as_str(), cursor), ("くけこ", 6));
    }

    #[test]
    fn 複数行の欄は行をまたいで動ける() {
        let mut area = TextArea::new("1行目\n2行目");
        area.handle_key(key(KeyCode::Enter));
        area.insert_str("3行目");
        assert_eq!(area.text(), "1行目\n2行目\n3行目");
        area.handle_key(key(KeyCode::Home));
        area.handle_key(key(KeyCode::Backspace));
        assert_eq!(area.text(), "1行目\n2行目3行目");
        assert_eq!(area.cursor(), (1, 5));
    }
}
