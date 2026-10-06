//! タイムライン。横は 1 週前から 8 週先までの日付、縦はプロジェクトごとのまとまり。
//! 棒はやる日から締切まで、◆は締切

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::calendar::filter_label;
use crate::dates::{add_days, weekday_index};
use crate::ui::app::App;
use crate::ui::text::pad;
use crate::ui::theme;
use crate::ui::views::{ProjectFilter, TimelineShape, timeline_groups, timeline_range};

/// 1日の幅（桁）
const DAY_WIDTH: usize = 3;

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect) {
    let groups = timeline_groups(&app.store, &app.timeline.filter);
    let range = timeline_range(&app.store.today);
    let today = app.store.today.clone();
    let lists = app.store.lists();

    let [title_area, body] =
        Layout::vertical([Constraint::Length(2), Constraint::Min(4)]).areas(area);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled("1 週前から 8 週先まで", theme::muted()),
            Span::styled(
                format!("    絞り込み：{}", filter_label(app, &app.timeline.filter)),
                if app.timeline.filter == ProjectFilter::All {
                    theme::faint()
                } else {
                    theme::accent()
                },
            ),
        ])),
        title_area,
    );

    let label_width = (body.width as usize / 3).clamp(12, 30);
    let visible_days = ((body.width as usize).saturating_sub(label_width + 1) / DAY_WIDTH).max(1);
    // 横の位置は、範囲の中に収める
    let max_scroll = (range.days - visible_days as i64).max(0);
    app.timeline.scroll = app.timeline.scroll.clamp(0, max_scroll);
    let first_day = add_days(&range.start, app.timeline.scroll);
    let days: Vec<String> = (0..visible_days as i64)
        .map(|offset| add_days(&first_day, offset))
        .filter(|day| *day <= range.end)
        .collect();

    // 日付の見出し：月の行と、日の行
    let mut months: Vec<Span<'static>> = vec![Span::raw(" ".repeat(label_width + 1))];
    let mut skip_cells = 0;
    for (i, day) in days.iter().enumerate() {
        if skip_cells > 0 {
            skip_cells -= 1;
            continue;
        }
        if (i == 0 || day.ends_with("-01")) && i + 2 <= days.len() {
            let month: u32 = day[5..7].parse().unwrap_or(1);
            months.push(Span::styled(
                pad(&format!("{month}月"), DAY_WIDTH * 2),
                theme::muted(),
            ));
            skip_cells = 1;
        } else {
            months.push(Span::raw(" ".repeat(DAY_WIDTH)));
        }
    }
    let mut numbers: Vec<Span<'static>> = vec![Span::raw(" ".repeat(label_width + 1))];
    for day in &days {
        let number: u32 = day[8..].parse().unwrap_or(0);
        let weekday = weekday_index(day);
        let style = if *day == today {
            theme::accent().add_modifier(Modifier::BOLD)
        } else if weekday == 0 || weekday == 6 {
            theme::faint()
        } else {
            theme::muted()
        };
        numbers.push(Span::styled(format!("{number:>2} "), style));
    }

    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cursor_line = None;
    for group in &groups {
        if !lines.is_empty() {
            lines.push(Line::default());
        }
        let color = theme::project_color(
            group
                .project_id
                .as_deref()
                .and_then(|id| lists.project_color(id)),
        );
        let name = match &group.project_id {
            Some(id) => format!("● {}", app.project_name(id).unwrap_or_default()),
            None => "プロジェクトなし".to_string(),
        };
        lines.push(Line::from(Span::styled(
            pad(&name, label_width),
            Style::new().fg(color).add_modifier(Modifier::BOLD),
        )));
        for item in &group.items {
            let Some(task) = app.task(&item.task_id) else {
                continue;
            };
            let cursor = app.timeline.cursor.as_deref() == Some(item.task_id.as_str());
            if cursor {
                cursor_line = Some(lines.len());
            }
            let row_style = if cursor {
                Style::new().bg(theme::CURSOR_BG)
            } else {
                Style::new()
            };
            let bar_style = if cursor {
                Style::new().fg(color).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(color)
            };
            let diamond = Style::new().fg(theme::ATTENTION);
            let mut spans = vec![
                Span::styled(
                    if cursor { "▌" } else { " " },
                    theme::accent().patch(row_style),
                ),
                Span::styled(pad(&task.title, label_width - 1), row_style),
                Span::raw(" "),
            ];
            for day in &days {
                let empty = if *day == today {
                    Span::styled("┊  ", theme::faint())
                } else {
                    Span::raw("   ")
                };
                let cell = match &item.shape {
                    TimelineShape::Diamond { on } if on == day => Span::styled("◆  ", diamond),
                    TimelineShape::Bar {
                        from,
                        to,
                        end_diamond,
                        loose_deadline,
                    } => {
                        if day >= from && day < to {
                            Span::styled("███", bar_style)
                        } else if day == to && *end_diamond && from != to {
                            // 棒の右端に◆
                            Span::styled("█◆ ", bar_style)
                        } else if day == to && *end_diamond {
                            Span::styled("◆  ", diamond)
                        } else if day == to {
                            Span::styled("██ ", bar_style)
                        } else if loose_deadline.as_deref() == Some(day.as_str()) {
                            // 締切がやる日より前：離れた◆
                            Span::styled("◆  ", Style::new().fg(theme::DANGER))
                        } else {
                            empty
                        }
                    }
                    _ => empty,
                };
                spans.push(cell);
            }
            lines.push(Line::from(spans));
        }
    }
    if groups.is_empty() {
        lines.push(Line::from(Span::styled(
            "  やる日か締切のあるタスクはありません（n で追加、d で日付）",
            theme::faint(),
        )));
    }

    let [head_area, rows_area] =
        Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).areas(body);
    frame.render_widget(
        Paragraph::new(vec![Line::from(months), Line::from(numbers)]),
        head_area,
    );
    // 選んでいる行が見えるところまで送る
    let height = rows_area.height as usize;
    let skip = cursor_line.map_or(0, |line| (line + 2).saturating_sub(height));
    let visible: Vec<Line> = lines.into_iter().skip(skip).take(height).collect();
    frame.render_widget(Paragraph::new(visible), rows_area);
}
