//! 描画。左にサイドバー、右に今の画面、一番下に状態の1行。候補やトーストは上に重ねる

mod board;
mod calendar;
mod detail;
mod list;
mod logo;
mod overlay;
mod timeline;

pub use logo::animation_tick;

use std::time::Duration;

use ratatui::Frame;
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Clear, Paragraph};

use self::logo::{LOGO_HEIGHT, logo_lines};
use super::app::{App, Focus, Screen, ToastKind};
use super::text::{pad, truncate, width};
use super::theme;
use crate::data::StopReason;
use crate::data::lists::sum_points;
use crate::dates::format_day_heading;
use crate::i18n::{Msg, fill, t};
use crate::model::Task;
use crate::upgrade::{upgrade_message, waiting_message};

const SIDEBAR_WIDTH: u16 = 24;
/// 畳んだサイドバー（印だけの細い帯）の幅
const SIDEBAR_RAIL_WIDTH: u16 = 4;
/// これより狭い端末では、サイドバーを出さない
const MIN_WIDTH_FOR_SIDEBAR: u16 = 72;

pub fn draw(frame: &mut Frame, app: &mut App) -> Option<Duration> {
    let area = frame.area();
    if app.login.is_some() {
        return overlay::draw_login(frame, app, area);
    }
    let [body, status] = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(area);
    // サイドバー：畳んでいれば細い帯、狭い端末で広げていれば出さない
    let rail = app.prefs.sidebar_rail;
    let sidebar_width = if rail {
        SIDEBAR_RAIL_WIDTH
    } else if area.width >= MIN_WIDTH_FOR_SIDEBAR {
        SIDEBAR_WIDTH
    } else {
        0
    };
    let (main, logo) = if sidebar_width > 0 {
        let [sidebar, main] =
            Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(20)])
                .areas(body);
        (main, draw_sidebar(frame, app, sidebar, rail))
    } else {
        (body, None)
    };
    let main = Rect {
        x: main.x + 1,
        width: main.width.saturating_sub(2),
        ..main
    };
    let [header, content] =
        Layout::vertical([Constraint::Length(3), Constraint::Min(1)]).areas(main);
    draw_header(frame, app, header);
    match app.screen {
        Screen::Calendar => calendar::draw(frame, app, content),
        Screen::Timeline => timeline::draw(frame, app, content),
        Screen::Shortcuts => overlay::draw_shortcuts(frame, app, content),
        _ if app.is_board() => board::draw(frame, app, content),
        _ => list::draw(frame, app, content),
    }
    // 小さな詳細（ボード・カレンダー・タイムライン）
    if app.detail.is_some() && app.detail_is_popup() {
        detail::draw_popup(frame, app, body);
    }
    draw_status(frame, app, status);
    draw_toasts(frame, app, body);
    overlay::draw(frame, app, body);
    logo
}

/// 完了の丸。未着手は ○、進行中は半分を塗った ◐、完了は ●
pub fn status_glyph(task: &Task) -> Span<'static> {
    if task.is_completed() {
        Span::styled("●", theme::faint())
    } else if task.is_in_progress() {
        Span::styled("◐", Style::new().fg(theme::IN_PROGRESS))
    } else {
        Span::styled("○", theme::muted())
    }
}

/// 優先度の印：3本の棒のうち、高は3本・中は2本・低は1本（色だけに頼らず、形でも分かるように）。高だけ琥珀
pub fn priority_mark(priority: crate::model::Priority) -> Span<'static> {
    use crate::model::Priority;
    match priority {
        Priority::High => Span::styled("▂▄▆", Style::new().fg(theme::ATTENTION)),
        Priority::Medium => Span::styled("▂▄ ", theme::muted()),
        Priority::Low => Span::styled("▂  ", theme::muted()),
    }
}

/// サイドバー。rail なら、畳んだ細い帯（印だけ。見出し・名前・件数は出さない）
fn draw_sidebar(frame: &mut Frame, app: &App, area: Rect, rail: bool) -> Option<Duration> {
    let lists = app.store.lists();
    let focused = app.focus == Focus::Sidebar;
    let inner_width = area.width.saturating_sub(2) as usize;
    let heading = |text: &'static str| Line::from(Span::styled(text, theme::faint()));
    let mut lines: Vec<Line> = vec![Line::from(Span::styled(
        if rail {
            t(Msg::SidebarRailTitle)
        } else {
            " nagi"
        },
        theme::accent().add_modifier(Modifier::BOLD),
    ))];
    lines.push(Line::default());
    let entries = app.sidebar_entries();
    let project_start = entries
        .iter()
        .position(|screen| matches!(screen, Screen::Project(_)));
    for (index, screen) in entries.iter().enumerate() {
        // まとまりの見出し
        match screen {
            Screen::Calendar => {
                lines.push(Line::default());
                if !rail {
                    lines.push(heading(t(Msg::SidebarViews)));
                }
            }
            Screen::Project(_) if Some(index) == project_start => {
                lines.push(Line::default());
                if !rail {
                    lines.push(heading(t(Msg::SidebarProjects)));
                }
            }
            Screen::Logbook => lines.push(Line::default()),
            _ => {}
        }
        let (mark, mark_style, label, count) = match screen {
            Screen::Inbox => (
                "1",
                theme::faint(),
                t(Msg::ListInbox).to_string(),
                lists.inbox.len(),
            ),
            Screen::Today => (
                "2",
                theme::faint(),
                t(Msg::ListToday).to_string(),
                lists.today.len(),
            ),
            Screen::Upcoming => ("3", theme::faint(), t(Msg::ListScheduled).to_string(), 0),
            Screen::Later => ("4", theme::faint(), t(Msg::ListLater).to_string(), 0),
            Screen::Logbook => ("5", theme::faint(), t(Msg::ScreenLogbook).to_string(), 0),
            Screen::Calendar => ("6", theme::faint(), t(Msg::ScreenCalendar).to_string(), 0),
            Screen::Timeline => ("7", theme::faint(), t(Msg::ScreenTimeline).to_string(), 0),
            Screen::Shortcuts => ("?", theme::faint(), t(Msg::ScreenShortcuts).to_string(), 0),
            Screen::Project(id) => (
                "●",
                Style::new().fg(theme::project_color(lists.project_color(id))),
                app.project_name(id).unwrap_or_default().to_string(),
                lists.project(id).open_count(),
            ),
        };
        let current = *screen == app.screen;
        let count_text = if count > 0 {
            count.to_string()
        } else {
            String::new()
        };
        let label_width = inner_width.saturating_sub(4 + width(&count_text));
        let mut style = if current {
            theme::accent().add_modifier(Modifier::BOLD)
        } else {
            Style::new()
        };
        if focused && index == app.sidebar_index {
            style = style.bg(theme::CURSOR_BG);
        } else if current {
            style = style.bg(theme::SELECTED_BG);
        }
        let mut spans = vec![
            Span::styled(" ", style),
            Span::styled(
                mark,
                if current {
                    style
                } else {
                    mark_style.patch(style)
                },
            ),
        ];
        if rail {
            spans.push(Span::styled("  ", style));
        } else {
            spans.push(Span::styled(
                format!(" {}", pad(&label, label_width)),
                style,
            ));
            spans.push(Span::styled(
                format!("{count_text} "),
                theme::muted().patch(style),
            ));
        }
        lines.push(Line::from(spans));
    }
    if project_start.is_none() && !rail {
        lines.push(Line::default());
        lines.push(Line::from(Span::styled(
            t(Msg::SidebarProjects),
            theme::faint(),
        )));
        lines.push(Line::from(Span::styled(
            t(Msg::SidebarCreateHint),
            theme::faint(),
        )));
    }
    let elapsed = app.started_at.elapsed();
    let fits_logo = !rail && area.height as usize > lines.len() + LOGO_HEIGHT as usize + 1;
    if fits_logo {
        let mut with_logo = vec![Line::default()];
        with_logo.extend(logo_lines(elapsed, theme::SURFACE));
        with_logo.push(Line::default());
        with_logo.append(&mut lines);
        lines = with_logo;
    }
    // 長いときは、選んでいる位置が見えるように上を切る
    let visible = area.height as usize;
    let skip = lines
        .len()
        .saturating_sub(visible)
        .min((app.sidebar_index + 8).saturating_sub(visible));
    let block = Block::new().style(Style::new().bg(theme::SURFACE));
    frame.render_widget(
        Paragraph::new(lines.into_iter().skip(skip).collect::<Vec<_>>()).block(block),
        area,
    );
    fits_logo.then_some(elapsed)
}

fn draw_header(frame: &mut Frame, app: &App, area: Rect) {
    let lists = app.store.lists();
    let replica = &app.store.replica;
    let today = &app.store.today;
    let count_and_points = |count: usize, points: u32| {
        let mut parts = Vec::new();
        if count > 0 {
            parts.push(fill(Msg::CountSpaced, &[&count]));
        }
        if points > 0 {
            parts.push(fill(Msg::PointsLabel, &[&points]));
        }
        parts.join(t(Msg::JoinDot))
    };
    let (title, title_style, sub) = match &app.screen {
        Screen::Inbox => (
            t(Msg::ListInbox).to_string(),
            theme::bold(),
            count_and_points(lists.inbox.len(), 0),
        ),
        Screen::Today => (
            t(Msg::ListToday).to_string(),
            theme::bold(),
            [
                format_day_heading(today, today),
                count_and_points(lists.today.len(), sum_points(replica, &lists.today)),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("　"),
        ),
        Screen::Upcoming => (
            t(Msg::ListScheduled).to_string(),
            theme::bold(),
            count_and_points(lists.scheduled.len(), 0),
        ),
        Screen::Later => (
            t(Msg::ListLater).to_string(),
            theme::bold(),
            count_and_points(lists.later.len(), 0),
        ),
        Screen::Logbook => (
            t(Msg::ScreenLogbook).to_string(),
            theme::bold(),
            String::new(),
        ),
        Screen::Calendar => (
            t(Msg::ScreenCalendar).to_string(),
            theme::bold(),
            String::new(),
        ),
        Screen::Timeline => (
            t(Msg::ScreenTimeline).to_string(),
            theme::bold(),
            String::new(),
        ),
        Screen::Shortcuts => (
            t(Msg::ScreenShortcuts).to_string(),
            theme::bold(),
            String::new(),
        ),
        Screen::Project(id) => {
            let groups = lists.project(id);
            let archived = replica
                .project(id)
                .is_some_and(|project| project.archived_at.is_some());
            (
                format!("● {}", app.project_name(id).unwrap_or_default()),
                Style::new()
                    .fg(theme::project_color(lists.project_color(id)))
                    .add_modifier(Modifier::BOLD),
                if archived {
                    t(Msg::ProjectArchived).to_string()
                } else {
                    count_and_points(groups.open_count(), sum_points(replica, groups.open_ids()))
                },
            )
        }
    };
    // 見出しの右：並び方と、リスト｜ボード
    let mut right: Vec<Span> = Vec::new();
    if app.screen.has_sort() {
        let sort = app.sort();
        let style = if sort == crate::data::sort::TaskSort::Manual {
            theme::faint()
        } else {
            theme::accent()
        };
        right.push(Span::styled(fill(Msg::SortedBy, &[&sort.label()]), style));
    }
    if app.screen.has_board() {
        let (list, board) = if app.is_board() {
            (theme::faint(), theme::accent())
        } else {
            (theme::accent(), theme::faint())
        };
        right.push(Span::styled(t(Msg::ViewList), list));
        right.push(Span::styled("｜", theme::faint()));
        right.push(Span::styled(t(Msg::ViewBoard), board));
    }
    let right_width: usize = right.iter().map(|span| width(&span.content)).sum();
    let title_width = (area.width as usize).saturating_sub(right_width + 1);
    let mut first = vec![Span::styled(pad(&title, title_width), title_style)];
    first.push(Span::raw(" "));
    first.extend(right);
    let lines = vec![
        Line::default(),
        Line::from(first),
        Line::from(Span::styled(sub, theme::muted())),
    ];
    frame.render_widget(Paragraph::new(lines), area);
}

/// 一番下の1行：左に今の場面で使えるキー、右に通信の状態
fn draw_status(frame: &mut Frame, app: &App, area: Rect) {
    let hint = if app.adding.is_some() {
        t(Msg::HintBarAdd)
    } else if app
        .detail
        .as_ref()
        .is_some_and(|detail| detail.edit.is_some())
    {
        t(Msg::HintBarMemo)
    } else if app.detail.is_some() {
        t(Msg::HintBarDetail)
    } else if app.focus == Focus::Sidebar {
        t(Msg::HintBarSidebar)
    } else {
        match app.screen {
            Screen::Calendar => t(Msg::HintBarCalendar),
            Screen::Timeline => t(Msg::HintBarTimeline),
            Screen::Shortcuts => t(Msg::HintBarShortcuts),
            _ => t(Msg::HintBarList),
        }
    };
    let (state, state_style) = match app.store.stopped_by {
        Some(StopReason::VersionMismatch | StopReason::UnreadablePending) => (
            upgrade_message(&app.store),
            Style::new().fg(theme::ATTENTION),
        ),
        Some(StopReason::Unauthorized) => (
            t(Msg::StatusLoginExpired).to_string(),
            Style::new().fg(theme::ATTENTION),
        ),
        None if app.store.waiting_for_server => (
            waiting_message(&app.store),
            Style::new().fg(theme::ATTENTION),
        ),
        None if !app.store.is_online => (
            t(Msg::StatusOffline).to_string(),
            Style::new().fg(theme::ATTENTION),
        ),
        None if app.should_quit => (t(Msg::StatusSaving).to_string(), theme::muted()),
        None if app.store.pending_count() > 0 => {
            (t(Msg::StatusSavingShort).to_string(), theme::muted())
        }
        None if !app.store.synced => (t(Msg::StatusSyncing).to_string(), theme::muted()),
        // この端末だけで使っている（Worker とは同期していない）
        None if !app.config.is_cloud() => (t(Msg::StatusLocal).to_string(), theme::faint()),
        None => (String::new(), theme::muted()),
    };
    let state_width = width(&state);
    let hint_width = (area.width as usize).saturating_sub(state_width + 3);
    let line = Line::from(vec![
        Span::styled(format!(" {}", pad(hint, hint_width)), theme::faint()),
        Span::raw(" "),
        Span::styled(state, state_style),
        Span::raw(" "),
    ]);
    frame.render_widget(Paragraph::new(line), area);
}

/// トースト。右下に、新しいものを下にして重ねる
fn draw_toasts(frame: &mut Frame, app: &App, area: Rect) {
    let mut y = area.bottom();
    for toast in app.toasts.iter().rev() {
        let mut text = format!(" {} ", toast.message);
        if let Some(detail) = &toast.detail {
            text = format!("{text}— {detail} ");
        }
        let action = if toast.kind == ToastKind::Undo {
            t(Msg::HintUndo)
        } else {
            ""
        };
        let max = (area.width as usize).saturating_sub(4);
        let text = truncate(&text, max.saturating_sub(width(action)));
        let total = (width(&text) + width(action)) as u16;
        if y <= area.y + 1 || total == 0 {
            break;
        }
        y -= 1;
        let rect = Rect {
            x: area.right().saturating_sub(total),
            y,
            width: total,
            height: 1,
        };
        let style = match toast.kind {
            ToastKind::Error => Style::new().fg(theme::DANGER).bg(theme::SURFACE),
            _ => Style::new().bg(theme::SURFACE),
        };
        clear_for_popup(frame, rect);
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(text, style),
                Span::styled(action, theme::accent().bg(theme::SURFACE)),
            ])),
            rect,
        );
    }
}

/// 重ねて出す枠の場所を空ける。枠の左隣が全角の文字だと、その右半分が枠の左端にはみ出すので、
/// 左隣の文字も空白にする
pub fn clear_for_popup(frame: &mut Frame, rect: Rect) {
    frame.render_widget(Clear, rect);
    if rect.x == 0 {
        return;
    }
    let buffer = frame.buffer_mut();
    for y in rect.top()..rect.bottom() {
        if let Some(cell) = buffer.cell_mut((rect.x - 1, y))
            && width(cell.symbol()) > 1
        {
            cell.set_symbol(" ");
        }
    }
}

/// 画面の真ん中に、幅と高さを決めた枠を置く
pub fn centered(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width.saturating_sub(2)).max(1);
    let height = height.min(area.height.saturating_sub(1)).max(1);
    Rect {
        x: area.x + (area.width.saturating_sub(width)) / 2,
        y: area.y + (area.height.saturating_sub(height)) / 3,
        width,
        height,
    }
}
