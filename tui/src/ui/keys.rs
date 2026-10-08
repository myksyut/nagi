//! キーの割り当ての一覧（キーマップ）。コマンドの一覧（Ctrl+K）とショートカットのページ（?）は、この一覧から作る。
//! 1つのキーは、同じ場面では1つの割り当てだけが動く（上から順に、今使える最初の割り当て）。
//! 入力欄や候補の中のキーは、それぞれの部品（input.rs）が直接扱う

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::app::{
    App, DateKind, Detail, DetailField, Focus, Overlay, QuickTarget, Screen, ValueKind,
};
use super::text::TextInput;
use super::views::calendar_entries;
use crate::data::Destination;
use crate::data::sort::TaskSort;
use crate::dates::{add_days, add_months, month_start};
use crate::model::PROJECT_COLORS;

/// ショートカットのページとコマンドの一覧でのまとまり
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Group {
    Task,
    When,
    Move,
    List,
    Global,
}

impl Group {
    /// ページと一覧に並べるまとまりの順
    pub const ORDER: [Group; 5] = [
        Group::Task,
        Group::When,
        Group::Move,
        Group::List,
        Group::Global,
    ];

    pub fn label(self) -> &'static str {
        match self {
            Group::Task => "タスク",
            Group::When => "いつやる",
            Group::Move => "移動",
            Group::List => "リスト",
            Group::Global => "全体",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Down,
    Up,
    ExtendDown,
    ExtendUp,
    Top,
    Bottom,
    ReorderUp,
    ReorderDown,
    Add,
    Open,
    Close,
    Complete,
    Start,
    ToToday,
    ToLater,
    Schedule,
    Deadline,
    Project,
    Priority,
    Points,
    Delete,
    Copy,
    Undo,
    Go(Screen),
    ToggleBoard,
    ColumnLeft,
    ColumnRight,
    SortMenu,
    Sort(TaskSort),
    ToggleFold,
    Palette,
    Shortcuts,
    ShortcutsBack,
    CreateProject,
    RenameProject,
    ArchiveProject,
    ProjectColor,
    PreviousPeriod,
    NextPeriod,
    CalendarDay(i64),
    CalendarEntry(i32),
    CalendarToday,
    TimelineMove(i32),
    ShiftDates(i64),
    Filter,
    FocusSidebar,
    ToggleSidebar,
    Sync,
    Login,
    Logout,
    Quit,
}

pub struct Binding {
    /// コマンドの一覧・ショートカットのページに出す名前
    pub label: String,
    pub group: Group,
    /// 割り当てるキー。先頭が一覧に出す代表のキー。空なら、コマンドの一覧からだけ実行する
    pub keys: &'static [&'static str],
    /// 決まった画面だけで効くキーの、効く画面の名前
    pub place: Option<&'static str>,
    pub action: Action,
}

fn binding(label: &str, group: Group, keys: &'static [&'static str], action: Action) -> Binding {
    Binding {
        label: label.to_string(),
        group,
        keys,
        place: None,
        action,
    }
}

fn at(place: &'static str, binding: Binding) -> Binding {
    Binding {
        place: Some(place),
        ..binding
    }
}

/// すべての割り当て（上から順に、今使える最初のものが動く）
pub fn bindings() -> Vec<Binding> {
    use Action as A;
    use Group as G;
    let mut list = vec![
        binding("下へ", G::Move, &["Down", "j"], A::Down),
        binding("上へ", G::Move, &["Up", "k"], A::Up),
        binding(
            "選択を下へ広げる",
            G::Move,
            &["Shift+Down", "J"],
            A::ExtendDown,
        ),
        binding("選択を上へ広げる", G::Move, &["Shift+Up", "K"], A::ExtendUp),
        binding("一番上へ", G::Move, &["g", "Home"], A::Top),
        binding("一番下へ", G::Move, &["G", "End"], A::Bottom),
        binding(
            "並べ替え（上へ）",
            G::Task,
            &["Alt+Up", "Ctrl+Up", "Alt+k"],
            A::ReorderUp,
        ),
        binding(
            "並べ替え（下へ）",
            G::Task,
            &["Alt+Down", "Ctrl+Down", "Alt+j"],
            A::ReorderDown,
        ),
        binding("追加", G::Task, &["n"], A::Add),
        binding("開く", G::Task, &["Enter"], A::Open),
        binding("閉じる", G::Task, &["Esc"], A::Close),
        binding(
            "完了（もう一度で戻す）",
            G::Task,
            &["x", "Space"],
            A::Complete,
        ),
        binding("進行中にする／未着手に戻す", G::Task, &["s"], A::Start),
        binding("今日へ", G::When, &["t"], A::ToToday),
        binding("あとでへ", G::When, &["l"], A::ToLater),
        binding("日付を決めて予定へ", G::When, &["d"], A::Schedule),
        binding("締切", G::When, &["D"], A::Deadline),
        binding("プロジェクト", G::Task, &["p"], A::Project),
        binding("優先度", G::Task, &["P"], A::Priority),
        binding("工数", G::Task, &["e"], A::Points),
        binding("削除", G::Task, &["Delete", "Alt+Backspace"], A::Delete),
        binding("タイトルとメモをコピー", G::Task, &["y", "c"], A::Copy),
        binding("元に戻す", G::Task, &["u", "Ctrl+z"], A::Undo),
        binding("受信箱を開く", G::List, &["1"], A::Go(Screen::Inbox)),
        binding("今日を開く", G::List, &["2"], A::Go(Screen::Today)),
        binding("予定を開く", G::List, &["3"], A::Go(Screen::Upcoming)),
        binding("あとでを開く", G::List, &["4"], A::Go(Screen::Later)),
        binding("完了ログを開く", G::List, &["5"], A::Go(Screen::Logbook)),
        binding("カレンダーを開く", G::List, &["6"], A::Go(Screen::Calendar)),
        binding(
            "タイムラインを開く",
            G::List,
            &["7"],
            A::Go(Screen::Timeline),
        ),
        at(
            "今日・プロジェクト",
            binding("リスト／ボードの切り替え", G::List, &["v"], A::ToggleBoard),
        ),
        at(
            "ボード",
            binding("左の列へ", G::Move, &["Left", "h"], A::ColumnLeft),
        ),
        at(
            "ボード",
            binding("右の列へ", G::Move, &["Right"], A::ColumnRight),
        ),
        at(
            "今日・あとで・プロジェクト",
            binding("並び方を選ぶ", G::List, &["o"], A::SortMenu),
        ),
        at(
            "今日・プロジェクト",
            binding("「完了 N件」を開く／閉じる", G::List, &["z"], A::ToggleFold),
        ),
        binding("プロジェクトを作成", G::List, &["N"], A::CreateProject),
        at(
            "プロジェクト",
            binding(
                "プロジェクトの名前を変更",
                G::List,
                &["R"],
                A::RenameProject,
            ),
        ),
        at(
            "プロジェクト",
            binding(
                "プロジェクトをアーカイブ（もう一度で解除）",
                G::List,
                &["A"],
                A::ArchiveProject,
            ),
        ),
        at(
            "プロジェクト",
            binding("プロジェクトの色", G::List, &["C"], A::ProjectColor),
        ),
        at(
            "カレンダー",
            binding("前の日へ", G::Move, &["Left", "h"], A::CalendarDay(-1)),
        ),
        at(
            "カレンダー",
            binding("次の日へ", G::Move, &["Right"], A::CalendarDay(1)),
        ),
        at(
            "カレンダー",
            binding("前の週へ", G::Move, &["Up"], A::CalendarDay(-7)),
        ),
        at(
            "カレンダー",
            binding("次の週へ", G::Move, &["Down"], A::CalendarDay(7)),
        ),
        at(
            "カレンダー",
            binding("その日の中で下へ", G::Move, &["j"], A::CalendarEntry(1)),
        ),
        at(
            "カレンダー",
            binding("その日の中で上へ", G::Move, &["k"], A::CalendarEntry(-1)),
        ),
        at(
            "カレンダー",
            binding("今日の日へ戻る", G::Move, &["."], A::CalendarToday),
        ),
        at(
            "タイムライン",
            binding("下のタスクへ", G::Move, &["Down", "j"], A::TimelineMove(1)),
        ),
        at(
            "タイムライン",
            binding("上のタスクへ", G::Move, &["Up", "k"], A::TimelineMove(-1)),
        ),
        at(
            "カレンダー・タイムライン",
            binding("前の月・前の週へ", G::Move, &["["], A::PreviousPeriod),
        ),
        at(
            "カレンダー・タイムライン",
            binding("次の月・次の週へ", G::Move, &["]"], A::NextPeriod),
        ),
        at(
            "カレンダー・タイムライン",
            binding("1日前へずらす", G::When, &["<", ","], A::ShiftDates(-1)),
        ),
        at(
            "カレンダー・タイムライン",
            binding("1日後へずらす", G::When, &[">"], A::ShiftDates(1)),
        ),
        at(
            "カレンダー・タイムライン",
            binding("プロジェクトで絞り込む", G::List, &["f"], A::Filter),
        ),
        binding("サイドバーへ移る", G::Move, &["Tab"], A::FocusSidebar),
        binding(
            "サイドバーを畳む・広げる",
            G::Global,
            &["\\"],
            A::ToggleSidebar,
        ),
        binding(
            "検索とコマンド",
            G::Global,
            &["Ctrl+k", ":", "/"],
            A::Palette,
        ),
        at(
            "ショートカット",
            binding(
                "ショートカットを閉じる",
                G::Global,
                &["?", "Esc"],
                A::ShortcutsBack,
            ),
        ),
        binding("ショートカットの一覧", G::Global, &["?"], A::Shortcuts),
        binding("今すぐ同期", G::Global, &["Ctrl+r"], A::Sync),
        binding(
            "クラウドと同期する（ログイン。いまは招待制）",
            G::Global,
            &[],
            A::Login,
        ),
        binding("ログアウト", G::Global, &[], A::Logout),
        binding("終了", G::Global, &["q", "Ctrl+c"], A::Quit),
    ];
    for sort in TaskSort::ALL {
        list.push(at(
            "今日・あとで・プロジェクト",
            Binding {
                label: format!("並び方：{}", sort.label()),
                group: G::List,
                keys: &[],
                place: None,
                action: A::Sort(sort),
            },
        ));
    }
    list
}

/// 候補や欄の中の1つの操作の説明（名前とキー）
pub type FieldKey = (&'static str, &'static [&'static str]);

/// 候補や欄の中のキー（部品が直接扱うキー）の説明。場面の名前ごとに、ショートカットのページに並べる
pub fn field_keys() -> Vec<(&'static str, Vec<FieldKey>)> {
    vec![
        (
            "追加欄",
            vec![("追加して続ける", &["Enter"][..]), ("閉じる", &["Esc"])],
        ),
        (
            "開いたタスク",
            vec![
                ("欄を移る", &["Up", "Down", "Tab"][..]),
                ("欄を直す・押す", &["Enter"]),
                ("直した文字を保存して欄を出る（メモ）", &["Esc", "Ctrl+s"]),
                ("閉じる", &["Esc"]),
            ],
        ),
        (
            "チェックリスト",
            vec![
                ("チェックを付ける・外す", &["Space", "x"][..]),
                ("名前を直す", &["Enter"]),
                ("項目を消す", &["Delete", "Backspace"]),
                ("項目を上・下へ", &["Alt+Up", "Alt+Down"]),
            ],
        ),
        (
            "日付の入力（d・D）",
            vec![
                ("決める", &["Enter"][..]),
                ("締切を外す（空のまま）", &["Enter"]),
                ("やめる", &["Esc"]),
            ],
        ),
        (
            "p の候補",
            vec![
                ("候補を選ぶ", &["Up", "Down"][..]),
                ("決める（「◯◯」を作成も）", &["Enter"]),
                ("やめる", &["Esc"]),
            ],
        ),
        (
            "優先度・工数の候補",
            vec![
                ("候補を選ぶ", &["Up", "Down"][..]),
                (
                    "その場で決める（優先度：1 高・2 中・3 低・0 なし）",
                    &["1", "2", "3", "0"],
                ),
                ("決める", &["Enter"]),
                ("やめる", &["Esc"]),
            ],
        ),
        (
            "並び方の一覧",
            vec![
                (
                    "その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）",
                    &["1", "2", "3", "4"][..],
                ),
                ("決める", &["Enter"]),
            ],
        ),
        (
            "小さな追加欄（カレンダー・タイムライン）",
            vec![
                ("追加して続ける", &["Enter"][..]),
                ("行き先を切り替える", &["Tab"]),
                ("閉じる", &["Esc"]),
            ],
        ),
        (
            "検索とコマンド",
            vec![
                ("候補を選ぶ", &["Up", "Down"][..]),
                ("実行する・開く", &["Enter"]),
                ("閉じる", &["Esc"]),
            ],
        ),
        (
            "サイドバー",
            vec![
                ("リストを選ぶ", &["Up", "Down"][..]),
                ("一覧へ戻る", &["Enter", "Tab", "Esc"]),
            ],
        ),
    ]
}

/// キーの書き方（"Shift+Down"・"Ctrl+k"・"D" など）に、押されたキーが合うか
pub fn matches(spec: &str, key: &KeyEvent) -> bool {
    let (mut ctrl, mut alt, mut shift) = (false, false, false);
    let mut name = spec;
    loop {
        if let Some(rest) = name.strip_prefix("Ctrl+") {
            ctrl = true;
            name = rest;
        } else if let Some(rest) = name.strip_prefix("Alt+") {
            alt = true;
            name = rest;
        } else if let Some(rest) = name.strip_prefix("Shift+") {
            shift = true;
            name = rest;
        } else {
            break;
        }
    }
    let mods = key.modifiers;
    if mods.contains(KeyModifiers::CONTROL) != ctrl || mods.contains(KeyModifiers::ALT) != alt {
        return false;
    }
    let shifted = mods.contains(KeyModifiers::SHIFT);
    let named = |code: KeyCode| key.code == code && shifted == shift;
    match name {
        "Up" => named(KeyCode::Up),
        "Down" => named(KeyCode::Down),
        "Left" => named(KeyCode::Left),
        "Right" => named(KeyCode::Right),
        "Enter" => named(KeyCode::Enter),
        "Esc" => named(KeyCode::Esc),
        "Tab" => named(KeyCode::Tab),
        "Backspace" => named(KeyCode::Backspace),
        "Delete" => named(KeyCode::Delete),
        "Home" => named(KeyCode::Home),
        "End" => named(KeyCode::End),
        "Space" => key.code == KeyCode::Char(' '),
        _ => {
            let mut chars = name.chars();
            let (Some(expected), None) = (chars.next(), chars.next()) else {
                return false;
            };
            match key.code {
                // 文字のキーは、文字そのもので比べる（⇧ は大文字として届く。小文字のまま ⇧ 付きで届く端末にも合わせる）
                KeyCode::Char(c) if shifted && c.is_ascii_lowercase() => {
                    c.to_ascii_uppercase() == expected
                }
                KeyCode::Char(c) => c == expected,
                _ => false,
            }
        }
    }
}

/// キーの表示（"Shift+Down" → "⇧↓"、"D" → "⇧D"、"Ctrl+k" → "Ctrl+K"）
pub fn key_label(spec: &str) -> String {
    let mut out = String::new();
    let mut name = spec;
    loop {
        if let Some(rest) = name.strip_prefix("Ctrl+") {
            out.push_str("Ctrl+");
            name = rest;
        } else if let Some(rest) = name.strip_prefix("Alt+") {
            out.push_str("Alt+");
            name = rest;
        } else if let Some(rest) = name.strip_prefix("Shift+") {
            out.push('⇧');
            name = rest;
        } else {
            break;
        }
    }
    out.push_str(&match name {
        "Up" => "↑".to_string(),
        "Down" => "↓".to_string(),
        "Left" => "←".to_string(),
        "Right" => "→".to_string(),
        "Delete" => "Del".to_string(),
        "Backspace" => "⌫".to_string(),
        _ if name.chars().count() == 1 => {
            let c = name.chars().next().unwrap_or(' ');
            if c.is_ascii_uppercase() {
                format!("⇧{c}")
            } else if spec.contains('+') {
                c.to_ascii_uppercase().to_string()
            } else {
                c.to_string()
            }
        }
        other => other.to_string(),
    });
    out
}

impl App {
    fn has_rows(&self) -> bool {
        self.view()
            .is_some_and(|view| !view.rows(&self.list).is_empty())
    }

    fn live_project_screen(&self) -> Option<String> {
        match &self.screen {
            Screen::Project(id) if self.project_name(id).is_some() => Some(id.clone()),
            _ => None,
        }
    }

    /// その割り当てを今使えるか。キーでもコマンドの一覧でも同じ決まりで判断する
    pub fn can_run(&self, action: &Action) -> bool {
        use Action as A;
        let is_list = self.view().is_some();
        match action {
            A::Down | A::Up | A::ExtendDown | A::ExtendUp | A::Top | A::Bottom => self.has_rows(),
            A::ReorderUp | A::ReorderDown => {
                self.detail.is_none()
                    && self.view().is_some_and(|view| {
                        view.reorderable_section_of(&self.list.selected_rows(&view))
                            .is_some()
                    })
            }
            A::Add => is_list || matches!(self.screen, Screen::Calendar | Screen::Timeline),
            A::Open => self.detail.is_none() && !self.targets().is_empty(),
            A::Close => self.detail.is_some() || (is_list && self.list.cursor.is_some()),
            A::Complete | A::Project | A::Priority | A::Points | A::Delete | A::Copy => {
                !self.targets().is_empty()
            }
            A::Start => {
                !self.open_targets().is_empty() || (self.is_board() && !self.targets().is_empty())
            }
            A::ToToday | A::ToLater | A::Schedule | A::Deadline => !self.open_targets().is_empty(),
            A::Undo => self.store.can_undo(),
            A::ToggleBoard => self.screen.has_board(),
            A::ColumnLeft | A::ColumnRight => self.is_board() && self.detail.is_none(),
            A::SortMenu | A::Sort(_) => self.screen.has_sort(),
            A::ToggleFold => self.view().is_some_and(|view| {
                view.sections
                    .iter()
                    .any(|section| section.fold.is_some() && !section.rows.is_empty())
            }),
            A::RenameProject | A::ArchiveProject | A::ProjectColor => {
                self.live_project_screen().is_some()
            }
            A::PreviousPeriod | A::NextPeriod | A::Filter => {
                matches!(self.screen, Screen::Calendar | Screen::Timeline)
            }
            A::CalendarDay(_) | A::CalendarEntry(_) | A::CalendarToday => {
                self.screen == Screen::Calendar && self.detail.is_none()
            }
            A::TimelineMove(_) => self.screen == Screen::Timeline && self.detail.is_none(),
            A::ShiftDates(_) => {
                matches!(self.screen, Screen::Calendar | Screen::Timeline)
                    && !self.open_targets().is_empty()
            }
            A::ShortcutsBack => self.screen == Screen::Shortcuts,
            A::Shortcuts => self.screen != Screen::Shortcuts,
            A::Go(_)
            | A::Palette
            | A::CreateProject
            | A::FocusSidebar
            | A::ToggleSidebar
            | A::Sync
            | A::Quit => true,
            // この端末だけで使っているときはログイン、Worker と同期しているときはログアウト
            A::Login => !self.config.is_cloud(),
            A::Logout => self.config.is_cloud(),
        }
    }

    /// 通常の場面（入力欄や候補が開いていないとき）のキー。割り当てがあれば実行して true
    pub fn handle_binding_key(&mut self, key: &KeyEvent) -> bool {
        let action = bindings().into_iter().find_map(|binding| {
            (binding.keys.iter().any(|spec| matches(spec, key)) && self.can_run(&binding.action))
                .then_some(binding.action)
        });
        match action {
            Some(action) => {
                self.run_action(action);
                true
            }
            None => false,
        }
    }

    pub fn run_action(&mut self, action: Action) {
        use Action as A;
        if !self.can_run(&action) {
            return;
        }
        match action {
            A::Down | A::Up => {
                let delta = if action == A::Down { 1 } else { -1 };
                if let Some(view) = self.view()
                    && !self.list.move_selection(&view, delta)
                    && delta > 0
                    && self.screen == Screen::Logbook
                {
                    // 完了ログの一番下で ↓：続きを読み込む
                    self.load_more_logbook();
                }
            }
            A::ExtendDown | A::ExtendUp => {
                if let Some(view) = self.view() {
                    let delta = if action == A::ExtendDown { 1 } else { -1 };
                    self.list.extend_selection(&view, delta);
                }
            }
            A::Top | A::Bottom => {
                if let Some(view) = self.view() {
                    self.list.move_to_edge(&view, action == A::Bottom);
                }
            }
            A::ReorderUp => self.move_selected_rows(-1),
            A::ReorderDown => self.move_selected_rows(1),
            A::Add => self.start_adding(),
            A::Open => {
                if let Some(id) = self.targets().first().cloned() {
                    self.open_detail(&id);
                }
            }
            A::Close => {
                if self.detail.is_some() {
                    self.close_detail();
                } else {
                    self.list.select(None);
                }
            }
            A::Complete => {
                let ids = self.targets();
                self.toggle_complete(&ids);
            }
            A::Start => {
                let ids = self.targets();
                self.toggle_started(&ids);
            }
            A::ToToday => {
                let ids = self.open_targets();
                self.move_tasks(&ids, Destination::Today);
            }
            A::ToLater => {
                let ids = self.open_targets();
                self.move_tasks(&ids, Destination::Later);
            }
            A::Schedule | A::Deadline => {
                let kind = if action == A::Schedule {
                    DateKind::Schedule
                } else {
                    DateKind::Deadline
                };
                // カレンダーの◆は、d でも締切を変える
                let kind = match self.calendar_target_is_deadline() {
                    true => DateKind::Deadline,
                    false => kind,
                };
                self.overlay = Some(Overlay::Date {
                    kind,
                    ids: self.open_targets(),
                    input: TextInput::default(),
                });
            }
            A::Project => {
                self.overlay = Some(Overlay::Project {
                    ids: self.targets(),
                    input: TextInput::default(),
                    index: 0,
                });
            }
            A::Priority | A::Points => {
                let kind = if action == A::Priority {
                    ValueKind::Priority
                } else {
                    ValueKind::Points
                };
                let ids = self.targets();
                let index = self.value_index(kind, &ids);
                self.overlay = Some(Overlay::Value { kind, ids, index });
            }
            A::Delete => {
                let ids = self.targets();
                self.delete_tasks(&ids);
            }
            A::Copy => {
                let ids = self.targets();
                self.copy_tasks(&ids);
            }
            A::Undo => self.undo(),
            A::Go(screen) => {
                self.navigate(screen);
                self.focus = Focus::Main;
            }
            A::ToggleBoard => self.toggle_board(),
            A::ColumnLeft | A::ColumnRight => {
                if let Some(view) = self.view() {
                    let delta = if action == A::ColumnRight { 1 } else { -1 };
                    self.list.move_column(&view, delta);
                }
            }
            A::SortMenu => {
                let index = TaskSort::ALL
                    .iter()
                    .position(|sort| *sort == self.sort())
                    .unwrap_or(0);
                self.overlay = Some(Overlay::Sort { index });
            }
            A::Sort(sort) => self.set_sort(sort),
            A::ToggleFold => {
                if let Some(view) = self.view() {
                    let folds: Vec<String> = view
                        .sections
                        .iter()
                        .filter(|section| section.fold.is_some())
                        .map(|section| section.key.clone())
                        .collect();
                    for key in folds {
                        self.list.toggle_fold(&view, &key);
                    }
                    self.reconcile();
                }
            }
            A::Palette => {
                self.overlay = Some(Overlay::Palette {
                    input: TextInput::default(),
                    index: 0,
                });
            }
            A::Shortcuts => self.navigate(Screen::Shortcuts),
            A::ShortcutsBack => {
                // 絞り込みの文字があれば消し、空なら戻る
                if !self.shortcuts_filter.is_empty() {
                    self.shortcuts_filter.clear();
                } else {
                    let back = self.previous_screen.clone();
                    self.navigate(back);
                }
            }
            A::CreateProject => {
                self.overlay = Some(Overlay::Name {
                    input: TextInput::default(),
                    rename: None,
                });
            }
            A::RenameProject => {
                if let Some(id) = self.live_project_screen() {
                    let name = self.project_name(&id).unwrap_or_default().to_string();
                    self.overlay = Some(Overlay::Name {
                        input: TextInput::new(&name),
                        rename: Some(id),
                    });
                }
            }
            A::ArchiveProject => {
                if let Some(id) = self.live_project_screen() {
                    let archived = self
                        .store
                        .replica
                        .project(&id)
                        .is_some_and(|project| project.archived_at.is_some());
                    if archived {
                        self.unarchive_project(&id);
                    } else {
                        self.archive_project(&id);
                    }
                }
            }
            A::ProjectColor => {
                if let Some(id) = self.live_project_screen() {
                    let current = self.store.lists().project_color(&id);
                    let index = PROJECT_COLORS
                        .iter()
                        .position(|color| Some(*color) == current)
                        .unwrap_or(0);
                    self.overlay = Some(Overlay::Color {
                        project_id: id,
                        index,
                    });
                }
            }
            A::PreviousPeriod | A::NextPeriod => {
                let delta: i64 = if action == A::NextPeriod { 1 } else { -1 };
                if self.screen == Screen::Calendar {
                    // 前の月・次の月の1日へ
                    self.calendar.day = add_months(&month_start(&self.calendar.day), delta as i32);
                    self.calendar.entry = 0;
                } else {
                    self.timeline.scroll += delta * 7;
                }
            }
            A::CalendarDay(days) => self.move_calendar_day(days),
            A::CalendarEntry(delta) => {
                let count = calendar_entries(&self.store, &self.calendar.filter)
                    .get(&self.calendar.day)
                    .map_or(0, Vec::len);
                if count > 0 {
                    let next = self.calendar.entry as i64 + i64::from(delta);
                    self.calendar.entry = next.clamp(0, count as i64 - 1) as usize;
                }
            }
            A::CalendarToday => {
                self.calendar.day = self.store.today.clone();
                self.calendar.entry = 0;
            }
            A::TimelineMove(delta) => self.move_timeline_cursor(delta),
            A::ShiftDates(days) => self.shift_selected(days),
            A::Filter => self.overlay = Some(Overlay::Filter { index: 0 }),
            A::FocusSidebar => {
                self.close_detail();
                self.sidebar_index = self.sidebar_position();
                self.focus = Focus::Sidebar;
            }
            A::ToggleSidebar => {
                // その端末に覚える
                self.prefs.sidebar_rail = !self.prefs.sidebar_rail;
                self.config.save_prefs(&self.prefs);
            }
            A::Sync => {
                self.sync_now();
                self.toast_info("同期しています");
            }
            A::Login => self.show_login(None),
            A::Logout => self.logout(),
            A::Quit => self.should_quit = true,
        }
    }

    /// カレンダーで◆を選んでいるか
    fn calendar_target_is_deadline(&self) -> bool {
        self.screen == Screen::Calendar
            && self.detail.is_none()
            && self.calendar_entry().is_some_and(|entry| entry.deadline)
    }

    /// 1日ずらす。カレンダーでは、タスクなら予定の日付を、◆なら締切を動かす。
    /// タイムラインでは、やる日と締切を同じ日数ずらす
    fn shift_selected(&mut self, days: i64) {
        if self.screen == Screen::Timeline {
            let ids = self.open_targets();
            self.shift_dates(&ids, days);
            return;
        }
        let Some(entry) = self.calendar_entry() else {
            return;
        };
        let to = add_days(&self.calendar.day, days);
        let ids = vec![entry.task_id.clone()];
        if entry.deadline {
            self.set_deadline(&ids, Some(&to));
        } else {
            self.schedule_tasks(&ids, &to);
        }
        // 動かした先の日へ、選んでいる日も付いていく（今日以前へ動かしたタスクは今日に入る）
        let landed = calendar_entries(&self.store, &self.calendar.filter)
            .into_iter()
            .find_map(|(day, entries)| {
                let position = entries.iter().position(|other| *other == entry)?;
                Some((day, position))
            });
        if let Some((day, position)) = landed {
            self.calendar.day = day;
            self.calendar.entry = position;
        }
    }

    fn move_timeline_cursor(&mut self, delta: i32) {
        let rows: Vec<String> = super::views::timeline_groups(&self.store, &self.timeline.filter)
            .into_iter()
            .flat_map(|group| group.items.into_iter().map(|item| item.task_id))
            .collect();
        if rows.is_empty() {
            self.timeline.cursor = None;
            return;
        }
        let index = self
            .timeline
            .cursor
            .as_ref()
            .and_then(|cursor| rows.iter().position(|id| id == cursor));
        let next = match index {
            None => 0,
            Some(index) => {
                (index as i64 + i64::from(delta)).clamp(0, rows.len() as i64 - 1) as usize
            }
        };
        self.timeline.cursor = Some(rows[next].clone());
    }

    /// 優先度・工数の候補で、最初に選んでおく位置（対象の今の値）
    fn value_index(&self, kind: ValueKind, ids: &[String]) -> usize {
        let Some(task) = ids.first().and_then(|id| self.task(id)) else {
            return 0;
        };
        match kind {
            ValueKind::Priority => task
                .priority
                .map_or(crate::model::Priority::ALL.len(), |priority| {
                    priority.order()
                }),
            ValueKind::Points => task
                .points
                .and_then(|points| crate::model::POINTS.iter().position(|p| *p == points))
                .unwrap_or(crate::model::POINTS.len()),
        }
    }

    pub fn toggle_board(&mut self) {
        let Some(key) = self.screen.view_key() else {
            return;
        };
        self.close_detail();
        self.stop_adding();
        let cursor = self.list.cursor.clone();
        if !self.prefs.board.remove(&key) {
            self.prefs.board.insert(key);
        }
        self.config.save_prefs(&self.prefs);
        self.scroll = 0;
        // 選んでいた行が切り替えた先にも見えていれば、そのまま選んでおく
        if let Some(view) = self.view() {
            let keep = cursor.filter(|id| view.rows(&self.list).contains(&id.as_str()));
            self.list.select(keep.as_deref());
        }
    }

    pub fn set_sort(&mut self, sort: TaskSort) {
        let Some(key) = self.screen.view_key() else {
            return;
        };
        if sort == TaskSort::Manual {
            self.prefs.sort.remove(&key);
        } else {
            self.prefs.sort.insert(key, sort.key().to_string());
        }
        self.config.save_prefs(&self.prefs);
    }

    fn load_more_logbook(&mut self) {
        let total: usize = self
            .store
            .lists()
            .logbook
            .iter()
            .map(|day| day.tasks.len())
            .sum();
        if self.logbook_limit < total {
            self.logbook_limit += super::app::LOGBOOK_PAGE_SIZE;
            if let Some(view) = self.view() {
                self.list.move_selection(&view, 1);
            }
        }
    }

    // --- 追加欄と、開いたタスク ---------------------------------------------------------

    /// n：一覧では追加欄、カレンダーとタイムラインでは小さな追加欄を開く
    pub fn start_adding(&mut self) {
        self.close_detail();
        match self.screen {
            Screen::Calendar => {
                self.overlay = Some(Overlay::QuickAdd {
                    input: TextInput::new(&self.add_draft),
                    targets: vec![
                        QuickTarget::Date(self.calendar.day.clone()),
                        QuickTarget::Inbox,
                        QuickTarget::Today,
                    ],
                    index: 0,
                });
            }
            Screen::Timeline => {
                self.overlay = Some(Overlay::QuickAdd {
                    input: TextInput::new(&self.add_draft),
                    targets: vec![QuickTarget::Inbox, QuickTarget::Today],
                    index: 0,
                });
            }
            _ => {
                if self.view().is_some() {
                    self.fill_draft_from_queue();
                    self.adding = Some(TextInput::new(&self.add_draft));
                    self.last_added = None;
                }
            }
        }
    }

    /// 追加欄を閉じる。追加したタスクがあれば、最後に追加したものを選ぶ。打った文字は下書きに残る
    pub fn stop_adding(&mut self) {
        let Some(input) = self.adding.take() else {
            return;
        };
        self.add_draft = input.text();
        if let (Some(last), Some(view)) = (self.last_added.take(), self.view())
            && view.rows(&self.list).contains(&last.as_str())
        {
            self.list.select(Some(&last));
        }
    }

    pub fn open_detail(&mut self, task_id: &str) {
        if self.task(task_id).is_none() {
            return;
        }
        self.stop_adding();
        if self.view().is_some() {
            self.list.select(Some(task_id));
        }
        self.detail = Some(Detail {
            task_id: task_id.to_string(),
            field: DetailField::Title,
            edit: None,
        });
    }

    /// 開いているタスクを閉じる。直している途中の文字は保存する
    pub fn close_detail(&mut self) {
        if self.detail.is_some() {
            self.commit_detail_edit();
            self.detail = None;
        }
    }
}
