//! ロゴ「接」。ふたつの正方形が、角の一点だけで触れている。
//! サイドバーは止まった 6×3 セル、ログインの画面は 24×10 の半ブロックで、離れていた正方形が寄って触れ、そこで止まる

use std::time::Duration;

use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

use crate::ui::theme;

/// ブランドの字。名前そのものなので翻訳しない（`i18n` の表に入れない）。コマンドの名前は小文字の `nagi` のまま
pub const WORDMARK: &str = "Nagi";

pub const SIDEBAR_LOGO_HEIGHT: u16 = SIDEBAR_MARK.len() as u16;
pub const LOGIN_LOGO_WIDTH: u16 = 24;
pub const LOGIN_LOGO_HEIGHT: u16 = 10;

/// 正方形が寄って触れるまでの時間。過ぎたら最後のコマのまま動かさない
const MOTION: Duration = Duration::from_millis(1000);
const FRAME: Duration = Duration::from_millis(50);

/// サイドバーのマーク（試作の `side.rows` そのまま）。字と、その字を塗る正方形（a・b、空白は塗らない）
const SIDEBAR_MARK: [(&str, &str); 3] = [
    ("███   ", "aaa   "),
    ("▀▀▀▄▄▄", "aaabbb"),
    ("   ███", "   bbb"),
];
/// `Nagi` を置くマークの行
const SIDEBAR_TEXT_ROW: usize = 1;

const LOGIN_TEXT_ROW: usize = 8;
const LOGIN_TEXT_COLUMN: usize = 10;
/// 1 セルを縦横 8 つずつに分けて数える（試作の描き方と同じ）
const SAMPLES: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Square {
    A,
    B,
}

fn square_color(square: Square) -> Color {
    match square {
        Square::A => theme::BRAND_MARK_A,
        Square::B => theme::BRAND_MARK_B,
    }
}

/// サイドバーの見出し。マーク、1 桁あけて太字の `Nagi`。left はマークの左の余白の桁数
pub fn sidebar_lines(left: usize) -> Vec<Line<'static>> {
    SIDEBAR_MARK
        .iter()
        .enumerate()
        .map(|(row, &(glyphs, paint))| {
            let mut spans = vec![Span::raw(" ".repeat(left))];
            for ((i, ch), square) in glyphs.char_indices().zip(paint.chars()) {
                let style = match square {
                    'a' => Style::new().fg(theme::BRAND_MARK_A),
                    'b' => Style::new().fg(theme::BRAND_MARK_B),
                    _ => Style::new(),
                };
                spans.push(Span::styled(&glyphs[i..i + ch.len_utf8()], style));
            }
            if row == SIDEBAR_TEXT_ROW {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    WORDMARK,
                    theme::accent().add_modifier(Modifier::BOLD),
                ));
            }
            Line::from(spans)
        })
        .collect()
}

fn ease(x: f32) -> f32 {
    1.0 - (1.0 - x.clamp(0.0, 1.0)).powi(3)
}

/// セルの座標 (x 列, y 行) で、その時点の正方形のどちらにかかるか。
/// 最後は A が x 7–12・y 1–3.5、B が x 12–17・y 3.5–6 で、角 (12, 3.5) の一点だけで触れる。
/// 1 行は 1 列の約 2 倍の高さなので、半行 = 1 列で正方形になり、寄る向きも斜め 45°に見える
fn login_square(elapsed: Duration, x: f32, y: f32) -> Option<Square> {
    let k = if elapsed >= MOTION {
        1.0
    } else {
        ease(elapsed.as_secs_f32() / MOTION.as_secs_f32())
    };
    let d = 2.0 * (1.0 - k);
    let inside = |x: f32, y: f32, x0: f32, x1: f32, y0: f32, y1: f32| {
        (x0..=x1).contains(&x) && (y0..=y1).contains(&y)
    };
    if inside(x + d, y + d * 0.5, 7.0, 12.0, 1.0, 3.5) {
        Some(Square::A)
    } else if inside(x - d, y - d * 0.5, 12.0, 17.0, 3.5, 6.0) {
        Some(Square::B)
    } else {
        None
    }
}

/// 塗りの数え。同数なら空を選び、そのほかは最初に出てきたものを選ぶ（試作の Map の順と同じにする）
#[derive(Clone, Copy, Default)]
struct Tally {
    keys: [Option<Square>; 3],
    counts: [usize; 3],
    len: usize,
}

impl Tally {
    fn add(&mut self, key: Option<Square>, count: usize) {
        match self.keys[..self.len].iter().position(|k| *k == key) {
            Some(i) => self.counts[i] += count,
            None => {
                self.keys[self.len] = key;
                self.counts[self.len] = count;
                self.len += 1;
            }
        }
    }

    /// 合わせた数えで一番多いものと、それに合わないサンプルの数
    fn best(parts: &[&Tally]) -> (Option<Square>, usize) {
        let mut total = Tally::default();
        for part in parts {
            for i in 0..part.len {
                total.add(part.keys[i], part.counts[i]);
            }
        }
        let (mut key, mut most) = (None, 0);
        for i in 0..total.len {
            let (k, v) = (total.keys[i], total.counts[i]);
            if v > most || (v == most && k.is_none()) {
                (key, most) = (k, v);
            }
        }
        let quarter = SAMPLES * SAMPLES / 4;
        (key, parts.len() * quarter - most)
    }
}

/// 1 セルを、全部塗る・上下に分ける・左右に分けるのうち、外れるサンプルが一番少ない形にする
fn login_cell(elapsed: Duration, column: usize, row: usize) -> Span<'static> {
    let mut quads = [Tally::default(); 4];
    for i in 0..SAMPLES {
        for j in 0..SAMPLES {
            let x = column as f32 + (j as f32 + 0.5) / SAMPLES as f32;
            let y = row as f32 + (i as f32 + 0.5) / SAMPLES as f32;
            let quad = usize::from(i >= SAMPLES / 2) * 2 + usize::from(j >= SAMPLES / 2);
            quads[quad].add(login_square(elapsed, x, y), 1);
        }
    }
    let [q0, q1, q2, q3] = &quads;
    let (full, full_miss) = Tally::best(&[q0, q1, q2, q3]);
    let (top, top_miss) = Tally::best(&[q0, q1]);
    let (bottom, bottom_miss) = Tally::best(&[q2, q3]);
    let (left, left_miss) = Tally::best(&[q0, q2]);
    let (right, right_miss) = Tally::best(&[q1, q3]);
    let (ch, fg, bg) = if full_miss <= top_miss + bottom_miss && full_miss <= left_miss + right_miss
    {
        ("█", full, None)
    } else if top_miss + bottom_miss <= left_miss + right_miss {
        split("▀", "▄", top, bottom)
    } else {
        split("▌", "▐", left, right)
    };
    let Some(fg) = fg else {
        return Span::raw(" ");
    };
    let mut style = Style::new().fg(square_color(fg));
    if let Some(bg) = bg {
        style = style.bg(square_color(bg));
    }
    Span::styled(ch, style)
}

/// 半分ずつに分けたセル。first は前半（上か左）を塗る字、second は後半を塗る字
fn split(
    first: &'static str,
    second: &'static str,
    a: Option<Square>,
    b: Option<Square>,
) -> (&'static str, Option<Square>, Option<Square>) {
    match (a, b) {
        (Some(a), Some(b)) if a == b => ("█", Some(a), None),
        (Some(a), Some(b)) => (first, Some(a), Some(b)),
        (Some(a), None) => (first, Some(a), None),
        (None, Some(b)) => (second, Some(b), None),
        (None, None) => (" ", None, None),
    }
}

/// ログインの画面を出してからの時間に合わせた、ロゴの 1 コマ（24 桁 × 10 行、`Nagi` は 9 行目のまん中）
pub fn login_lines(elapsed: Duration) -> Vec<Line<'static>> {
    let text = LOGIN_TEXT_COLUMN..LOGIN_TEXT_COLUMN + WORDMARK.len();
    (0..LOGIN_LOGO_HEIGHT as usize)
        .map(|row| {
            let mut spans = Vec::with_capacity(LOGIN_LOGO_WIDTH as usize);
            for column in 0..LOGIN_LOGO_WIDTH as usize {
                if row == LOGIN_TEXT_ROW && column == text.start {
                    spans.push(Span::styled(
                        WORDMARK,
                        Style::new()
                            .fg(theme::BRAND_INK)
                            .add_modifier(Modifier::BOLD),
                    ));
                } else if !(row == LOGIN_TEXT_ROW && text.contains(&column)) {
                    spans.push(login_cell(elapsed, column, row));
                }
            }
            Line::from(spans)
        })
        .collect()
}

/// ログインのロゴを動かすための、次の描き直しまでの間隔。動き終わったら None（ロゴのためには描き直さない）
pub fn login_redraw_after(elapsed: Duration) -> Option<Duration> {
    (elapsed < MOTION).then_some(FRAME)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cells(line: &Line) -> Vec<(String, Style)> {
        line.spans
            .iter()
            .flat_map(|span| span.content.chars().map(|ch| (ch.to_string(), span.style)))
            .collect()
    }

    fn frames() -> impl Iterator<Item = Duration> {
        (0..=30)
            .map(|i| Duration::from_millis(i * 50))
            .chain([Duration::from_secs(24 * 60 * 60)])
    }

    #[test]
    fn ログインのロゴはどの時点でも24桁10行に収まる() {
        for elapsed in frames() {
            let lines = login_lines(elapsed);
            assert_eq!(lines.len(), LOGIN_LOGO_HEIGHT as usize, "{elapsed:?}");
            for line in &lines {
                assert_eq!(line.width(), LOGIN_LOGO_WIDTH as usize, "{elapsed:?}");
                for (ch, style) in cells(line) {
                    let allowed = [" ", "█", "▀", "▄", "▌", "▐", "N", "a", "g", "i"];
                    assert!(allowed.contains(&ch.as_str()), "{elapsed:?} の {ch}");
                    if ch != " " && !WORDMARK.contains(&ch) {
                        assert!(
                            [Some(theme::BRAND_MARK_A), Some(theme::BRAND_MARK_B)]
                                .contains(&style.fg),
                            "{elapsed:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn サイドバーのロゴは見出しの3行に収まる() {
        let lines = sidebar_lines(1);
        assert_eq!(lines.len(), SIDEBAR_LOGO_HEIGHT as usize);
        let widths: Vec<usize> = lines.iter().map(Line::width).collect();
        // マークは 1 桁目から 6 桁、1 桁あけて Nagi
        assert_eq!(widths, [7, 1 + 6 + 1 + 4, 7]);
        assert_eq!(lines[1].spans.last().unwrap().content, WORDMARK);
    }

    /// 半ブロックを、縦に 2 倍した画素（列, 半行）の塗りに戻す
    fn pixels(lines: &[Line]) -> Vec<Vec<Option<Color>>> {
        let mut grid = Vec::new();
        for line in lines {
            let mut top = Vec::new();
            let mut bottom = Vec::new();
            for (ch, style) in cells(line) {
                let (t, b) = match ch.as_str() {
                    "█" => (style.fg, style.fg),
                    "▀" => (style.fg, style.bg),
                    "▄" => (style.bg, style.fg),
                    " " => (None, None),
                    _ if WORDMARK.contains(&ch) => (None, None),
                    other => panic!("最後のコマに左右を分けた字 {other} がある"),
                };
                top.push(t);
                bottom.push(b);
            }
            grid.push(top);
            grid.push(bottom);
        }
        grid
    }

    #[test]
    fn 最後のコマで正方形は角の一点だけで触れる() {
        let grid = pixels(&login_lines(MOTION));
        let box_of = |color: Color| {
            let mut found: Vec<(usize, usize)> = Vec::new();
            for (y, row) in grid.iter().enumerate() {
                for (x, pixel) in row.iter().enumerate() {
                    if *pixel == Some(color) {
                        found.push((x, y));
                    }
                }
            }
            let xs = found.iter().map(|p| p.0);
            let ys = found.iter().map(|p| p.1);
            let bounds = (
                xs.clone().min().unwrap(),
                xs.max().unwrap(),
                ys.clone().min().unwrap(),
                ys.max().unwrap(),
            );
            // 中に穴がなく、四角く埋まっている
            let (x0, x1, y0, y1) = bounds;
            assert_eq!(found.len(), (x1 - x0 + 1) * (y1 - y0 + 1));
            bounds
        };
        let a = box_of(theme::BRAND_MARK_A);
        let b = box_of(theme::BRAND_MARK_B);
        // 縦横が同じ画素数の、同じ大きさの正方形
        assert_eq!(a.1 - a.0, a.3 - a.2);
        assert_eq!((a.1 - a.0, a.3 - a.2), (b.1 - b.0, b.3 - b.2));
        // B の左上の画素は、A の右下の画素と斜めに隣り合う（重ならず、すき間もない）
        assert_eq!((b.0, b.2), (a.1 + 1, a.3 + 1));
        assert_eq!(login_lines(MOTION), login_lines(MOTION * 1000));
    }

    #[test]
    fn 動き終わったらロゴのためには描き直さない() {
        assert_eq!(login_redraw_after(Duration::ZERO), Some(FRAME));
        assert_eq!(login_redraw_after(MOTION - FRAME), Some(FRAME));
        assert_eq!(login_redraw_after(MOTION), None);
        assert_eq!(login_redraw_after(Duration::from_secs(60)), None);
    }
}
