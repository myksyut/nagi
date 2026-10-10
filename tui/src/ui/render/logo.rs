//! ログインの画面のロゴ。日の出のあと、水面の映りがゆっくり揺れる

use std::time::Duration;

use ratatui::style::{Color, Style};
use ratatui::text::{Line, Span};

pub const LOGO_WIDTH: u16 = 24;
pub const LOGO_HEIGHT: u16 = 10;

/// 混ぜる下地の色。端末の本当の背景色は読み取れず、ほかの配色も暗い端末を前提にしているため、暗い背景だと決めている
const BG: [u8; 3] = [13, 17, 23];
const SUN_TOP: [u8; 3] = [0xFF, 0xD4, 0x7A];
const SUN_BOTTOM: [u8; 3] = [0xFF, 0x6A, 0x4D];
const HORIZON: [u8; 3] = [0xFF, 0xB3, 0x6B];
const WATER_TOP: [u8; 3] = [0xFF, 0x7E, 0x5F];
const WATER_BOTTOM: [u8; 3] = [0x8B, 0x6C, 0xFF];

const WIDTH: usize = LOGO_WIDTH as usize;
const RADIUS: f32 = 5.0;
const SUN_ROWS: usize = 5;
const BARS: [f32; 4] = [10.0, 8.0, 4.0, 2.0];
/// 太陽が昇りきったときの中心の高さ（半ブロック単位）
const FINAL_CY: f32 = RADIUS;

struct Scene {
    sun_cy: f32,
    glow: f32,
    /// 水平線が中央から広がった割合
    reach: f32,
    /// 水面の映りが広がった割合
    spread: f32,
    /// 水面の揺れの位相。日の出が終わるまでは揺らさない
    phase: Option<f32>,
}

fn ease(x: f32) -> f32 {
    1.0 - (1.0 - x.clamp(0.0, 1.0)).powi(3)
}

fn scene(elapsed: Duration) -> Scene {
    let s = elapsed.as_secs_f32();
    let p = ease((s - 0.4) / 1.6);
    Scene {
        sun_cy: FINAL_CY + (2.0 * RADIUS + 1.0) * (1.0 - p),
        glow: 0.75 + 0.25 * p,
        reach: ease(s / 0.7),
        spread: ease((s - 0.9) / 1.4),
        phase: (s > 2.3).then_some((s - 2.3) * 1.6),
    }
}

fn mix(a: [u8; 3], b: [u8; 3], t: f32) -> [u8; 3] {
    let t = t.clamp(0.0, 1.0);
    std::array::from_fn(|i| (a[i] as f32 + (b[i] as f32 - a[i] as f32) * t).round() as u8)
}

fn rgb([r, g, b]: [u8; 3]) -> Color {
    Color::Rgb(r, g, b)
}

#[derive(Clone, Copy)]
struct Cell {
    ch: char,
    fg: Option<Color>,
    bg: Option<Color>,
}

const EMPTY: Cell = Cell {
    ch: ' ',
    fg: None,
    bg: None,
};

/// 4x4 に分けて数えた、1 ピクセルの太陽の色（かかっていなければ None）
fn sun_pixel(x: usize, y: usize, cy: f32, glow: f32) -> Option<Color> {
    let mut hit = 0;
    for sy in 0..4 {
        for sx in 0..4 {
            let dx = x as f32 + (sx as f32 + 0.5) / 4.0 - WIDTH as f32 / 2.0;
            let dy = y as f32 + (sy as f32 + 0.5) / 4.0 - cy;
            if dx * dx + dy * dy <= RADIUS * RADIUS {
                hit += 1;
            }
        }
    }
    if hit < 3 {
        return None;
    }
    let t = (y as f32 - (cy - RADIUS)) / (2.0 * RADIUS - 1.0);
    let sun = mix(SUN_TOP, SUN_BOTTOM, t);
    Some(rgb(mix(BG, sun, (hit as f32 / 13.0).min(1.0) * glow)))
}

fn render(scene: &Scene) -> Vec<Line<'static>> {
    let mut grid = vec![[EMPTY; WIDTH]; LOGO_HEIGHT as usize];

    for (r, row) in grid.iter_mut().take(SUN_ROWS).enumerate() {
        for (x, cell) in row.iter_mut().enumerate() {
            let top = sun_pixel(x, r * 2, scene.sun_cy, scene.glow);
            let bottom = sun_pixel(x, r * 2 + 1, scene.sun_cy, scene.glow);
            *cell = match (top, bottom) {
                (Some(top), Some(bottom)) => Cell {
                    ch: '▀',
                    fg: Some(top),
                    bg: Some(bottom),
                },
                (Some(top), None) => Cell {
                    ch: '▀',
                    fg: Some(top),
                    bg: None,
                },
                (None, Some(bottom)) => Cell {
                    ch: '▄',
                    fg: Some(bottom),
                    bg: None,
                },
                (None, None) => EMPTY,
            };
        }
    }

    let half_width = WIDTH as f32 / 2.0;
    for (x, cell) in grid[SUN_ROWS].iter_mut().enumerate() {
        let dist = (x as f32 + 0.5 - half_width).abs() / half_width;
        if dist > scene.reach {
            continue;
        }
        let edge = ((1.0 - dist) / 0.5).min(1.0) * ((scene.reach - dist) / 0.15 + 0.2).min(1.0);
        *cell = Cell {
            ch: '─',
            fg: Some(rgb(mix(BG, HORIZON, edge))),
            bg: None,
        };
    }

    for (i, base) in BARS.iter().enumerate() {
        let t = i as f32 / (BARS.len() - 1) as f32;
        let wobble = scene
            .phase
            .map_or(0.0, |p| (p + i as f32 * 1.9).sin() * 0.5);
        let half = ((base * scene.spread + wobble) * 2.0).round() / 4.0;
        if half <= 0.0 {
            continue;
        }
        let left_edge = half_width - half;
        let right_edge = half_width + half;
        let shine = scene
            .phase
            .map_or(1.0, |p| 0.82 + 0.18 * (p * 1.3 + i as f32 * 2.4).sin());
        let water = mix(WATER_TOP, WATER_BOTTOM, t);
        let alpha = (0.95 - t * 0.55) * (scene.spread * 1.4).min(1.0) * shine;
        let fg = rgb(mix(BG, water, alpha));
        let row = &mut grid[SUN_ROWS + 1 + i];
        let (first, last) = (left_edge.floor() as usize, right_edge.ceil() as usize);
        for (x, cell) in row.iter_mut().enumerate().take(last).skip(first) {
            let left = left_edge.max(x as f32);
            let right = right_edge.min(x as f32 + 1.0);
            if right - left <= 0.0 {
                continue;
            }
            let ch = if right - left >= 1.0 {
                '━'
            } else if left > x as f32 {
                '╺'
            } else {
                '╸'
            };
            *cell = Cell {
                ch,
                fg: Some(fg),
                bg: None,
            };
        }
    }

    grid.iter()
        .map(|row| {
            Line::from(
                row.iter()
                    .map(|cell| {
                        let mut style = Style::new();
                        if let Some(fg) = cell.fg {
                            style = style.fg(fg);
                        }
                        if let Some(bg) = cell.bg {
                            style = style.bg(bg);
                        }
                        Span::styled(cell.ch.to_string(), style)
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect()
}

/// 画面を出してからの時間に合わせた、ロゴの 1 コマ
pub fn logo_lines(elapsed: Duration) -> Vec<Line<'static>> {
    render(&scene(elapsed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn どの時点でも24桁10行になる() {
        let steps = (0..=100).map(|i| Duration::from_millis(i * 50));
        let day = Duration::from_secs(24 * 60 * 60);
        for elapsed in steps.chain([day]) {
            let lines = logo_lines(elapsed);
            assert_eq!(lines.len(), LOGO_HEIGHT as usize, "{elapsed:?}");
            for line in &lines {
                assert_eq!(line.width(), LOGO_WIDTH as usize, "{elapsed:?}");
            }
        }
    }
}
