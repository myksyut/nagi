//! カレンダー。月の表（日曜始まり）の日のマスに、締切の◆とタスクを出す。下に、選んでいる日の一覧

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::list::task_meta;
use super::status_glyph;
use crate::dates::{format_day_heading, month_start};
use crate::ui::app::App;
use crate::ui::text::{pad, truncate};
use crate::ui::theme;
use crate::ui::views::{CalendarEntry, ProjectFilter, calendar_entries, month_weeks};

const WEEKDAYS: [&str; 7] = ["日", "月", "火", "水", "木", "金", "土"];
/// 選んでいる日の一覧に使う行数（見出しを含む）
const DAY_PANEL_HEIGHT: u16 = 8;

pub fn filter_label(app: &App, filter: &ProjectFilter) -> String {
    match filter {
        ProjectFilter::All => "すべて".to_string(),
        ProjectFilter::None => "プロジェクトなし".to_string(),
        ProjectFilter::Project(id) => app.project_name(id).unwrap_or_default().to_string(),
    }
}

fn entry_spans(app: &App, entry: &CalendarEntry, max: usize, style: Style) -> Vec<Span<'static>> {
    let title = app
        .task(&entry.task_id)
        .map_or("", |task| task.title.as_str());
    if entry.deadline {
        // 締切の◆。過ぎていれば赤
        let overdue = app.task(&entry.task_id).is_some_and(|task| {
            task.deadline_on
                .as_deref()
                .is_some_and(|on| on < app.store.today.as_str())
        });
        let mark = if overdue {
            Style::new().fg(theme::DANGER)
        } else {
            Style::new().fg(theme::ATTENTION)
        };
        vec![
            Span::styled("◆", mark.patch(style)),
            Span::styled(pad(title, max.saturating_sub(1)), style),
        ]
    } else {
        vec![Span::styled(pad(title, max), style)]
    }
}

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect) {
    let entries = calendar_entries(&app.store, &app.calendar.filter);
    let month = month_start(&app.calendar.day);
    let weeks = month_weeks(&month);
    let today = app.store.today.clone();

    let panel_height = if area.height >= 26 {
        DAY_PANEL_HEIGHT
    } else {
        4
    };
    let [title_area, grid_area, panel_area] = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(6),
        Constraint::Length(panel_height),
    ])
    .areas(area);

    // 月の見出しと、絞り込み
    let year: i32 = month[..4].parse().unwrap_or(0);
    let month_number: u32 = month[5..7].parse().unwrap_or(1);
    frame.render_widget(
        Paragraph::new(vec![Line::from(vec![
            Span::styled(format!("{year}年{month_number}月"), theme::bold()),
            Span::styled(
                format!("    絞り込み：{}", filter_label(app, &app.calendar.filter)),
                if app.calendar.filter == ProjectFilter::All {
                    theme::faint()
                } else {
                    theme::accent()
                },
            ),
        ])]),
        title_area,
    );

    let cell_width = (grid_area.width as usize / 7).max(4);
    let cell_height = ((grid_area.height as usize).saturating_sub(1) / weeks.len()).max(2);
    // 1つのマスに出す行の数（超えたら、1つ減らして「ほか N 件」を出す）
    let capacity = cell_height - 1;
    let mut lines: Vec<Line<'static>> = Vec::new();
    lines.push(Line::from(
        WEEKDAYS
            .iter()
            .map(|day| Span::styled(pad(&format!(" {day}"), cell_width), theme::faint()))
            .collect::<Vec<_>>(),
    ));
    for week in &weeks {
        for row in 0..cell_height {
            let mut spans: Vec<Span<'static>> = Vec::new();
            for day in week {
                let selected = *day == app.calendar.day;
                let in_month = day[..7] == month[..7];
                let bg = |style: Style| {
                    if selected {
                        style.bg(theme::SELECTED_BG)
                    } else {
                        style
                    }
                };
                let inner = cell_width - 1;
                let day_entries = entries.get(day).map_or(&[][..], Vec::as_slice);
                if row == 0 {
                    // 日付の行。今日は紫、ほかの月の日は控えめに
                    let number: u32 = day[8..].parse().unwrap_or(0);
                    let style = if *day == today {
                        theme::accent().add_modifier(Modifier::BOLD)
                    } else if in_month {
                        Style::new()
                    } else {
                        theme::faint()
                    };
                    let label = if *day == today {
                        format!("{number} 今日")
                    } else {
                        number.to_string()
                    };
                    spans.push(Span::styled(pad(&format!(" {label}"), inner), bg(style)));
                } else {
                    let shown = if day_entries.len() > capacity {
                        capacity.saturating_sub(1)
                    } else {
                        day_entries.len()
                    };
                    let index = row - 1;
                    if index < shown {
                        let entry = &day_entries[index];
                        let chosen =
                            selected && index == app.calendar.entry.min(day_entries.len() - 1);
                        let mut style = if in_month {
                            theme::muted()
                        } else {
                            theme::faint()
                        };
                        if chosen {
                            style = Style::new().bg(theme::CURSOR_BG);
                        } else {
                            style = bg(style);
                        }
                        spans.push(Span::styled(" ", style));
                        spans.extend(entry_spans(app, entry, inner - 1, style));
                    } else if index == shown && day_entries.len() > shown {
                        spans.push(Span::styled(
                            pad(&format!(" ほか {} 件", day_entries.len() - shown), inner),
                            bg(theme::faint()),
                        ));
                    } else {
                        spans.push(Span::styled(" ".repeat(inner), bg(Style::new())));
                    }
                }
                spans.push(Span::styled("│", Style::new().fg(theme::BORDER)));
            }
            lines.push(Line::from(spans));
        }
    }
    frame.render_widget(Paragraph::new(lines), grid_area);

    // 選んでいる日の一覧（マスに入りきらないものも、ここで選べる）
    let day_entries = entries
        .get(&app.calendar.day)
        .map_or(&[][..], Vec::as_slice);
    let total = panel_area.width as usize;
    let mut panel: Vec<Line<'static>> = vec![Line::from(vec![
        Span::styled(
            format_day_heading(&app.calendar.day, &today),
            theme::muted().add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("  {} 件", day_entries.len()), theme::faint()),
    ])];
    if day_entries.is_empty() {
        panel.push(Line::from(Span::styled(
            "  この日のタスクはありません（n で追加）",
            theme::faint(),
        )));
    }
    let chosen = app.calendar.entry.min(day_entries.len().saturating_sub(1));
    let room = (panel_area.height as usize).saturating_sub(1).max(1);
    let skip = (chosen + 1).saturating_sub(room);
    for (index, entry) in day_entries.iter().enumerate().skip(skip).take(room) {
        let Some(task) = app.task(&entry.task_id) else {
            continue;
        };
        let cursor = index == chosen && app.detail.is_none();
        let style = if cursor {
            Style::new().bg(theme::CURSOR_BG)
        } else {
            Style::new()
        };
        let meta = task_meta(app, task, true, false);
        let meta_width: usize = meta
            .iter()
            .map(|span| crate::ui::text::width(&span.content))
            .sum();
        let kind = if entry.deadline { "◆ 締切 " } else { "" };
        let title_width = total.saturating_sub(6 + meta_width + crate::ui::text::width(kind));
        let glyph = status_glyph(task);
        let mut spans = vec![
            Span::styled(
                if cursor { "▌ " } else { "  " },
                theme::accent().patch(style),
            ),
            Span::styled(glyph.content, glyph.style.patch(style)),
            Span::styled(" ", style),
            Span::styled(kind, Style::new().fg(theme::ATTENTION).patch(style)),
            Span::styled(pad(&truncate(&task.title, title_width), title_width), style),
            Span::styled("  ", style),
        ];
        spans.extend(
            meta.into_iter()
                .map(|span| Span::styled(span.content, span.style.patch(style))),
        );
        panel.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(panel), panel_area);
}
