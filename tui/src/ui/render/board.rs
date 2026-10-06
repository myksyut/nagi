//! ボード。状態の列（未着手・進行中・完了）にカードを並べる。カードは、タイトルの行と情報の行

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::list::task_meta;
use super::status_glyph;
use crate::data::lists::sum_points;
use crate::ui::app::App;
use crate::ui::list::{Column, ListKind};
use crate::ui::text::{pad, width};
use crate::ui::theme;

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(view) = app.view() else {
        return;
    };
    // 追加欄は、列の上に1行で開く
    let (add_area, columns_area) = if app.adding.is_some() {
        let [add, rest] = Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).areas(area);
        (Some(add), rest)
    } else {
        (None, area)
    };
    if let (Some(add), Some(input)) = (add_area, &app.adding) {
        let label = format!("  {}", view.add_to.label);
        let field = (add.width as usize).saturating_sub(5 + width(&label));
        let (shown, at) = input.visible(field);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled("▌ ＋ ", theme::accent()),
                Span::raw(pad(&shown, field)),
                Span::styled(label, theme::faint()),
            ])),
            add,
        );
        frame.set_cursor_position(Position::new(add.x + 5 + at as u16, add.y));
    }

    let areas = Layout::horizontal([Constraint::Ratio(1, 3); 3]).split(columns_area);
    let show_project = view.kind != ListKind::Project;
    for (column, column_area) in Column::ALL.into_iter().zip(areas.iter()) {
        let total = (column_area.width as usize).saturating_sub(2);
        let rows = view.column_rows(&app.list, column);
        let points = sum_points(
            &app.store.replica,
            rows.iter()
                .map(|id| id.to_string())
                .collect::<Vec<_>>()
                .iter(),
        );
        let mut header = format!("{}  {}", column.label(), rows.len());
        if points > 0 {
            header.push_str(&format!(" ・ 工数 {points}"));
        }
        let mut lines: Vec<Line<'static>> = vec![
            Line::from(Span::styled(
                pad(&header, total),
                theme::muted().add_modifier(Modifier::BOLD),
            )),
            Line::from(Span::styled(
                "─".repeat(total),
                Style::new().fg(theme::BORDER),
            )),
        ];
        let mut focus: Option<(usize, usize)> = None;
        for section in view.sections.iter().filter(|s| s.column == Some(column)) {
            if section.rows.is_empty() {
                continue;
            }
            if let Some(heading) = &section.heading {
                lines.push(Line::from(Span::styled(
                    heading.clone(),
                    theme::faint().add_modifier(Modifier::BOLD),
                )));
            }
            for id in &section.rows {
                let Some(task) = app.task(id) else {
                    continue;
                };
                let cursor = app.list.cursor.as_deref() == Some(id.as_str());
                let selected = app.list.is_selected(id);
                let bg = if cursor {
                    Some(theme::CURSOR_BG)
                } else if selected {
                    Some(theme::SELECTED_BG)
                } else {
                    None
                };
                let with_bg = |style: Style| match bg {
                    Some(bg) => style.bg(bg),
                    None => style,
                };
                if cursor {
                    focus = Some((lines.len(), lines.len() + 2));
                }
                let glyph = status_glyph(task);
                let title_style = if task.is_completed() {
                    theme::faint()
                } else {
                    Style::new()
                };
                lines.push(Line::from(vec![
                    Span::styled(if cursor { "▌" } else { " " }, with_bg(theme::accent())),
                    Span::styled(glyph.content, with_bg(glyph.style)),
                    Span::styled(" ", with_bg(Style::new())),
                    Span::styled(
                        pad(&task.title, total.saturating_sub(3)),
                        with_bg(title_style),
                    ),
                ]));
                // カードの下の情報（行の右側と同じ項目）
                let meta = task_meta(app, task, show_project, true);
                let meta_width: usize = meta.iter().map(|span| width(&span.content)).sum();
                let mut spans = vec![Span::styled("   ", with_bg(Style::new()))];
                spans.extend(
                    meta.into_iter()
                        .map(|span| Span::styled(span.content, with_bg(span.style))),
                );
                spans.push(Span::styled(
                    " ".repeat(total.saturating_sub(3 + meta_width)),
                    with_bg(Style::new()),
                ));
                lines.push(Line::from(spans));
                lines.push(Line::default());
            }
        }
        if rows.is_empty() {
            lines.push(Line::from(Span::styled("なし", theme::faint())));
        }
        // 列ごとに、選んでいるカードが見えるところまで送る（見出しの2行は残す）
        let height = (column_area.height as usize).saturating_sub(2);
        let skip = focus.map_or(0, |(_, end)| end.saturating_sub(2).saturating_sub(height));
        let visible: Vec<Line> = lines
            .iter()
            .take(2)
            .cloned()
            .chain(lines.iter().skip(2 + skip).take(height).cloned())
            .collect();
        frame.render_widget(Paragraph::new(visible), *column_area);
    }
}
