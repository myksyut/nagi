//! 色。色は意味のあるところにだけ使う：選択は紫、目を向けてほしい印（今日来たタスク・優先度「高」）は琥珀、
//! 赤は締切を過ぎたときだけ。地の色は端末に任せる

use ratatui::style::{Color, Modifier, Style};

/// 選択の紫
pub const ACCENT: Color = Color::Rgb(167, 139, 250);
/// 小さい補助の文字
pub const MUTED: Color = Color::Rgb(150, 150, 172);
/// さらに控えめな文字（区切り・案内）
pub const FAINT: Color = Color::Rgb(104, 104, 128);
/// 目を向けてほしい印
pub const ATTENTION: Color = Color::Rgb(240, 184, 96);
/// 締切を過ぎた
pub const DANGER: Color = Color::Rgb(240, 120, 120);
/// 選んでいる行の地
pub const SELECTED_BG: Color = Color::Rgb(49, 44, 82);
/// カーソルの行の地
pub const CURSOR_BG: Color = Color::Rgb(62, 55, 108);
/// ポップアップの地
pub const SURFACE: Color = Color::Rgb(27, 26, 40);
pub const BORDER: Color = Color::Rgb(78, 74, 110);
/// 進行中
pub const IN_PROGRESS: Color = Color::Rgb(167, 139, 250);

pub fn muted() -> Style {
    Style::new().fg(MUTED)
}

pub fn faint() -> Style {
    Style::new().fg(FAINT)
}

pub fn accent() -> Style {
    Style::new().fg(ACCENT)
}

pub fn bold() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

/// プロジェクトの色（パレットの名前 → 色。彩度を落として明るさをそろえてある）
pub fn project_color(name: Option<&str>) -> Color {
    match name {
        Some("violet") => Color::Rgb(167, 139, 250),
        Some("sky") => Color::Rgb(125, 180, 240),
        Some("pink") => Color::Rgb(232, 140, 190),
        Some("amber") => Color::Rgb(226, 178, 100),
        Some("emerald") => Color::Rgb(110, 200, 150),
        Some("orange") => Color::Rgb(238, 158, 110),
        Some("teal") => Color::Rgb(100, 198, 198),
        Some("slate") => Color::Rgb(150, 160, 182),
        _ => MUTED,
    }
}

/// パレットの色の表示名
pub fn project_color_label(name: &str) -> &'static str {
    match name {
        "violet" => "すみれ",
        "sky" => "空",
        "pink" => "桃",
        "amber" => "琥珀",
        "emerald" => "若葉",
        "orange" => "橙",
        "teal" => "青緑",
        _ => "灰",
    }
}
