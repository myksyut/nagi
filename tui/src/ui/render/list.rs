//! 一覧。まとまりの見出し、タスクの行、閉じられるまとまり（「完了 N件」）、追加欄、その場に広げた開いたタスク

use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Paragraph;

use super::{add_prompt, detail, priority_mark, status_glyph};
use crate::dates::{DeadlineTone, deadline_status, format_short_date_with_weekday};
use crate::i18n::{Msg, fill, t};
use crate::model::{Bucket, Task};
use crate::ui::app::{App, Screen};
use crate::ui::list::{ListKind, ListView};
use crate::ui::text::{pad, truncate, width};
use crate::ui::theme;

/// 行の右側の情報（メモの印・チェックリストの進み具合・プロジェクト・予定の日付・締切・優先度・工数）
pub fn task_meta(
    app: &App,
    task: &Task,
    show_project: bool,
    show_date: bool,
) -> Vec<Span<'static>> {
    let today = &app.store.today;
    let mut parts: Vec<Span<'static>> = Vec::new();
    if !task.memo.trim().is_empty() {
        parts.push(Span::styled("≡", theme::faint()));
    }
    if !task.checklist.is_empty() {
        let done = task.checklist.iter().filter(|item| item.done).count();
        parts.push(Span::styled(
            format!("{done}/{}", task.checklist.len()),
            theme::muted(),
        ));
    }
    if show_project
        && let Some(project_id) = &task.project_id
        && let Some(name) = app.project_name(project_id)
    {
        let color = theme::project_color(app.store.lists().project_color(project_id));
        parts.push(Span::styled(
            format!("● {}", truncate(name, 14)),
            Style::new().fg(color),
        ));
    }
    if show_date
        && !task.is_completed()
        && let Some(on) = &task.scheduled_on
    {
        parts.push(Span::styled(
            format_short_date_with_weekday(on, today),
            theme::muted(),
        ));
    }
    if !task.is_completed()
        && let Some(deadline_on) = &task.deadline_on
    {
        let (tone, label) = deadline_status(deadline_on, today);
        let style = match tone {
            DeadlineTone::Plain => theme::muted(),
            DeadlineTone::Soon => theme::accent(),
            DeadlineTone::Today => Style::new().fg(theme::ATTENTION),
            DeadlineTone::Overdue => Style::new().fg(theme::DANGER),
        };
        parts.push(Span::styled(label, style));
    }
    if let Some(priority) = task.priority {
        parts.push(priority_mark(priority));
    }
    if let Some(points) = task.points {
        parts.push(Span::styled(format!("{points}pt"), theme::muted()));
    }
    // あいだを空ける
    let mut spans = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        if i > 0 {
            spans.push(Span::raw("  "));
        }
        spans.push(part);
    }
    spans
}

/// タスクの1行。左に選択の印・完了の丸・到着の印・タイトル、右に情報
fn task_row(app: &App, view: &ListView, task: &Task, total: usize) -> Line<'static> {
    let cursor = app.list.cursor.as_deref() == Some(task.id.as_str());
    let selected = app.list.is_selected(&task.id);
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
    // プロジェクトの画面と、あとでのプロジェクトごとのまとまりでは、プロジェクトの名前を繰り返さない
    let show_project = !matches!(view.kind, ListKind::Project | ListKind::Later);
    let show_date = view.kind != ListKind::Upcoming;
    let meta = task_meta(app, task, show_project, show_date);
    let meta_width: usize = meta.iter().map(|span| width(&span.content)).sum();
    // 到着の印：日付の到来や締切で、今日、今日に入ったタスク
    let arrived = task.arrived_on.as_deref() == Some(app.store.today.as_str())
        && task.bucket == Bucket::Today
        && !task.is_completed();
    let fixed = 4 + if arrived { 2 } else { 0 };
    let title_width = total.saturating_sub(fixed + meta_width + 2);
    let title_style = if task.is_completed() {
        theme::faint().add_modifier(Modifier::CROSSED_OUT)
    } else {
        Style::new()
    };
    let mut spans = vec![
        Span::styled(if cursor { "▌" } else { " " }, with_bg(theme::accent())),
        Span::styled(" ", with_bg(Style::new())),
    ];
    let glyph = status_glyph(task);
    spans.push(Span::styled(glyph.content, with_bg(glyph.style)));
    spans.push(Span::styled(" ", with_bg(Style::new())));
    if arrived {
        spans.push(Span::styled(
            "◆ ",
            with_bg(Style::new().fg(theme::ATTENTION)),
        ));
    }
    spans.push(Span::styled(
        pad(&task.title, title_width),
        with_bg(title_style),
    ));
    spans.push(Span::styled("  ", with_bg(Style::new())));
    spans.extend(
        meta.into_iter()
            .map(|span| Span::styled(span.content, with_bg(span.style))),
    );
    Line::from(spans)
}

/// 何もないときの案内
fn empty_lines(app: &App) -> Vec<&'static str> {
    let lists = app.store.lists();
    match &app.screen {
        Screen::Inbox => vec![t(Msg::EmptyInbox), t(Msg::HintAdd)],
        Screen::Today if !lists.completed_today.is_empty() => {
            vec![t(Msg::EmptyTodayAllDone)]
        }
        Screen::Today => vec![t(Msg::EmptyToday), t(Msg::HintAdd)],
        Screen::Upcoming => vec![t(Msg::EmptyUpcoming), t(Msg::HintAddToInbox)],
        Screen::Later => vec![t(Msg::EmptyLater), t(Msg::HintAdd)],
        Screen::Logbook => vec![t(Msg::EmptyLogbook)],
        Screen::Project(_) => vec![t(Msg::EmptyProject), t(Msg::HintAdd)],
        _ => vec![],
    }
}

pub fn draw(frame: &mut Frame, app: &mut App, area: Rect) {
    let Some(view) = app.view() else {
        return;
    };
    let total = area.width as usize;
    let mut lines: Vec<Line<'static>> = Vec::new();
    // 見えるようにしておく範囲（カーソルの行・追加欄・開いたタスク）と、入力欄のカーソル
    let mut focus: Option<(usize, usize)> = None;
    let mut text_cursor: Option<(usize, usize)> = None;

    let add_line = |app: &App, lines: &mut Vec<Line<'static>>| -> Option<(usize, usize)> {
        let input = app.adding.as_ref()?;
        let label = format!("  {}", view.add_to.label);
        let prompt = add_prompt();
        let field = total.saturating_sub(width(&prompt) + width(&label));
        let (shown, at) = input.visible(field);
        lines.push(Line::from(vec![
            Span::styled(prompt.clone(), theme::accent()),
            Span::raw(pad(&shown, field)),
            Span::styled(label, theme::faint()),
        ]));
        Some((lines.len() - 1, width(&prompt) + at))
    };

    // 追加欄を開くまとまりがなければ、一覧の一番上に開く
    let add_section = view
        .add_in_section
        .as_ref()
        .filter(|key| view.sections.iter().any(|section| section.key == **key));
    if add_section.is_none()
        && let Some(at) = add_line(app, &mut lines)
    {
        focus = Some((at.0, at.0 + 1));
        text_cursor = Some(at);
    }

    let mut any_rows = false;
    let detail_inline = !app.detail_is_popup();
    for section in &view.sections {
        let is_add_section = add_section == Some(&section.key);
        if section.rows.is_empty() && !(is_add_section && app.adding.is_some()) {
            continue;
        }
        any_rows |= !section.rows.is_empty();
        let open = view.is_fold_open(&app.list, section);
        if let Some(label) = &section.fold {
            // 閉じられるまとまり（今日の「完了 N件」）
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            lines.push(Line::from(vec![
                Span::styled(if open { "  ▾ " } else { "  ▸ " }, theme::faint()),
                Span::styled(label.clone(), theme::muted()),
                Span::styled(t(Msg::FoldToggleHint), theme::faint()),
            ]));
        } else if let Some(heading) = &section.heading
            && !section.rows.is_empty()
        {
            if !lines.is_empty() {
                lines.push(Line::default());
            }
            lines.push(Line::from(Span::styled(
                format!("  {heading}"),
                theme::muted().add_modifier(Modifier::BOLD),
            )));
        }
        if open {
            for id in &section.rows {
                let Some(task) = app.task(id) else {
                    continue;
                };
                let is_open = detail_inline
                    && app
                        .detail
                        .as_ref()
                        .is_some_and(|detail| detail.task_id == *id);
                if is_open && let Some(block) = detail::build(app, total) {
                    // 開いたタスクは、その行の場所に広げる
                    let start = lines.len();
                    if let Some((line, col)) = block.cursor {
                        text_cursor = Some((start + line, col));
                    }
                    lines.extend(block.lines);
                    focus = Some((start, lines.len()));
                    continue;
                }
                if app.list.cursor.as_deref() == Some(id.as_str())
                    && app.adding.is_none()
                    && focus.is_none()
                {
                    focus = Some((lines.len(), lines.len() + 1));
                }
                lines.push(task_row(app, &view, task, total));
            }
        }
        if is_add_section && let Some(at) = add_line(app, &mut lines) {
            focus = Some((at.0, at.0 + 1));
            text_cursor = Some(at);
        }
    }

    if !any_rows && app.adding.is_none() {
        lines.push(Line::default());
        for (i, text) in empty_lines(app).into_iter().enumerate() {
            let style = if i == 0 {
                theme::muted()
            } else {
                theme::faint()
            };
            lines.push(Line::from(Span::styled(format!("  {text}"), style)));
        }
    }
    if app.screen == Screen::Logbook {
        let shown: usize = view.sections.iter().map(|section| section.rows.len()).sum();
        let all: usize = app
            .store
            .lists()
            .logbook
            .iter()
            .map(|day| day.tasks.len())
            .sum();
        if shown < all {
            lines.push(Line::default());
            lines.push(Line::from(Span::styled(
                fill(Msg::MoreRows, &[&(all - shown)]),
                theme::faint(),
            )));
        }
    }

    // カーソルの行（開いたタスクなら、入るだけ全部）が見えるところまでスクロールする
    let height = area.height as usize;
    let max_scroll = lines.len().saturating_sub(height);
    if let Some((start, end)) = focus {
        if end > app.scroll + height {
            app.scroll = end - height;
        }
        // 行のすぐ上の見出しも見えるように、1行ぶん余裕を持たせる
        if start < app.scroll + 1 {
            app.scroll = start.saturating_sub(1);
        }
    }
    app.scroll = app.scroll.min(max_scroll);

    if let Some((line, col)) = text_cursor
        && line >= app.scroll
        && line < app.scroll + height
    {
        frame.set_cursor_position(Position::new(
            area.x + (col as u16).min(area.width.saturating_sub(1)),
            area.y + (line - app.scroll) as u16,
        ));
    }
    let visible: Vec<Line> = lines.into_iter().skip(app.scroll).take(height).collect();
    frame.render_widget(Paragraph::new(visible), area);
}
