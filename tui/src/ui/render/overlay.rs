//! 画面に重ねて出すもの（日付の入力・候補・検索とコマンド・小さな追加欄）と、ショートカットのページ、ログインの画面

use std::time::Instant;

use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};

use super::calendar::filter_label;
use super::logo::{LOGO_HEIGHT, logo_lines};
use super::{centered, clear_for_popup};
use crate::data::sort::TaskSort;
use crate::dates::{format_long_date, parse_date_input};
use crate::model::{POINTS, PROJECT_COLORS, Priority};
use crate::ui::app::{App, DateKind, Overlay, QuickTarget, ValueKind};
use crate::ui::input::{PaletteItem, ProjectChoice};
use crate::ui::keys::{Group, bindings, field_keys, key_label};
use crate::ui::login::LoginStep;
use crate::ui::text::{TextInput, matches_query, pad, truncate, width, wrap};
use crate::ui::theme;

/// 枠つきのポップアップを描く。cursor は、中身の中での入力欄のカーソル（行、桁）
fn popup(
    frame: &mut Frame,
    area: Rect,
    title: &str,
    lines: Vec<Line<'static>>,
    popup_width: u16,
    cursor: Option<(usize, usize)>,
) {
    let rect = centered(area, popup_width, lines.len() as u16 + 2);
    clear_for_popup(frame, rect);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(theme::BORDER))
        .style(Style::new().bg(theme::SURFACE))
        .title(Span::styled(
            format!(" {title} "),
            theme::muted().add_modifier(Modifier::BOLD),
        ));
    let inner = block.inner(rect);
    if let Some((line, col)) = cursor {
        frame.set_cursor_position(Position::new(
            inner.x + (col as u16).min(inner.width.saturating_sub(1)),
            inner.y + line as u16,
        ));
    }
    frame.render_widget(Paragraph::new(lines).block(block), rect);
}

/// 入力欄の1行（先頭に印）と、その中でのカーソルの桁
fn input_line(input: &TextInput, max: usize, placeholder: &str) -> (Line<'static>, usize) {
    let (shown, at) = input.visible(max.saturating_sub(3));
    let mut spans = vec![Span::styled(" › ", theme::accent())];
    if input.is_empty() {
        spans.push(Span::styled(placeholder.to_string(), theme::faint()));
    } else {
        spans.push(Span::raw(shown));
    }
    (Line::from(spans), 3 + at)
}

/// 候補の1行。選んでいる行は地の色を変える
fn choice_line(label: Vec<Span<'static>>, chosen: bool, total: usize) -> Line<'static> {
    let style = if chosen {
        Style::new().bg(theme::CURSOR_BG)
    } else {
        Style::new()
    };
    let used: usize = label.iter().map(|span| width(&span.content)).sum::<usize>() + 3;
    let mut spans = vec![Span::styled(
        if chosen { " ▌ " } else { "   " },
        theme::accent().patch(style),
    )];
    spans.extend(
        label
            .into_iter()
            .map(|span| Span::styled(span.content, span.style.patch(style))),
    );
    spans.push(Span::styled(" ".repeat(total.saturating_sub(used)), style));
    Line::from(spans)
}

/// 件数を添えた名前（複数のタスクにかけるとき）
fn counted(label: &str, ids: &[String]) -> String {
    if ids.len() > 1 {
        format!("{}件の{label}", ids.len())
    } else {
        label.to_string()
    }
}

pub fn draw(frame: &mut Frame, app: &App, area: Rect) {
    let Some(overlay) = &app.overlay else {
        return;
    };
    let popup_width: u16 = 56.min(area.width.saturating_sub(4));
    let inner = popup_width.saturating_sub(2) as usize;
    let today = &app.store.today;
    match overlay {
        Overlay::Date { kind, ids, input } => {
            let title = match kind {
                DateKind::Schedule => counted("やる日（日付を決めて予定へ）", ids),
                DateKind::Deadline => counted("締切", ids),
            };
            let (line, at) = input_line(input, inner, "明日・金曜・来週月曜・3日後・10/3");
            let text = input.text();
            let preview = if text.trim().is_empty() {
                Span::styled(
                    match kind {
                        DateKind::Schedule => "   今日以前の日付なら今日へ入ります".to_string(),
                        DateKind::Deadline => "   空のまま Enter で締切を外します".to_string(),
                    },
                    theme::faint(),
                )
            } else {
                match parse_date_input(&text, today) {
                    Some(on) => Span::styled(
                        format!("   → {}", format_long_date(&on, today)),
                        theme::accent(),
                    ),
                    None => {
                        Span::styled("   日付として読めません", Style::new().fg(theme::ATTENTION))
                    }
                }
            };
            popup(
                frame,
                area,
                &title,
                vec![line, Line::from(preview)],
                popup_width,
                Some((0, at)),
            );
        }
        Overlay::Project { ids, input, index } => {
            let choices = app.project_choices(&input.text());
            let lists = app.store.lists();
            let (line, at) = input_line(input, inner, "名前で探す・作る");
            let mut lines = vec![line];
            let chosen = (*index).min(choices.len().saturating_sub(1));
            let room = (area.height as usize).saturating_sub(8).max(3);
            let skip = (chosen + 1).saturating_sub(room);
            for (i, choice) in choices.iter().enumerate().skip(skip).take(room) {
                let label = match choice {
                    ProjectChoice::None => {
                        vec![Span::styled("プロジェクトなし", theme::muted())]
                    }
                    ProjectChoice::Existing(id) => vec![
                        Span::styled(
                            "● ",
                            Style::new().fg(theme::project_color(lists.project_color(id))),
                        ),
                        Span::raw(truncate(
                            app.project_name(id).unwrap_or_default(),
                            inner.saturating_sub(6),
                        )),
                    ],
                    ProjectChoice::Create(name) => vec![Span::styled(
                        format!("「{}」を作成", truncate(name, inner.saturating_sub(14))),
                        theme::accent(),
                    )],
                };
                lines.push(choice_line(label, i == chosen, inner));
            }
            popup(
                frame,
                area,
                &counted("プロジェクト", ids),
                lines,
                popup_width,
                Some((0, at)),
            );
        }
        Overlay::Value { kind, ids, index } => {
            let mut lines = Vec::new();
            match kind {
                ValueKind::Priority => {
                    for (i, priority) in Priority::ALL.into_iter().enumerate() {
                        lines.push(choice_line(
                            vec![
                                Span::styled(format!("{}  ", i + 1), theme::faint()),
                                super::priority_mark(priority),
                                Span::raw(format!("  {}", priority.label())),
                            ],
                            i == *index,
                            inner,
                        ));
                    }
                    lines.push(choice_line(
                        vec![
                            Span::styled("0  ", theme::faint()),
                            Span::styled("     なし", theme::muted()),
                        ],
                        *index == Priority::ALL.len(),
                        inner,
                    ));
                }
                ValueKind::Points => {
                    for (i, points) in POINTS.into_iter().enumerate() {
                        lines.push(choice_line(
                            vec![Span::raw(format!("{points:>2}"))],
                            i == *index,
                            inner,
                        ));
                    }
                    lines.push(choice_line(
                        vec![Span::styled("なし（0）", theme::muted())],
                        *index == POINTS.len(),
                        inner,
                    ));
                }
            }
            popup(
                frame,
                area,
                &counted(kind.label(), ids),
                lines,
                36.min(popup_width),
                None,
            );
        }
        Overlay::Sort { index } => {
            let lines = TaskSort::ALL
                .into_iter()
                .enumerate()
                .map(|(i, sort)| {
                    choice_line(
                        vec![
                            Span::styled(format!("{}  ", i + 1), theme::faint()),
                            Span::raw(sort.label()),
                            Span::styled(
                                if sort == app.sort() { "  ✓" } else { "" },
                                theme::accent(),
                            ),
                        ],
                        i == *index,
                        inner,
                    )
                })
                .collect();
            popup(frame, area, "並び方", lines, 40.min(popup_width), None);
        }
        Overlay::Palette { input, index } => {
            let palette_width: u16 = 72.min(area.width.saturating_sub(4));
            let inner = palette_width.saturating_sub(2) as usize;
            let items = app.palette_items(&input.text());
            let (line, at) = input_line(input, inner, "コマンド・プロジェクト・タスクを探す");
            let mut lines = vec![line];
            let chosen = (*index).min(items.len().saturating_sub(1));
            let room = (area.height as usize).saturating_sub(8).clamp(3, 16);
            let skip = (chosen + 1).saturating_sub(room);
            for (i, item) in items.iter().enumerate().skip(skip).take(room) {
                let (label, right, right_style) = match item {
                    PaletteItem::Command {
                        label, key, group, ..
                    } => (
                        vec![Span::raw(label.clone())],
                        match key {
                            Some(key) => format!("{group}  {key}"),
                            None => group.to_string(),
                        },
                        theme::faint(),
                    ),
                    PaletteItem::Project { id, name } => (
                        vec![
                            Span::styled(
                                "● ",
                                Style::new()
                                    .fg(theme::project_color(app.store.lists().project_color(id))),
                            ),
                            Span::raw(name.clone()),
                        ],
                        "プロジェクト".to_string(),
                        theme::faint(),
                    ),
                    PaletteItem::Task {
                        title, location, ..
                    } => (
                        vec![Span::raw(title.clone())],
                        location.clone(),
                        theme::muted(),
                    ),
                };
                // 左の名前を切って、右の情報を右端にそろえる
                let right_width = width(&right);
                let label_width = inner.saturating_sub(right_width + 5);
                let text: String = label.iter().map(|span| span.content.to_string()).collect();
                let mut spans: Vec<Span<'static>> = Vec::new();
                if label.len() == 2 {
                    spans.push(label[0].clone());
                    spans.push(Span::raw(pad(
                        &label[1].content,
                        label_width.saturating_sub(2),
                    )));
                } else {
                    spans.push(Span::raw(pad(&text, label_width)));
                }
                spans.push(Span::styled(format!(" {right}"), right_style));
                lines.push(choice_line(spans, i == chosen, inner));
            }
            if items.is_empty() {
                lines.push(Line::from(Span::styled(
                    "   見つかりません",
                    theme::faint(),
                )));
            }
            popup(
                frame,
                area,
                "検索とコマンド",
                lines,
                palette_width,
                Some((0, at)),
            );
        }
        Overlay::Color { index, .. } => {
            let mut spans = vec![Span::raw(" ")];
            for (i, color) in PROJECT_COLORS.into_iter().enumerate() {
                let style = Style::new().fg(theme::project_color(Some(color)));
                spans.push(if i == *index {
                    Span::styled(" ● ", style.bg(theme::CURSOR_BG))
                } else {
                    Span::styled(" ● ", style)
                });
            }
            let name = theme::project_color_label(PROJECT_COLORS[(*index).min(7)]);
            popup(
                frame,
                area,
                "プロジェクトの色",
                vec![
                    Line::from(spans),
                    Line::from(Span::styled(
                        format!("  {name}　←→ で選び、Enter で決める"),
                        theme::faint(),
                    )),
                ],
                44.min(popup_width),
                None,
            );
        }
        Overlay::Name { input, rename } => {
            let (line, at) = input_line(input, inner, "プロジェクトの名前");
            popup(
                frame,
                area,
                if rename.is_some() {
                    "プロジェクトの名前を変更"
                } else {
                    "プロジェクトを作成"
                },
                vec![line],
                popup_width,
                Some((0, at)),
            );
        }
        Overlay::QuickAdd {
            input,
            targets,
            index,
        } => {
            let (line, at) = input_line(input, inner, "タスクの名前");
            let mut spans = vec![Span::styled("   行き先：", theme::faint())];
            for (i, target) in targets.iter().enumerate() {
                if i > 0 {
                    spans.push(Span::styled("｜", theme::faint()));
                }
                let label = match target {
                    QuickTarget::Inbox => "受信箱".to_string(),
                    QuickTarget::Today => "今日".to_string(),
                    QuickTarget::Date(on) if on.as_str() <= today.as_str() => "今日".to_string(),
                    QuickTarget::Date(on) => format_long_date(on, today),
                };
                spans.push(Span::styled(
                    label,
                    if i == *index {
                        theme::accent().add_modifier(Modifier::BOLD)
                    } else {
                        theme::faint()
                    },
                ));
            }
            spans.push(Span::styled("  （Tab で切り替え）", theme::faint()));
            popup(
                frame,
                area,
                "追加",
                vec![line, Line::from(spans)],
                popup_width,
                Some((0, at)),
            );
        }
        Overlay::Filter { index } => {
            let choices = app.filter_choices();
            let room = (area.height as usize).saturating_sub(8).max(3);
            let skip = (*index + 1).saturating_sub(room);
            let lines = choices
                .iter()
                .enumerate()
                .skip(skip)
                .take(room)
                .map(|(i, filter)| {
                    choice_line(
                        vec![Span::raw(filter_label(app, filter))],
                        i == *index,
                        inner,
                    )
                })
                .collect();
            popup(
                frame,
                area,
                "プロジェクトで絞り込む",
                lines,
                44.min(popup_width),
                None,
            );
        }
    }
}

/// ショートカットのページ。まとまりごとに、すべてのキーを並べる。打った文字で絞り込める
pub fn draw_shortcuts(frame: &mut Frame, app: &mut App, area: Rect) {
    let query = app.shortcuts_filter.text();
    let total = area.width as usize;
    let label_width = (total * 3 / 5).clamp(20, 48);
    let keys_text = |keys: &[&str]| {
        if keys.is_empty() {
            "キーなし（Ctrl+K から）".to_string()
        } else {
            keys.iter()
                .map(|spec| key_label(spec))
                .collect::<Vec<_>>()
                .join("  ")
        }
    };
    let row = |label: &str, keys: String| {
        Line::from(vec![
            Span::raw(format!("  {}", pad(label, label_width))),
            Span::styled(keys, theme::accent()),
        ])
    };
    let mut lines: Vec<Line<'static>> = Vec::new();
    let all = bindings();
    for group in Group::ORDER {
        let rows: Vec<Line> = all
            .iter()
            .filter(|binding| binding.group == group)
            .filter(|binding| {
                matches_query(&binding.label, &query)
                    || binding
                        .place
                        .is_some_and(|place| matches_query(place, &query))
            })
            .map(|binding| {
                // 決まった画面だけで効くキーには、効く画面の名前を添える
                let label = match binding.place {
                    Some(place) => format!("{}（{place}）", binding.label),
                    None => binding.label.clone(),
                };
                row(&label, keys_text(binding.keys))
            })
            .collect();
        if rows.is_empty() {
            continue;
        }
        if !lines.is_empty() {
            lines.push(Line::default());
        }
        lines.push(Line::from(Span::styled(
            group.label(),
            theme::muted().add_modifier(Modifier::BOLD),
        )));
        lines.extend(rows);
    }
    // 候補や欄の中のキー
    for (scene, keys) in field_keys() {
        let rows: Vec<Line> = keys
            .into_iter()
            .filter(|(label, _)| matches_query(label, &query) || matches_query(scene, &query))
            .map(|(label, keys)| row(label, keys_text(keys)))
            .collect();
        if rows.is_empty() {
            continue;
        }
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(
            scene,
            theme::muted().add_modifier(Modifier::BOLD),
        )));
        lines.extend(rows);
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled("  見つかりません", theme::faint())));
    }

    let filter = if query.is_empty() {
        Line::from(Span::styled(
            "絞り込み：文字を打つと絞り込めます",
            theme::faint(),
        ))
    } else {
        Line::from(vec![
            Span::styled("絞り込み：", theme::faint()),
            Span::raw(query.clone()),
        ])
    };
    let height = (area.height as usize).saturating_sub(2);
    app.shortcuts_scroll = app.shortcuts_scroll.min(lines.len().saturating_sub(height));
    let mut visible = vec![filter, Line::default()];
    visible.extend(lines.into_iter().skip(app.shortcuts_scroll).take(height));
    frame.render_widget(Paragraph::new(visible), area);
}

/// ログインの画面
pub fn draw_login(frame: &mut Frame, app: &App, area: Rect) {
    let Some(login) = &app.login else {
        return;
    };
    // この端末だけで使っているときは、やめて戻れる
    let leave = if app.config.is_cloud() {
        "q で終了"
    } else {
        "Esc で戻る"
    };
    let mut lines: Vec<Line<'static>> = vec![
        Line::from(Span::styled(
            "nagi",
            theme::accent().add_modifier(Modifier::BOLD),
        )),
        Line::default(),
    ];
    if let Some(reason) = &login.reason {
        lines.push(Line::from(Span::styled(reason.clone(), theme::muted())));
        lines.push(Line::default());
    }
    match &login.step {
        LoginStep::Idle => {
            if app.config.is_cloud() {
                lines.push(Line::from("GitHub でログインします"));
            } else {
                lines.push(Line::from(
                    "GitHub でログインすると、クラウドと同期して使えます",
                ));
                lines.push(Line::from(Span::styled(
                    "クラウドとの同期は、いまは招待した人だけが使えます",
                    theme::muted(),
                )));
                lines.push(Line::from(Span::styled(
                    "この端末のタスクはそのまま残り、ログアウトすると戻ります",
                    theme::muted(),
                )));
            }
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                format!("Enter で始める　{leave}"),
                theme::faint(),
            )));
        }
        LoginStep::Starting => {
            lines.push(Line::from(Span::styled(
                "コードを用意しています…",
                theme::muted(),
            )));
        }
        LoginStep::Waiting {
            user_code,
            verification_uri,
            expires_at,
        } => {
            let left = expires_at
                .saturating_duration_since(Instant::now())
                .as_secs();
            lines.push(Line::from("1. ブラウザでこの URL を開く"));
            lines.push(Line::from(Span::styled(
                format!("   {verification_uri}"),
                theme::accent(),
            )));
            lines.push(Line::default());
            lines.push(Line::from("2. このコードを入力して、承認する"));
            lines.push(Line::from(Span::styled(
                format!("   {user_code}"),
                theme::accent().add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                format!(
                    "承認を待っています…（あと {} 分 {} 秒）",
                    left / 60,
                    left % 60
                ),
                theme::muted(),
            )));
            lines.push(Line::from(Span::styled(
                "この画面に出たコード以外は、承認しないでください",
                theme::faint(),
            )));
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(leave, theme::faint())));
        }
        LoginStep::Failed(message) => {
            for text in wrap(message, 60) {
                lines.push(Line::from(Span::styled(
                    text,
                    Style::new().fg(theme::ATTENTION),
                )));
            }
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                format!("Enter でやり直す　{leave}"),
                theme::faint(),
            )));
        }
    }
    lines.push(Line::default());
    lines.push(Line::from(Span::styled(
        format!("接続先：{}", app.config.server),
        theme::faint(),
    )));
    let fits_logo = area.height >= lines.len() as u16 + LOGO_HEIGHT + 1 + 2;
    if fits_logo {
        let mut with_logo = logo_lines(login.shown_at.elapsed());
        with_logo.push(Line::default());
        with_logo.append(&mut lines);
        lines = with_logo;
    }
    let rect = centered(area, 64, lines.len() as u16 + 2);
    frame.render_widget(Paragraph::new(lines), rect);
}
