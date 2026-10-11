//! 画面の状態。データはストアが持ち、ここでは「どの画面か・何を選んでいるか・何を開いているか」を持つ

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use super::AppEvent;
use super::list::{AddTarget, Column, ListKind, ListState, ListView, Section};
use super::login::Login;
use super::text::{TextArea, TextInput};
use super::views::ProjectFilter;
use crate::config::{Config, Prefs};
use crate::data::lists::split_by_started;
use crate::data::net::NetEvent;
use crate::data::sort::{TaskSort, sort_tasks};
use crate::data::{Destination, Notice, SaveFailure, Store};
use crate::dates::{add_days, schedule_heading};
use crate::model::{Mutation, Task};

/// 一度に描く完了ログの行数。続きは、一番下で ↓ を押すと読み込む
pub const LOGBOOK_PAGE_SIZE: usize = 200;
/// トーストを出しておく時間
const TOAST_DURATION: Duration = Duration::from_secs(6);
/// 差分を取りに行く間隔（ほかの端末の変更を拾う）。オフラインのあいだは短くして、つながったかを確かめる
const SYNC_INTERVAL: Duration = Duration::from_secs(45);
const OFFLINE_RETRY_INTERVAL: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Screen {
    Inbox,
    Today,
    Upcoming,
    Later,
    Logbook,
    Project(String),
    Calendar,
    Timeline,
    Shortcuts,
}

impl Screen {
    /// 一覧の名前（選択・開閉・リスト｜ボード・並び方をこの名前で覚える）。一覧でない画面は None
    pub fn view_key(&self) -> Option<String> {
        Some(match self {
            Screen::Inbox => "inbox".to_string(),
            Screen::Today => "today".to_string(),
            Screen::Upcoming => "upcoming".to_string(),
            Screen::Later => "later".to_string(),
            Screen::Logbook => "logbook".to_string(),
            Screen::Project(id) => format!("project:{id}"),
            Screen::Calendar | Screen::Timeline | Screen::Shortcuts => return None,
        })
    }

    /// リスト｜ボードを切り替えられる画面か
    pub fn has_board(&self) -> bool {
        matches!(self, Screen::Today | Screen::Project(_))
    }

    /// 並び方を選べる画面か
    pub fn has_sort(&self) -> bool {
        matches!(self, Screen::Today | Screen::Later | Screen::Project(_))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Focus {
    Main,
    Sidebar,
}

/// 開いたタスクの欄
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DetailField {
    Title,
    Memo,
    /// チェックリストの項目（項目の id）
    Item(String),
    AddItem,
    Status,
    When,
    Deadline,
    Project,
    Priority,
    Points,
}

/// 開いたタスクで、文字を直している欄
pub enum DetailEdit {
    Title(TextInput),
    Memo(TextArea),
    Item(String, TextInput),
    AddItem(TextInput),
}

/// 開いているタスク。一覧ではその場で下に広がり、ボード・カレンダー・タイムラインでは小さな詳細として重ねて出す
pub struct Detail {
    pub task_id: String,
    pub field: DetailField,
    pub edit: Option<DetailEdit>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DateKind {
    /// d：日付を決めて予定へ
    Schedule,
    /// D：締切
    Deadline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ValueKind {
    Priority,
    Points,
}

impl ValueKind {
    pub fn label(self) -> &'static str {
        match self {
            ValueKind::Priority => "優先度",
            ValueKind::Points => "工数",
        }
    }
}

/// 小さな追加欄の行き先
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QuickTarget {
    Inbox,
    Today,
    /// その日の予定（今日か過去の日なら今日へ入る）
    Date(String),
}

/// 画面に重ねて出すもの（開いているあいだは、キーをすべてここで受ける）
pub enum Overlay {
    /// 日付の入力（d・D）
    Date {
        kind: DateKind,
        ids: Vec<String>,
        input: TextInput,
    },
    /// p の候補
    Project {
        ids: Vec<String>,
        input: TextInput,
        index: usize,
    },
    /// 優先度・工数の候補
    Value {
        kind: ValueKind,
        ids: Vec<String>,
        index: usize,
    },
    /// 並び方の一覧
    Sort { index: usize },
    /// 検索とコマンド
    Palette { input: TextInput, index: usize },
    /// プロジェクトの色の候補
    Color { project_id: String, index: usize },
    /// プロジェクトの名前の欄（作成か、rename のプロジェクトの名前の変更）
    Name {
        input: TextInput,
        rename: Option<String>,
    },
    /// 小さな追加欄（カレンダーとタイムライン）
    QuickAdd {
        input: TextInput,
        targets: Vec<QuickTarget>,
        index: usize,
    },
    /// カレンダー・タイムラインのプロジェクトの絞り込み
    Filter { index: usize },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToastKind {
    /// 「元に戻す」付き（u で戻す）
    Undo,
    Info,
    Error,
}

pub struct Toast {
    pub message: String,
    pub detail: Option<String>,
    pub kind: ToastKind,
    pub until: Instant,
}

pub struct CalendarState {
    /// 選んでいる日
    pub day: String,
    /// その日の中で選んでいるもの（◆かタスク）の位置
    pub entry: usize,
    pub filter: ProjectFilter,
}

pub struct TimelineState {
    /// 選んでいるタスク
    pub cursor: Option<String>,
    /// 左端に出す日（範囲の始まりからの日数）
    pub scroll: i64,
    pub filter: ProjectFilter,
}

/// 直せる文字の項目（保存できなかった文字を覚えておく鍵）
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextField {
    Title,
    Memo,
}

pub struct App {
    pub config: Config,
    pub store: Store,
    /// いまのログインの持ち主（Worker の利用者の ID。分からなければ None）。手元の控えは、この利用者のもの
    pub user_id: Option<String>,
    pub screen: Screen,
    /// ショートカットのページから戻る先
    pub previous_screen: Screen,
    pub focus: Focus,
    pub list: ListState,
    /// 一覧の一番上に出している行（スクロールの位置）
    pub scroll: usize,
    pub detail: Option<Detail>,
    /// 一覧の追加欄（開いているあいだ Some）
    pub adding: Option<TextInput>,
    /// 追加欄の下書き（閉じても残る）
    pub add_draft: String,
    /// 保存できずに戻ってきた追加の文字の残り（追加欄が空になったら、次を下書きに入れる）
    pub draft_queue: VecDeque<String>,
    /// 追加欄を開いてから最後に追加したタスク（Esc で閉じるとこれを選ぶ）
    pub last_added: Option<String>,
    /// まだ保存できていないタイトルとメモ（次にそのタスクの欄を開いたら戻す）
    pub unsaved_text: HashMap<(String, TextField), String>,
    pub overlay: Option<Overlay>,
    pub toasts: Vec<Toast>,
    pub prefs: Prefs,
    /// 完了ログで描く行数
    pub logbook_limit: usize,
    pub calendar: CalendarState,
    pub timeline: TimelineState,
    /// サイドバーで選んでいる位置
    pub sidebar_index: usize,
    /// ショートカットのページの絞り込み
    pub shortcuts_filter: TextInput,
    pub shortcuts_scroll: usize,
    /// ログインの画面（出ているあいだ Some）
    pub login: Option<Login>,
    pub should_quit: bool,
    /// 画面のスレッドへ知らせを送る口（通信とログインのスレッドに渡す）
    pub events: Sender<AppEvent>,
    /// ストアと通信の世代。ログインし直して作り直すたびに進め、古い通信の結果を捨てる
    pub generation: u64,
    last_sync: Instant,
    /// 起動した時刻。ホームのロゴの日の出の時計
    pub started_at: Instant,
}

impl App {
    pub fn new(
        config: Config,
        store: Store,
        user_id: Option<String>,
        events: Sender<AppEvent>,
    ) -> App {
        let today = store.today.clone();
        let prefs = config.load_prefs();
        App {
            config,
            store,
            user_id,
            screen: Screen::Today,
            previous_screen: Screen::Today,
            focus: Focus::Main,
            list: ListState::default(),
            scroll: 0,
            detail: None,
            adding: None,
            add_draft: String::new(),
            draft_queue: VecDeque::new(),
            last_added: None,
            unsaved_text: HashMap::new(),
            overlay: None,
            toasts: Vec::new(),
            prefs,
            logbook_limit: LOGBOOK_PAGE_SIZE,
            calendar: CalendarState {
                day: today,
                entry: 0,
                filter: ProjectFilter::All,
            },
            timeline: TimelineState {
                cursor: None,
                scroll: 0,
                filter: ProjectFilter::All,
            },
            sidebar_index: 1,
            shortcuts_filter: TextInput::default(),
            shortcuts_scroll: 0,
            login: None,
            should_quit: false,
            events,
            generation: 0,
            last_sync: Instant::now(),
            started_at: Instant::now(),
        }
    }

    // --- 読む ---------------------------------------------------------------------------

    pub fn task(&self, id: &str) -> Option<&Task> {
        self.store.replica.task(id)
    }

    /// その画面をボードで見ているか
    pub fn is_board(&self) -> bool {
        self.screen.has_board()
            && self
                .screen
                .view_key()
                .is_some_and(|key| self.prefs.board.contains(&key))
    }

    /// 今の画面の並び方
    pub fn sort(&self) -> TaskSort {
        if !self.screen.has_sort() {
            return TaskSort::Manual;
        }
        self.screen
            .view_key()
            .and_then(|key| self.prefs.sort.get(&key))
            .and_then(|name| TaskSort::from_key(name))
            .unwrap_or_default()
    }

    /// 削除されていないプロジェクトの名前
    pub fn project_name(&self, id: &str) -> Option<&str> {
        self.store
            .replica
            .project(id)
            .filter(|project| project.deleted_at.is_none())
            .map(|project| project.name.as_str())
    }

    fn is_archived(&self, project_id: &str) -> bool {
        self.store
            .replica
            .project(project_id)
            .is_some_and(|project| project.archived_at.is_some())
    }

    /// 並べ替えられるまとまりを、今の並び方で並べ替えて見せる（rank は変えない）
    fn sort_sections(&self, mut sections: Vec<Section>) -> Vec<Section> {
        let sort = self.sort();
        if sort != TaskSort::Manual {
            for section in &mut sections {
                if section.reorderable {
                    let rows = std::mem::take(&mut section.rows);
                    section.rows = sort_tasks(&self.store.replica, rows, sort);
                    section.sorted = true;
                }
            }
        }
        sections
    }

    /// 今の画面の一覧の中身（一覧でない画面は None）
    pub fn view(&self) -> Option<ListView> {
        let lists = self.store.lists();
        let replica = &self.store.replica;
        let key = self.screen.view_key()?;
        let board = self.is_board();
        let section = |key: &str, rows: &[String]| Section {
            key: key.to_string(),
            rows: rows.to_vec(),
            ..Default::default()
        };
        let inbox_target = AddTarget {
            to: Destination::Inbox,
            project_id: None,
            label: "受信箱に追加",
        };
        let view = match &self.screen {
            Screen::Inbox => ListView {
                key,
                kind: ListKind::Inbox,
                sections: vec![section("open", &lists.inbox)],
                add_to: inbox_target,
                add_in_section: Some("open".to_string()),
                board,
            },
            Screen::Today => {
                let add_to = AddTarget {
                    to: Destination::Today,
                    project_id: None,
                    label: "今日に追加",
                };
                if board {
                    let (not_started, in_progress) = split_by_started(replica, &lists.today);
                    ListView {
                        key,
                        kind: ListKind::Today,
                        sections: self.sort_sections(vec![
                            Section {
                                column: Some(Column::NotStarted),
                                reorderable: true,
                                ..section("notStarted", &not_started)
                            },
                            Section {
                                column: Some(Column::InProgress),
                                reorderable: true,
                                ..section("inProgress", &in_progress)
                            },
                            Section {
                                column: Some(Column::Completed),
                                ..section("completed", &lists.completed_today)
                            },
                        ]),
                        add_to,
                        add_in_section: Some("notStarted".to_string()),
                        board,
                    }
                } else {
                    ListView {
                        key,
                        kind: ListKind::Today,
                        sections: self.sort_sections(vec![
                            Section {
                                reorderable: true,
                                ..section("open", &lists.today)
                            },
                            Section {
                                fold: Some(format!("完了 {}件", lists.completed_today.len())),
                                ..section("completed", &lists.completed_today)
                            },
                        ]),
                        add_to,
                        add_in_section: Some("open".to_string()),
                        board,
                    }
                }
            }
            Screen::Upcoming => {
                // 日付ごとのまとまり（明日、10/2(金)、…）
                let mut sections: Vec<Section> = Vec::new();
                for id in &lists.scheduled {
                    let date = replica
                        .task(id)
                        .and_then(|task| task.scheduled_on.clone())
                        .unwrap_or_default();
                    if sections.last().is_none_or(|last| last.key != date) {
                        sections.push(Section {
                            key: date.clone(),
                            heading: Some(schedule_heading(&date, &self.store.today)),
                            ..Default::default()
                        });
                    }
                    if let Some(last) = sections.last_mut() {
                        last.rows.push(id.clone());
                    }
                }
                ListView {
                    key,
                    kind: ListKind::Upcoming,
                    sections,
                    add_to: inbox_target,
                    add_in_section: None,
                    board,
                }
            }
            Screen::Later => {
                // プロジェクトなしが先頭（見出しなし）、そのあとにプロジェクトごと（作成順、見出しは名前）
                let mut none = Vec::new();
                let mut by_project: Vec<(&crate::model::Project, Vec<String>)> = Vec::new();
                for id in &lists.later {
                    let project = replica
                        .task(id)
                        .and_then(|task| task.project_id.as_deref())
                        .and_then(|project_id| replica.project(project_id))
                        .filter(|project| project.deleted_at.is_none());
                    match project {
                        None => none.push(id.clone()),
                        Some(project) => {
                            match by_project.iter_mut().find(|(p, _)| p.id == project.id) {
                                Some((_, rows)) => rows.push(id.clone()),
                                None => by_project.push((project, vec![id.clone()])),
                            }
                        }
                    }
                }
                by_project.sort_by(|(a, _), (b, _)| {
                    a.created_at
                        .cmp(&b.created_at)
                        .then_with(|| a.id.cmp(&b.id))
                });
                let mut sections = vec![Section {
                    reorderable: true,
                    ..section("none", &none)
                }];
                sections.extend(by_project.into_iter().map(|(project, rows)| Section {
                    key: format!("project:{}", project.id),
                    heading: Some(project.name.clone()),
                    rows,
                    reorderable: true,
                    ..Default::default()
                }));
                ListView {
                    key,
                    kind: ListKind::Later,
                    sections: self.sort_sections(sections),
                    add_to: AddTarget {
                        to: Destination::Later,
                        project_id: None,
                        label: "あとでに追加",
                    },
                    add_in_section: Some("none".to_string()),
                    board,
                }
            }
            Screen::Logbook => {
                // 完了した日ごとに新しい順。描くのは logbook_limit 行まで
                let mut sections = Vec::new();
                let mut left = self.logbook_limit;
                for day in &lists.logbook {
                    if left == 0 {
                        break;
                    }
                    let take = day.tasks.len().min(left);
                    left -= take;
                    sections.push(Section {
                        key: day.date.clone(),
                        heading: Some(crate::dates::format_day_heading(
                            &day.date,
                            &self.store.today,
                        )),
                        rows: day.tasks[..take].to_vec(),
                        ..Default::default()
                    });
                }
                ListView {
                    key,
                    kind: ListKind::Logbook,
                    sections,
                    add_to: inbox_target,
                    add_in_section: None,
                    board,
                }
            }
            Screen::Project(id) => {
                let groups = lists.project(id);
                // アーカイブ済みのプロジェクトには付けられないので、そのときは受信箱（プロジェクトなし）に入れる
                let archived = self.is_archived(id);
                let add_to = if archived {
                    inbox_target
                } else {
                    AddTarget {
                        to: Destination::Later,
                        project_id: Some(id.clone()),
                        label: "あとでに追加",
                    }
                };
                let headed =
                    |key: &str, heading: &str, rows: &[String], reorderable: bool| Section {
                        heading: Some(heading.to_string()),
                        reorderable,
                        ..section(key, rows)
                    };
                if board {
                    let (not_started, in_progress) = split_by_started(replica, &groups.today);
                    let column = |column: Column, section: Section| Section {
                        column: Some(column),
                        ..section
                    };
                    ListView {
                        key,
                        kind: ListKind::Project,
                        sections: self.sort_sections(vec![
                            column(
                                Column::NotStarted,
                                headed("today", "今日", &not_started, true),
                            ),
                            column(
                                Column::NotStarted,
                                headed("scheduled", "予定", &groups.scheduled, false),
                            ),
                            column(
                                Column::NotStarted,
                                headed("later", "あとで", &groups.later, true),
                            ),
                            column(
                                Column::NotStarted,
                                headed("inbox", "受信箱", &groups.inbox, false),
                            ),
                            column(
                                Column::InProgress,
                                Section {
                                    reorderable: true,
                                    ..section("inProgress", &in_progress)
                                },
                            ),
                            column(
                                Column::Completed,
                                section("completed", &lists.project_board_completed(replica, id)),
                            ),
                        ]),
                        add_to,
                        // アーカイブ済みなら未着手の列の一番上、そうでなければ「あとで」の一番下
                        add_in_section: (!archived).then(|| "later".to_string()),
                        board,
                    }
                } else {
                    ListView {
                        key,
                        kind: ListKind::Project,
                        sections: self.sort_sections(vec![
                            headed("today", "今日", &groups.today, true),
                            headed("scheduled", "予定", &groups.scheduled, false),
                            headed("later", "あとで", &groups.later, true),
                            headed("inbox", "受信箱", &groups.inbox, false),
                            Section {
                                fold: Some(format!("完了 {}件", groups.completed.len())),
                                ..section("completed", &groups.completed)
                            },
                        ]),
                        add_to,
                        add_in_section: (!archived).then(|| "later".to_string()),
                        board,
                    }
                }
            }
            Screen::Calendar | Screen::Timeline | Screen::Shortcuts => return None,
        };
        Some(view)
    }

    /// 小さな詳細として重ねて出す画面か（ボード・カレンダー・タイムライン）
    pub fn detail_is_popup(&self) -> bool {
        self.is_board() || matches!(self.screen, Screen::Calendar | Screen::Timeline)
    }

    /// キーの操作の対象：開いているタスクがあればそのタスク、なければ選んでいる行（上から見えている順）。
    /// カレンダーとタイムラインでは、選んでいるタスク
    pub fn targets(&self) -> Vec<String> {
        if let Some(detail) = &self.detail {
            return vec![detail.task_id.clone()];
        }
        match &self.screen {
            Screen::Calendar => self
                .calendar_entry()
                .map(|entry| vec![entry.task_id])
                .unwrap_or_default(),
            Screen::Timeline => self.timeline.cursor.iter().cloned().collect(),
            _ => self
                .view()
                .map(|view| self.list.selected_rows(&view))
                .unwrap_or_default(),
        }
    }

    /// 対象のうち、未完了のタスク（t・l・d・D・s の対象）
    pub fn open_targets(&self) -> Vec<String> {
        self.targets()
            .into_iter()
            .filter(|id| self.task(id).is_some_and(|task| !task.is_completed()))
            .collect()
    }

    // --- 画面を移る ---------------------------------------------------------------------

    pub fn navigate(&mut self, screen: Screen) {
        if screen == self.screen {
            return;
        }
        self.close_detail();
        self.stop_adding();
        let from = self.view();
        if screen == Screen::Shortcuts {
            self.previous_screen = self.screen.clone();
            self.shortcuts_filter.clear();
            self.shortcuts_scroll = 0;
        }
        self.screen = screen;
        self.scroll = 0;
        self.logbook_limit = LOGBOOK_PAGE_SIZE;
        let to = self.view();
        self.list.switch_view(from.as_ref(), to.as_ref());
        self.sidebar_index = self.sidebar_position();
        match self.screen {
            Screen::Calendar => self.calendar.entry = 0,
            Screen::Timeline => self.ensure_timeline_cursor(),
            _ => {}
        }
    }

    /// 開いているあいだにプロジェクトがなくなったら（作ったあとの元に戻す、保存できずに消えた作成）、今日へ移る。
    /// 選んでいた行が消えていたら、選択を片付ける
    pub fn reconcile(&mut self) {
        if let Screen::Project(id) = &self.screen
            && self.project_name(id).is_none()
        {
            self.navigate(Screen::Today);
        }
        if let Some(detail) = &self.detail
            && self
                .task(&detail.task_id)
                .is_none_or(|task| task.deleted_at.is_some())
        {
            self.detail = None;
        }
        if let Some(view) = self.view() {
            self.list.reconcile(&view);
            // 開いているタスクが一覧から消えたら閉じる（小さな詳細は、画面ごとに決める）
            if let Some(detail) = &self.detail
                && !self.detail_is_popup()
                && !view.rows(&self.list).contains(&detail.task_id.as_str())
                && detail.edit.is_none()
            {
                self.detail = None;
            }
        }
        if self.screen == Screen::Timeline {
            self.ensure_timeline_cursor();
        }
        for filter in [&mut self.calendar.filter, &mut self.timeline.filter] {
            // 絞り込んでいたプロジェクトがアーカイブ・削除されたら「すべて」に戻す
            if let ProjectFilter::Project(id) = filter
                && !self.store.lists().projects.contains(id)
            {
                *filter = ProjectFilter::All;
            }
        }
    }

    // --- トースト -----------------------------------------------------------------------

    fn push_toast(&mut self, message: &str, detail: Option<&str>, kind: ToastKind) {
        self.toasts.push(Toast {
            message: message.to_string(),
            detail: detail.map(str::to_string),
            kind,
            until: Instant::now() + TOAST_DURATION,
        });
        let extra = self.toasts.len().saturating_sub(3);
        self.toasts.drain(..extra);
    }

    pub fn toast_info(&mut self, message: &str) {
        self.push_toast(message, None, ToastKind::Info);
    }

    pub fn toast_error(&mut self, message: &str, detail: Option<&str>) {
        self.push_toast(message, detail, ToastKind::Error);
    }

    /// 「元に戻す」付きのトースト（前のものは片付ける）
    pub fn toast_undo(&mut self, message: &str) {
        self.dismiss_undo_toasts();
        self.push_toast(message, None, ToastKind::Undo);
    }

    pub fn dismiss_undo_toasts(&mut self) {
        self.toasts.retain(|toast| toast.kind != ToastKind::Undo);
    }

    // --- 通信の結果と知らせ -------------------------------------------------------------

    pub fn on_net(&mut self, event: NetEvent) {
        match event {
            NetEvent::MutateDone { batch_id, result } => {
                self.store.on_mutate_done(&batch_id, result);
            }
            NetEvent::SyncDone(result) => self.store.on_sync_done(result),
        }
        self.handle_notices();
        self.reconcile();
    }

    /// ストアの知らせを、トーストや下書きに直す
    pub fn handle_notices(&mut self) {
        for notice in self.store.take_notices() {
            match notice {
                Notice::OfflineBlocked { autosave } => {
                    if !autosave {
                        self.toast_error("オフラインのため、操作できません", None);
                    }
                }
                Notice::SaveFailed {
                    reason,
                    discarded,
                    failed_creates,
                    undo_conflict,
                } => {
                    self.restore_drafts(failed_creates.iter().map(|create| create.title.clone()));
                    for batch in &discarded {
                        self.keep_discarded_text(&batch.mutations);
                    }
                    self.dismiss_undo_toasts();
                    let message = match (reason, undo_conflict) {
                        (_, true) => "ほかの画面で先に変更されていたため、元に戻せませんでした",
                        (SaveFailure::Conflict, _) => {
                            "ほかの画面で先に変更されていたため、保存できませんでした"
                        }
                        _ => "保存できませんでした",
                    };
                    let detail = (!failed_creates.is_empty())
                        .then_some("追加した文字は、追加欄（n）に戻してあります");
                    self.toast_error(message, detail);
                }
                Notice::Unauthorized { failed_creates }
                | Notice::VersionMismatch { failed_creates } => {
                    self.restore_drafts(failed_creates.iter().map(|create| create.title.clone()));
                }
            }
        }
    }

    /// 保存できなかった追加の文字を、追加欄の下書きに戻す（空なら1つ目を入れ、残りは順に）
    fn restore_drafts(&mut self, titles: impl Iterator<Item = String>) {
        self.draft_queue
            .extend(titles.filter(|title| !title.trim().is_empty()));
        self.fill_draft_from_queue();
    }

    pub fn fill_draft_from_queue(&mut self) {
        if self.add_draft.trim().is_empty()
            && let Some(next) = self.draft_queue.pop_front()
        {
            self.add_draft = next.clone();
            if let Some(input) = &mut self.adding {
                input.set(&next);
            }
        }
    }

    /// 捨てられた操作のタイトルとメモを覚えておく（次にその欄を開いたら戻す）
    fn keep_discarded_text(&mut self, mutations: &[Mutation]) {
        for mutation in mutations {
            if let Mutation::TaskUpdate { id, changes, .. } = mutation {
                if let Some(title) = &changes.title {
                    self.unsaved_text
                        .insert((id.clone(), TextField::Title), title.clone());
                }
                if let Some(memo) = &changes.memo {
                    self.unsaved_text
                        .insert((id.clone(), TextField::Memo), memo.clone());
                }
            }
        }
    }

    /// 時間で進むこと：トーストを片付ける、午前4時を確かめる、差分を取りに行く
    pub fn tick(&mut self) {
        let now = Instant::now();
        self.toasts.retain(|toast| toast.until > now);
        if self.login.is_some() {
            return;
        }
        if self.store.refresh_day() {
            self.last_sync = now;
            // 選んでいる日が「今日」だったカレンダーは、新しい今日に合わせない（見ていた日をそのまま）
        }
        let interval = if self.store.is_online {
            SYNC_INTERVAL
        } else {
            OFFLINE_RETRY_INTERVAL
        };
        if now.duration_since(self.last_sync) >= interval {
            self.sync_now();
        }
        self.handle_notices();
    }

    pub fn sync_now(&mut self) {
        self.last_sync = Instant::now();
        self.store.sync();
    }

    /// 端末にフォーカスが戻ったとき
    pub fn on_focus_gained(&mut self) {
        if self.login.is_none() && !self.store.refresh_day() {
            self.sync_now();
        }
    }

    // --- カレンダーとタイムラインの選択 -------------------------------------------------

    /// カレンダーで選んでいるもの（◆かタスク）
    pub fn calendar_entry(&self) -> Option<super::views::CalendarEntry> {
        let entries = super::views::calendar_entries(&self.store, &self.calendar.filter);
        let day = entries.get(&self.calendar.day)?;
        day.get(self.calendar.entry.min(day.len().saturating_sub(1)))
            .cloned()
    }

    /// タイムラインの選択が消えていたら、近い行を選び直す
    pub fn ensure_timeline_cursor(&mut self) {
        let rows: Vec<String> = super::views::timeline_groups(&self.store, &self.timeline.filter)
            .into_iter()
            .flat_map(|group| group.items.into_iter().map(|item| item.task_id))
            .collect();
        let keep = self
            .timeline
            .cursor
            .as_ref()
            .is_some_and(|cursor| rows.contains(cursor));
        if !keep {
            self.timeline.cursor = rows.first().cloned();
        }
    }

    /// カレンダーの選んでいる日を動かす
    pub fn move_calendar_day(&mut self, days: i64) {
        self.calendar.day = add_days(&self.calendar.day, days);
        self.calendar.entry = 0;
    }
}
