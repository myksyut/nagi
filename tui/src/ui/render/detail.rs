//! 開いたタスク。一覧ではその行の場所に広げ、ボード・カレンダー・タイムラインでは小さな詳細として重ねる。
//! 中身：完了の丸とタイトル・メモ・チェックリスト・状態・いつやる・締切・プロジェクト・優先度・工数

use ratatui::Frame;
use ratatui::layout::{Position, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};

use super::{centered, clear_for_popup, status_glyph};
use crate::dates::{deadline_status, format_long_date};
use crate::model::{Bucket, Task};
use crate::ui::app::{App, DetailEdit, DetailField};
use crate::ui::text::{truncate, wrap};
use crate::ui::theme;

/// メモを直していないときに出す行数の上限
const MEMO_PREVIEW_LINES: usize = 6;

pub struct DetailBlock {
    pub lines: Vec<Line<'static>>,
    /// 入力欄のカーソル（行、桁）
    pub cursor: Option<(usize, usize)>,
}

fn when_label(app: &App, task: &Task) -> String {
    if task.is_completed() {
        return "完了".to_string();
    }
    match task.bucket {
        Bucket::Inbox => "受信箱".to_string(),
        Bucket::Today => "今日".to_string(),
        Bucket::Later => "あとで".to_string(),
        Bucket::Scheduled => task
            .scheduled_on
            .as_deref()
            .map_or("予定".to_string(), |on| {
                format_long_date(on, &app.store.today)
            }),
    }
}

/// 開いているタスクの中身を、幅 width の行にする
pub fn build(app: &App, width_total: usize) -> Option<DetailBlock> {
    let detail = app.detail.as_ref()?;
    let task = app.task(&detail.task_id)?;
    let lists = app.store.lists();
    let today = &app.store.today;
    let inner = width_total.saturating_sub(4).max(8);
    let focused = |field: &DetailField| detail.edit.is_none() && detail.field == *field;
    let mark = |on: bool| {
        if on {
            Span::styled("▌ ", theme::accent())
        } else {
            Span::styled("│ ", Style::new().fg(theme::BORDER))
        }
    };
    let mut lines: Vec<Line<'static>> = Vec::new();
    let mut cursor = None;

    // 完了の丸とタイトル
    let title_focus = focused(&DetailField::Title);
    let mut title_line = vec![mark(title_focus), status_glyph(task), Span::raw(" ")];
    match &detail.edit {
        Some(DetailEdit::Title(input)) => {
            let (shown, at) = input.visible(inner.saturating_sub(2));
            cursor = Some((lines.len(), 4 + at));
            title_line.push(Span::styled(shown, theme::bold()));
        }
        _ => {
            let mut style = theme::bold();
            if title_focus {
                style = style.bg(theme::CURSOR_BG);
            }
            title_line.push(Span::styled(
                truncate(&task.title, inner.saturating_sub(2)),
                style,
            ));
        }
    }
    lines.push(Line::from(title_line));

    // メモ
    let memo_focus = focused(&DetailField::Memo);
    match &detail.edit {
        Some(DetailEdit::Memo(area)) => {
            let (row, col) = area.cursor();
            for (i, text) in area.lines().into_iter().enumerate() {
                if i == row {
                    cursor = Some((lines.len(), 4 + col.min(inner.saturating_sub(1))));
                }
                lines.push(Line::from(vec![
                    mark(true),
                    Span::raw("  "),
                    Span::raw(truncate(&text, inner)),
                ]));
            }
        }
        _ if task.memo.trim().is_empty() => {
            let mut style = theme::faint();
            if memo_focus {
                style = style.bg(theme::CURSOR_BG);
            }
            lines.push(Line::from(vec![
                mark(memo_focus),
                Span::raw("  "),
                Span::styled("メモ", style),
            ]));
        }
        _ => {
            let wrapped = wrap(&task.memo, inner);
            let more = wrapped.len().saturating_sub(MEMO_PREVIEW_LINES);
            for text in wrapped.into_iter().take(MEMO_PREVIEW_LINES) {
                let mut style = theme::muted();
                if memo_focus {
                    style = style.bg(theme::CURSOR_BG);
                }
                lines.push(Line::from(vec![
                    mark(memo_focus),
                    Span::raw("  "),
                    Span::styled(text, style),
                ]));
            }
            if more > 0 {
                lines.push(Line::from(vec![
                    mark(memo_focus),
                    Span::styled(format!("  …ほか {more} 行"), theme::faint()),
                ]));
            }
        }
    }

    // チェックリスト
    for item in &task.checklist {
        let field = DetailField::Item(item.id.clone());
        let on = focused(&field);
        let check = if item.done { "☑ " } else { "☐ " };
        let mut spans = vec![
            mark(on),
            Span::raw("  "),
            Span::styled(check, theme::muted()),
        ];
        match &detail.edit {
            Some(DetailEdit::Item(id, input)) if *id == item.id => {
                let (shown, at) = input.visible(inner.saturating_sub(2));
                cursor = Some((lines.len(), 6 + at));
                spans[0] = mark(true);
                spans.push(Span::raw(shown));
            }
            _ => {
                let mut style = if item.done {
                    theme::faint()
                } else {
                    Style::new()
                };
                if on {
                    style = style.bg(theme::CURSOR_BG);
                }
                spans.push(Span::styled(
                    truncate(&item.title, inner.saturating_sub(2)),
                    style,
                ));
            }
        }
        lines.push(Line::from(spans));
    }
    let add_focus = focused(&DetailField::AddItem);
    match &detail.edit {
        Some(DetailEdit::AddItem(input)) => {
            let (shown, at) = input.visible(inner.saturating_sub(2));
            cursor = Some((lines.len(), 6 + at));
            lines.push(Line::from(vec![
                mark(true),
                Span::styled("  ＋ ", theme::muted()),
                Span::raw(shown),
            ]));
        }
        _ => {
            let mut style = theme::faint();
            if add_focus {
                style = style.bg(theme::CURSOR_BG);
            }
            lines.push(Line::from(vec![
                mark(add_focus),
                Span::raw("  "),
                Span::styled("＋ 項目を追加", style),
            ]));
        }
    }

    // 小さなボタン：状態・いつやる・締切／プロジェクト・優先度・工数
    let status = if task.is_completed() {
        "● 完了"
    } else if task.is_in_progress() {
        "◐ 進行中"
    } else {
        "○ 未着手"
    };
    let deadline = task.deadline_on.as_deref().map(|on| {
        format!(
            "{}（{}）",
            format_long_date(on, today),
            deadline_status(on, today).1
        )
    });
    let project = task
        .project_id
        .as_deref()
        .and_then(|id| app.project_name(id).map(|name| (id, name)));
    let button = |field: DetailField, label: &str, value: String, value_style: Style| {
        let on = focused(&field);
        let mut label_style = theme::faint();
        let mut style = value_style;
        if on {
            label_style = label_style.bg(theme::CURSOR_BG);
            style = style.bg(theme::CURSOR_BG);
        }
        (
            on,
            vec![
                Span::styled(format!("{label} "), label_style),
                Span::styled(value, style),
                Span::raw("   "),
            ],
        )
    };
    let rows = [
        vec![
            button(
                DetailField::Status,
                "状態",
                status.to_string(),
                Style::new(),
            ),
            button(
                DetailField::When,
                "いつやる",
                when_label(app, task),
                Style::new(),
            ),
            button(
                DetailField::Deadline,
                "締切",
                deadline.unwrap_or_else(|| "なし".to_string()),
                if task.deadline_on.is_some() {
                    Style::new()
                } else {
                    theme::muted()
                },
            ),
        ],
        vec![
            button(
                DetailField::Project,
                "プロジェクト",
                project.map_or("なし".to_string(), |(_, name)| format!("● {name}")),
                match project {
                    Some((id, _)) => Style::new().fg(theme::project_color(lists.project_color(id))),
                    None => theme::muted(),
                },
            ),
            button(
                DetailField::Priority,
                "優先度",
                task.priority
                    .map_or("なし".to_string(), |p| p.label().to_string()),
                if task.priority.is_some() {
                    Style::new()
                } else {
                    theme::muted()
                },
            ),
            button(
                DetailField::Points,
                "工数",
                task.points.map_or("なし".to_string(), |p| p.to_string()),
                if task.points.is_some() {
                    Style::new()
                } else {
                    theme::muted()
                },
            ),
        ],
    ];
    for row in rows {
        let on = row.iter().any(|(on, _)| *on);
        let mut spans = vec![mark(on), Span::raw("  ")];
        spans.extend(row.into_iter().flat_map(|(_, spans)| spans));
        lines.push(Line::from(spans));
    }
    Some(DetailBlock { lines, cursor })
}

/// 小さな詳細（ボード・カレンダー・タイムライン）。画面の真ん中に重ねる
pub fn draw_popup(frame: &mut Frame, app: &App, area: Rect) {
    let popup_width = 76.min(area.width.saturating_sub(4));
    let Some(block) = build(app, popup_width.saturating_sub(2) as usize) else {
        return;
    };
    let height = (block.lines.len() as u16 + 2).min(area.height.saturating_sub(2));
    let rect = centered(area, popup_width, height);
    clear_for_popup(frame, rect);
    let frame_block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(theme::BORDER))
        .style(Style::new().bg(theme::SURFACE))
        .title(Span::styled(
            " タスク ",
            theme::muted().add_modifier(Modifier::BOLD),
        ));
    let inner = frame_block.inner(rect);
    // 長いときは、カーソルや選んでいる欄が見えるように上を切る
    let focus_line = block.cursor.map(|(line, _)| line).or_else(|| {
        block.lines.iter().position(|line| {
            line.spans
                .first()
                .is_some_and(|span| span.content.starts_with('▌'))
        })
    });
    let skip = focus_line.map_or(0, |line| (line + 1).saturating_sub(inner.height as usize));
    if let Some((line, col)) = block.cursor
        && line >= skip
    {
        frame.set_cursor_position(Position::new(
            inner.x + (col as u16).min(inner.width.saturating_sub(1)),
            inner.y + (line - skip) as u16,
        ));
    }
    let lines: Vec<Line> = block.lines.into_iter().skip(skip).collect();
    frame.render_widget(Paragraph::new(lines).block(frame_block), rect);
}
