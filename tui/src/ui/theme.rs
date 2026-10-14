//! 色。色は意味のあるところにだけ使う：選択は青、目を向けてほしい印（今日来たタスク・優先度「高」）は琥珀、
//! 赤は締切を過ぎたときだけ。地の色は端末に任せる

use crate::i18n::{Msg, t};
use ratatui::style::{Color, Modifier, Style};

/// ブランドの色。ロゴ（`render/logo.rs`）と `assets/*.svg` は、ここと同じ 16 進を使う。色の値を書く場所はここだけ
pub const BRAND_SUN_TOP: Color = Color::Rgb(0xFD, 0xE6, 0x8A);
pub const BRAND_SUN_BOTTOM: Color = Color::Rgb(0xF5, 0xB9, 0x71);
pub const BRAND_HORIZON: Color = Color::Rgb(0x93, 0xC5, 0xFD);
pub const BRAND_WATER_TOP: Color = Color::Rgb(0x60, 0xA5, 0xFA);
pub const BRAND_WATER_BOTTOM: Color = Color::Rgb(0x3B, 0x4C, 0xCA);
/// ロゴを置く暗い地。端末の本当の背景色は読み取れず、ほかの配色も暗い端末を前提にしているため、暗い背景だと決めている
pub const BRAND_GROUND: Color = Color::Rgb(0x0D, 0x11, 0x17);

/// 選択の青
pub const ACCENT: Color = Color::Rgb(96, 165, 250);
/// 小さい補助の文字
pub const MUTED: Color = Color::Rgb(150, 150, 172);
/// さらに控えめな文字（区切り・案内）
pub const FAINT: Color = Color::Rgb(104, 104, 128);
/// 目を向けてほしい印
pub const ATTENTION: Color = Color::Rgb(240, 184, 96);
/// 締切を過ぎた
pub const DANGER: Color = Color::Rgb(240, 120, 120);
/// 選んでいる行の地（青みの濃紺）
pub const SELECTED_BG: Color = Color::Rgb(38, 52, 84);
/// カーソルの行の地
pub const CURSOR_BG: Color = Color::Rgb(46, 70, 112);
/// ポップアップの地
pub const SURFACE: Color = Color::Rgb(24, 28, 40);
pub const BORDER: Color = Color::Rgb(66, 84, 112);
/// 進行中
pub const IN_PROGRESS: Color = Color::Rgb(96, 165, 250);

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
        "violet" => t(Msg::ColorViolet),
        "sky" => t(Msg::ColorSky),
        "pink" => t(Msg::ColorPink),
        "amber" => t(Msg::ColorAmber),
        "emerald" => t(Msg::ColorEmerald),
        "orange" => t(Msg::ColorOrange),
        "teal" => t(Msg::ColorTeal),
        _ => t(Msg::ColorGray),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SVGS: [(&str, &str); 3] = [
        (
            "logo-dark.svg",
            include_str!("../../../assets/logo-dark.svg"),
        ),
        (
            "logo-light.svg",
            include_str!("../../../assets/logo-light.svg"),
        ),
        ("icon.svg", include_str!("../../../assets/icon.svg")),
    ];
    /// 字の線の色。ブランドの色ではなく、地に合わせて SVG ごとに違う
    const STROKES: [&str; 2] = ["#EEF0F5", "#16203A"];

    fn rgb(color: Color) -> [u8; 3] {
        match color {
            Color::Rgb(r, g, b) => [r, g, b],
            other => panic!("RGB ではない色: {other:?}"),
        }
    }

    fn hex(color: Color) -> String {
        let [r, g, b] = rgb(color);
        format!("#{r:02X}{g:02X}{b:02X}")
    }

    /// SVG の塗り（`stop-color`・`fill`・`stroke`）の値を全部読む。`#RRGGBB` のほかに書けるのは `none` と
    /// `url(#…)` だけにし、短い 16 進や `rgb()`、透明度つきの 8 桁、`style` での指定は落とす（読み飛ばすと、ずれを見逃す）
    fn hexes(svg: &str) -> Vec<String> {
        assert!(!svg.contains("style="), "style で色を書かない");
        let mut found = Vec::new();
        for attr in ["stop-color", "fill", "stroke"] {
            let key = format!("{attr}=\"");
            for (i, _) in svg.match_indices(&key) {
                if !svg[..i].ends_with(char::is_whitespace) {
                    continue;
                }
                let rest = &svg[i + key.len()..];
                let value = &rest[..rest.find('"').expect("値が閉じていない")];
                if value == "none" || (value.starts_with("url(#") && value.ends_with(')')) {
                    continue;
                }
                let ok = value.len() == 7
                    && value.starts_with('#')
                    && value[1..].chars().all(|c| c.is_ascii_hexdigit());
                assert!(ok, "{attr}=\"{value}\" は #RRGGBB で書く");
                found.push(value.to_uppercase());
            }
        }
        found
    }

    #[test]
    fn svg_paints_reject_other_notations() {
        for bad in [
            r##"<stop stop-color="#f00"/>"##,
            r#"<stop stop-color="rgb(255,0,0)"/>"#,
            r##"<stop stop-color="#FDE68A00"/>"##,
        ] {
            assert!(std::panic::catch_unwind(|| hexes(bad)).is_err(), "{bad}");
        }
        assert_eq!(
            hexes(r##"<g fill="none" stroke="#eef0f5"><rect fill="url(#sun)"/></g>"##),
            ["#EEF0F5"]
        );
    }

    fn linear(c: u8) -> f64 {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    }

    fn luminance(color: Color) -> f64 {
        let [r, g, b] = rgb(color);
        0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    fn contrast(a: Color, b: Color) -> f64 {
        let (a, b) = (luminance(a), luminance(b));
        (a.max(b) + 0.05) / (a.min(b) + 0.05)
    }

    fn lab(color: Color) -> [f64; 3] {
        let [r, g, b] = rgb(color);
        let (r, g, b) = (linear(r), linear(g), linear(b));
        let x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
        let y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
        let z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883;
        let f = |t: f64| {
            if t > 216.0 / 24389.0 {
                t.cbrt()
            } else {
                (24389.0 / 27.0 * t + 16.0) / 116.0
            }
        };
        let (fx, fy, fz) = (f(x), f(y), f(z));
        [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
    }

    /// CIE76 の色差
    fn distance(a: Color, b: Color) -> f64 {
        let (a, b) = (lab(a), lab(b));
        ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
    }

    #[test]
    fn brand_colors_match_svgs() {
        let gradient = [
            BRAND_SUN_TOP,
            BRAND_SUN_BOTTOM,
            BRAND_HORIZON,
            BRAND_WATER_TOP,
            BRAND_WATER_BOTTOM,
        ]
        .map(hex);
        for (name, svg) in SVGS {
            let found = hexes(svg);
            for want in &gradient {
                assert!(found.contains(want), "{name} に {want} がない");
            }
            // アイコンの地だけが BRAND_GROUND と同じ色を使う
            let ground = hex(BRAND_GROUND);
            assert_eq!(found.contains(&ground), name == "icon.svg", "{name}");
            for h in &found {
                let known = gradient.contains(h) || *h == ground || STROKES.contains(&h.as_str());
                assert!(known, "{name} にブランドにない色 {h} がある");
            }
        }
    }

    #[test]
    fn semantic_colors_stay_apart() {
        let colors = [
            ("ACCENT", ACCENT),
            ("ATTENTION", ATTENTION),
            ("DANGER", DANGER),
        ];
        for (i, (a_name, a)) in colors.iter().enumerate() {
            for (b_name, b) in &colors[i + 1..] {
                let d = distance(*a, *b);
                assert!(d >= 25.0, "{a_name} と {b_name} の色差が {d:.1}");
            }
        }
    }

    #[test]
    fn text_contrast_on_grounds() {
        for (ground_name, ground) in [("SURFACE", SURFACE), ("BRAND_GROUND", BRAND_GROUND)] {
            for (name, color, min) in [
                ("ACCENT", ACCENT, 4.5),
                ("MUTED", MUTED, 4.5),
                ("ATTENTION", ATTENTION, 4.5),
                ("DANGER", DANGER, 4.5),
                ("FAINT", FAINT, 3.0),
            ] {
                let ratio = contrast(color, ground);
                assert!(ratio >= min, "{name} on {ground_name}: {ratio:.2} < {min}");
            }
        }
    }
}
