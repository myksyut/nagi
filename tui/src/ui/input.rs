//! キーの入口。入力欄や候補が開いているあいだは、それぞれがキーを受ける。どれも開いていなければ、
//! キーの割り当ての一覧（keys.rs）から動かす

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use super::app::{
    App, DateKind, Detail, DetailEdit, DetailField, Focus, Overlay, QuickTarget, Screen, TextField,
    ValueKind,
};
use super::keys::{Action, Group, bindings, key_label};
use super::text::{InputOutcome, TextArea, TextInput, fold, matches_query};
use super::views::ProjectFilter;
use crate::data::sort::TaskSort;
use crate::data::{Destination, PerformOptions};
use crate::dates::parse_date_input;
use crate::model::{Bucket, ChecklistItem, POINTS, PROJECT_COLORS, Priority, Task, TaskChanges};

/// 検索で出すタスクの上限
const TASK_RESULT_LIMIT: usize = 30;

/// 検索とコマンドの1行
pub enum PaletteItem {
    Command {
        action: Action,
        label: String,
        key: Option<String>,
        group: &'static str,
    },
    Project {
        id: String,
        name: String,
    },
    Task {
        id: String,
        title: String,
        location: String,
    },
}

/// p の候補の1行
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectChoice {
    /// プロジェクトを外す
    None,
    Existing(String),
    /// 「◯◯」を作成
    Create(String),
}

/// 自動保存（タイトル・メモ・チェックリストの項目の名前）。元に戻すの対象にしない
const AUTOSAVE: PerformOptions = PerformOptions {
    not_undoable: true,
    autosave: true,
};

fn is_ctrl(key: &KeyEvent, c: char) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char(c)
}

/// 全角の数字も読む（候補の中の、その場で決めるキー）
fn digit_of(key: &KeyEvent) -> Option<u32> {
    if key
        .modifiers
        .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
    {
        return None;
    }
    match key.code {
        KeyCode::Char(c) => fold(&c.to_string()).chars().next()?.to_digit(10),
        _ => None,
    }
}

/// 候補の選択を上下に動かす（端で止まる）
fn step(index: usize, len: usize, key: &KeyEvent) -> Option<usize> {
    let down = matches!(key.code, KeyCode::Down | KeyCode::Tab) || is_ctrl(key, 'n');
    let up = matches!(key.code, KeyCode::Up | KeyCode::BackTab) || is_ctrl(key, 'p');
    if len == 0 || !(down || up) {
        return None;
    }
    Some(if down {
        (index + 1).min(len - 1)
    } else {
        index.saturating_sub(1)
    })
}

impl App {
    pub fn handle_key(&mut self, key: KeyEvent) {
        if key.kind == KeyEventKind::Release {
            return;
        }
        // Ctrl+C はどこでも終了（入力欄の文字は、追加欄の下書きを除いて残らない）
        if is_ctrl(&key, 'c') {
            self.should_quit = true;
            return;
        }
        if self.login.is_some() {
            self.handle_login_key(&key);
        } else if self.overlay.is_some() {
            self.handle_overlay_key(key);
        } else if self.adding.is_some() {
            self.handle_adding_key(key);
        } else if self.detail.is_some() {
            if !self.handle_detail_key(key) {
                self.handle_binding_key(&key);
            }
        } else if self.focus == Focus::Sidebar {
            if !self.handle_sidebar_key(&key) {
                self.handle_binding_key(&key);
            }
        } else if self.screen == Screen::Shortcuts {
            self.handle_shortcuts_key(key);
        } else {
            self.handle_binding_key(&key);
        }
        self.handle_notices();
    }

    /// 貼り付け（日本語の入力が、まとめて届くこともある）。開いている入力欄に入れる
    pub fn handle_paste(&mut self, text: &str) {
        let single_line = text.replace(['\r', '\n'], " ");
        if let Some(overlay) = &mut self.overlay {
            match overlay {
                Overlay::Date { input, .. }
                | Overlay::Project { input, .. }
                | Overlay::Palette { input, .. }
                | Overlay::Name { input, .. }
                | Overlay::QuickAdd { input, .. } => input.insert_str(&single_line),
                _ => {}
            }
        } else if let Some(input) = &mut self.adding {
            input.insert_str(&single_line);
        } else if let Some(Detail {
            edit: Some(edit), ..
        }) = &mut self.detail
        {
            match edit {
                DetailEdit::Memo(area) => area.insert_str(text),
                DetailEdit::Title(input)
                | DetailEdit::Item(_, input)
                | DetailEdit::AddItem(input) => input.insert_str(&single_line),
            }
        } else if self.screen == Screen::Shortcuts {
            self.shortcuts_filter.insert_str(&single_line);
        }
    }

    // --- 追加欄 -------------------------------------------------------------------------

    fn handle_adding_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Enter => self.add_from_row(),
            KeyCode::Esc => self.stop_adding(),
            _ => {
                if let Some(input) = &mut self.adding {
                    input.handle_key(key);
                    self.add_draft = input.text();
                }
            }
        }
    }

    // --- サイドバー ---------------------------------------------------------------------

    /// サイドバーに並ぶ画面（上から）
    pub fn sidebar_entries(&self) -> Vec<Screen> {
        let mut entries = vec![
            Screen::Inbox,
            Screen::Today,
            Screen::Upcoming,
            Screen::Later,
            Screen::Calendar,
            Screen::Timeline,
        ];
        entries.extend(
            self.store
                .lists()
                .projects
                .iter()
                .map(|id| Screen::Project(id.clone())),
        );
        entries.push(Screen::Logbook);
        entries.push(Screen::Shortcuts);
        entries
    }

    /// 今の画面の、サイドバーでの位置
    pub fn sidebar_position(&self) -> usize {
        self.sidebar_entries()
            .iter()
            .position(|screen| *screen == self.screen)
            .unwrap_or(self.sidebar_index)
    }

    fn handle_sidebar_key(&mut self, key: &KeyEvent) -> bool {
        let entries = self.sidebar_entries();
        match key.code {
            KeyCode::Down | KeyCode::Char('j') | KeyCode::Up | KeyCode::Char('k') => {
                let down = matches!(key.code, KeyCode::Down | KeyCode::Char('j'));
                let index = if down {
                    (self.sidebar_index + 1).min(entries.len() - 1)
                } else {
                    self.sidebar_index.saturating_sub(1)
                };
                // 選んだ画面をすぐ開く
                self.navigate(entries[index].clone());
                self.sidebar_index = index;
                true
            }
            KeyCode::Enter | KeyCode::Tab | KeyCode::Esc | KeyCode::Right => {
                self.focus = Focus::Main;
                true
            }
            _ => {
                self.focus = Focus::Main;
                false
            }
        }
    }

    // --- ショートカットのページ ---------------------------------------------------------

    fn handle_shortcuts_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Down => self.shortcuts_scroll += 1,
            KeyCode::Up => self.shortcuts_scroll = self.shortcuts_scroll.saturating_sub(1),
            KeyCode::PageDown => self.shortcuts_scroll += 10,
            KeyCode::PageUp => self.shortcuts_scroll = self.shortcuts_scroll.saturating_sub(10),
            // ? と Esc は戻る（割り当ての一覧から）。それ以外の文字は絞り込みに入る
            KeyCode::Esc | KeyCode::Char('?') | KeyCode::Tab => {
                self.handle_binding_key(&key);
            }
            _ => {
                let typing = !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
                if typing && self.shortcuts_filter.handle_key(key) == InputOutcome::Changed {
                    self.shortcuts_scroll = 0;
                } else {
                    self.handle_binding_key(&key);
                }
            }
        }
    }

    // --- 開いたタスク -------------------------------------------------------------------

    /// 開いたタスクの欄（上から）
    pub fn detail_fields(task: &Task) -> Vec<DetailField> {
        let mut fields = vec![DetailField::Title, DetailField::Memo];
        fields.extend(
            task.checklist
                .iter()
                .map(|item| DetailField::Item(item.id.clone())),
        );
        fields.extend([
            DetailField::AddItem,
            DetailField::Status,
            DetailField::When,
            DetailField::Deadline,
            DetailField::Project,
            DetailField::Priority,
            DetailField::Points,
        ]);
        fields
    }

    fn detail_task(&self) -> Option<Task> {
        let detail = self.detail.as_ref()?;
        self.task(&detail.task_id).cloned()
    }

    fn set_detail_field(&mut self, field: DetailField) {
        if let Some(detail) = &mut self.detail {
            detail.field = field;
        }
    }

    fn move_detail_field(&mut self, delta: i32) {
        let Some(task) = self.detail_task() else {
            return;
        };
        let fields = Self::detail_fields(&task);
        let Some(detail) = &mut self.detail else {
            return;
        };
        let index = fields
            .iter()
            .position(|field| *field == detail.field)
            .unwrap_or(0) as i64;
        let next = (index + i64::from(delta)).clamp(0, fields.len() as i64 - 1) as usize;
        detail.field = fields[next].clone();
    }

    /// 開いたタスクのキー。扱ったら true（false なら、割り当ての一覧に回す）
    fn handle_detail_key(&mut self, key: KeyEvent) -> bool {
        if self
            .detail
            .as_ref()
            .is_some_and(|detail| detail.edit.is_some())
        {
            self.handle_detail_edit_key(key);
            return true;
        }
        let Some(task) = self.detail_task() else {
            self.detail = None;
            return true;
        };
        let field = self
            .detail
            .as_ref()
            .map(|detail| detail.field.clone())
            .unwrap_or(DetailField::Title);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let plain = !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        match (&field, key.code) {
            (DetailField::Item(item_id), KeyCode::Up | KeyCode::Down) if alt => {
                let delta = if key.code == KeyCode::Up { -1 } else { 1 };
                self.move_checklist_item(&task, item_id, delta);
            }
            (_, KeyCode::Down | KeyCode::Tab) if plain => self.move_detail_field(1),
            (_, KeyCode::Up | KeyCode::BackTab) => self.move_detail_field(-1),
            (_, KeyCode::Char('j')) if plain => self.move_detail_field(1),
            (_, KeyCode::Char('k')) if plain => self.move_detail_field(-1),
            (_, KeyCode::Esc) => self.close_detail(),
            (DetailField::Item(item_id), KeyCode::Char(' ' | 'x')) if plain => {
                let next: Vec<ChecklistItem> = task
                    .checklist
                    .iter()
                    .cloned()
                    .map(|mut item| {
                        if item.id == *item_id {
                            item.done = !item.done;
                        }
                        item
                    })
                    .collect();
                self.save_checklist(&task.id, next, PerformOptions::default());
            }
            (DetailField::Item(item_id), KeyCode::Delete | KeyCode::Backspace) if plain => {
                self.remove_checklist_item(&task, item_id);
            }
            (_, KeyCode::Enter) => self.activate_detail_field(&task, &field),
            _ => return false,
        }
        true
    }

    /// 欄で Enter：文字の欄は直し始め、ボタンは押す
    fn activate_detail_field(&mut self, task: &Task, field: &DetailField) {
        let unsaved = |app: &App, text_field: TextField, current: &str| {
            app.unsaved_text
                .get(&(task.id.clone(), text_field))
                .cloned()
                .unwrap_or_else(|| current.to_string())
        };
        let edit = match field {
            DetailField::Title => Some(DetailEdit::Title(TextInput::new(&unsaved(
                self,
                TextField::Title,
                &task.title,
            )))),
            DetailField::Memo => Some(DetailEdit::Memo(TextArea::new(&unsaved(
                self,
                TextField::Memo,
                &task.memo,
            )))),
            DetailField::Item(item_id) => task
                .checklist
                .iter()
                .find(|item| item.id == *item_id)
                .map(|item| DetailEdit::Item(item_id.clone(), TextInput::new(&item.title))),
            DetailField::AddItem => Some(DetailEdit::AddItem(TextInput::default())),
            DetailField::Status => {
                self.run_action(Action::Start);
                None
            }
            DetailField::When => {
                self.run_action(Action::Schedule);
                None
            }
            DetailField::Deadline => {
                self.run_action(Action::Deadline);
                None
            }
            DetailField::Project => {
                self.run_action(Action::Project);
                None
            }
            DetailField::Priority => {
                self.run_action(Action::Priority);
                None
            }
            DetailField::Points => {
                self.run_action(Action::Points);
                None
            }
        };
        if let (Some(edit), Some(detail)) = (edit, &mut self.detail) {
            detail.edit = Some(edit);
        }
    }

    fn handle_detail_edit_key(&mut self, key: KeyEvent) {
        let Some(Detail {
            edit: Some(edit), ..
        }) = &mut self.detail
        else {
            return;
        };
        match edit {
            DetailEdit::Memo(area) => {
                if key.code == KeyCode::Esc || is_ctrl(&key, 's') {
                    self.commit_detail_edit();
                } else {
                    area.handle_key(key);
                }
            }
            DetailEdit::Title(input) => match key.code {
                KeyCode::Enter | KeyCode::Esc => {
                    self.commit_detail_edit();
                }
                KeyCode::Tab | KeyCode::Down => {
                    if self.commit_detail_edit() {
                        self.move_detail_field(1);
                    }
                }
                _ => {
                    input.handle_key(key);
                }
            },
            DetailEdit::Item(..) => match key.code {
                KeyCode::Enter | KeyCode::Tab | KeyCode::Down => {
                    if self.commit_detail_edit() {
                        self.move_detail_field(1);
                    }
                }
                KeyCode::Esc => {
                    self.commit_detail_edit();
                }
                KeyCode::Up => {
                    if self.commit_detail_edit() {
                        self.move_detail_field(-1);
                    }
                }
                _ => {
                    if let Some(Detail {
                        edit: Some(DetailEdit::Item(_, input)),
                        ..
                    }) = &mut self.detail
                    {
                        input.handle_key(key);
                    }
                }
            },
            DetailEdit::AddItem(input) => match key.code {
                // Enter で足して、開いたまま続けられる。空の Enter と Esc で欄を出る
                KeyCode::Enter => {
                    if input.text().trim().is_empty() {
                        if let Some(detail) = &mut self.detail {
                            detail.edit = None;
                        }
                    } else if self.commit_detail_edit()
                        && let Some(detail) = &mut self.detail
                    {
                        detail.edit = Some(DetailEdit::AddItem(TextInput::default()));
                    }
                }
                KeyCode::Esc => {
                    self.commit_detail_edit();
                }
                _ => {
                    input.handle_key(key);
                }
            },
        }
    }

    /// 直している欄の文字を保存して、欄を出る。受け付けられなかったら（オフラインなど）、
    /// 欄を開いたままにして false（打った文字を消さない）
    pub fn commit_detail_edit(&mut self) -> bool {
        let Some(detail) = &mut self.detail else {
            return true;
        };
        let Some(edit) = detail.edit.take() else {
            return true;
        };
        let task_id = detail.task_id.clone();
        let Some(task) = self.task(&task_id).cloned() else {
            return true;
        };
        let result = match &edit {
            DetailEdit::Title(input) => {
                let title = input.text().trim().to_string();
                // 空のタイトルは受け付けない（元のタイトルのまま）
                if title.is_empty() || title == task.title {
                    self.unsaved_text
                        .remove(&(task_id.clone(), TextField::Title));
                    return true;
                }
                self.store.update_task(
                    &task_id,
                    TaskChanges {
                        title: Some(title),
                        ..Default::default()
                    },
                    AUTOSAVE,
                )
            }
            DetailEdit::Memo(area) => {
                let memo = area.text();
                if memo == task.memo {
                    self.unsaved_text
                        .remove(&(task_id.clone(), TextField::Memo));
                    return true;
                }
                self.store.update_task(
                    &task_id,
                    TaskChanges {
                        memo: Some(memo),
                        ..Default::default()
                    },
                    AUTOSAVE,
                )
            }
            DetailEdit::Item(item_id, input) => {
                let title = input.text();
                let next: Vec<ChecklistItem> = task
                    .checklist
                    .iter()
                    .cloned()
                    .map(|mut item| {
                        if item.id == *item_id {
                            item.title = title.clone();
                        }
                        item
                    })
                    .collect();
                if next == task.checklist {
                    return true;
                }
                self.store.update_task(
                    &task_id,
                    TaskChanges {
                        checklist: Some(next),
                        ..Default::default()
                    },
                    AUTOSAVE,
                )
            }
            DetailEdit::AddItem(input) => {
                let title = input.text().trim().to_string();
                if title.is_empty() {
                    return true;
                }
                let mut next = task.checklist.clone();
                next.push(ChecklistItem {
                    id: self.store.new_id(),
                    title,
                    done: false,
                });
                self.store.update_task(
                    &task_id,
                    TaskChanges {
                        checklist: Some(next),
                        ..Default::default()
                    },
                    PerformOptions::default(),
                )
            }
        };
        match result {
            Ok(_) | Err(crate::data::Failure::Noop) => {
                match &edit {
                    DetailEdit::Title(_) => {
                        self.unsaved_text.remove(&(task_id, TextField::Title));
                    }
                    DetailEdit::Memo(_) => {
                        self.unsaved_text.remove(&(task_id, TextField::Memo));
                    }
                    _ => {}
                }
                true
            }
            Err(_) => {
                self.toast_error(
                    "保存できませんでした",
                    Some("打った文字は欄に残してあります"),
                );
                if let Some(detail) = &mut self.detail {
                    detail.edit = Some(edit);
                }
                false
            }
        }
    }

    fn save_checklist(&mut self, task_id: &str, next: Vec<ChecklistItem>, options: PerformOptions) {
        let result = self.store.update_task(
            task_id,
            TaskChanges {
                checklist: Some(next),
                ..Default::default()
            },
            options,
        );
        if matches!(result, Err(crate::data::Failure::Invalid)) {
            self.toast_error("保存できませんでした", None);
        }
    }

    fn remove_checklist_item(&mut self, task: &Task, item_id: &str) {
        let index = task.checklist.iter().position(|item| item.id == item_id);
        let next: Vec<ChecklistItem> = task
            .checklist
            .iter()
            .filter(|item| item.id != item_id)
            .cloned()
            .collect();
        // 消したあとは、同じ位置の項目（なければ「項目を追加」）へ移る
        let field = index
            .and_then(|index| next.get(index))
            .map_or(DetailField::AddItem, |item| {
                DetailField::Item(item.id.clone())
            });
        self.save_checklist(&task.id, next, PerformOptions::default());
        self.set_detail_field(field);
    }

    /// 項目を1つ上（-1）か下（1）へ動かす。端なら動かさない
    fn move_checklist_item(&mut self, task: &Task, item_id: &str, delta: i32) {
        let Some(index) = task.checklist.iter().position(|item| item.id == item_id) else {
            return;
        };
        let to = index as i64 + i64::from(delta);
        if to < 0 || to >= task.checklist.len() as i64 {
            return;
        }
        let mut next = task.checklist.clone();
        next.swap(index, to as usize);
        self.save_checklist(&task.id, next, PerformOptions::default());
    }

    // --- 重ねて出すもの -----------------------------------------------------------------

    fn handle_overlay_key(&mut self, key: KeyEvent) {
        let Some(overlay) = self.overlay.take() else {
            return;
        };
        if key.code == KeyCode::Esc {
            if let Overlay::QuickAdd { input, .. } = &overlay {
                // 打った文字は、追加欄と同じ下書きに残る
                self.add_draft = input.text();
            }
            return;
        }
        // 閉じなかったら、戻り値のものを開いたままにする
        self.overlay = match overlay {
            Overlay::Date { kind, ids, input } => self.date_key(key, kind, ids, input),
            Overlay::Project { ids, input, index } => self.project_key(key, ids, input, index),
            Overlay::Value { kind, ids, index } => self.value_key(key, kind, ids, index),
            Overlay::Sort { index } => self.sort_key(key, index),
            Overlay::Palette { input, index } => self.palette_key(key, input, index),
            Overlay::Color { project_id, index } => self.color_key(key, project_id, index),
            Overlay::Name { input, rename } => self.name_key(key, input, rename),
            Overlay::QuickAdd {
                input,
                targets,
                index,
            } => self.quick_add_key(key, input, targets, index),
            Overlay::Filter { index } => self.filter_key(key, index),
        };
    }

    fn date_key(
        &mut self,
        key: KeyEvent,
        kind: DateKind,
        ids: Vec<String>,
        mut input: TextInput,
    ) -> Option<Overlay> {
        if key.code != KeyCode::Enter {
            input.handle_key(key);
            return Some(Overlay::Date { kind, ids, input });
        }
        let text = input.text();
        if text.trim().is_empty() {
            // 空のまま決めると、締切は外す（やる日は何もしない）
            if kind == DateKind::Deadline {
                self.set_deadline(&ids, None);
            }
            return None;
        }
        match parse_date_input(&text, &self.store.today) {
            Some(on) => {
                match kind {
                    DateKind::Schedule => self.schedule_tasks(&ids, &on),
                    DateKind::Deadline => self.set_deadline(&ids, Some(&on)),
                }
                None
            }
            // 読めなければ、欄を開いたままにする（「日付として読めません」と出ている）
            None => Some(Overlay::Date { kind, ids, input }),
        }
    }

    /// p の候補（打った文字で絞り込む）。プロジェクトなしが先頭、文字が既存の名前と違えば「◯◯」を作成が最後
    pub fn project_choices(&self, query: &str) -> Vec<ProjectChoice> {
        let lists = self.store.lists();
        let query = query.trim();
        let mut choices = Vec::new();
        if query.is_empty() {
            choices.push(ProjectChoice::None);
        }
        let mut exact = false;
        for id in &lists.projects {
            let Some(name) = self.project_name(id) else {
                continue;
            };
            if matches_query(name, query) {
                choices.push(ProjectChoice::Existing(id.clone()));
            }
            exact |= fold(name) == fold(query);
        }
        if !query.is_empty() && !exact {
            choices.push(ProjectChoice::Create(query.to_string()));
        }
        choices
    }

    fn project_key(
        &mut self,
        key: KeyEvent,
        ids: Vec<String>,
        mut input: TextInput,
        index: usize,
    ) -> Option<Overlay> {
        let choices = self.project_choices(&input.text());
        if let Some(index) = step(index, choices.len(), &key) {
            return Some(Overlay::Project { ids, input, index });
        }
        if key.code == KeyCode::Enter {
            match choices.get(index.min(choices.len().saturating_sub(1))) {
                Some(ProjectChoice::None) => self.set_task_project(&ids, None),
                Some(ProjectChoice::Existing(id)) => self.set_task_project(&ids, Some(id)),
                Some(ProjectChoice::Create(name)) => self.create_project_for(&ids, name),
                None => {}
            }
            return None;
        }
        let index = match input.handle_key(key) {
            InputOutcome::Changed => 0,
            InputOutcome::Ignored => index,
        };
        Some(Overlay::Project { ids, input, index })
    }

    fn value_key(
        &mut self,
        key: KeyEvent,
        kind: ValueKind,
        ids: Vec<String>,
        index: usize,
    ) -> Option<Overlay> {
        // 候補：値の一覧のあとに「なし」
        let len = match kind {
            ValueKind::Priority => Priority::ALL.len() + 1,
            ValueKind::Points => POINTS.len() + 1,
        };
        if let Some(index) = step(index, len, &key) {
            return Some(Overlay::Value { kind, ids, index });
        }
        let chosen = match (digit_of(&key), kind) {
            // その場で決める：優先度は 1 高・2 中・3 低・0 なし、工数は数字そのもの（0 でなし）
            (Some(0), _) => Some(len - 1),
            (Some(digit @ 1..=3), ValueKind::Priority) => Some(digit as usize - 1),
            (Some(digit), ValueKind::Points) => POINTS.iter().position(|p| u32::from(*p) == digit),
            _ if key.code == KeyCode::Enter => Some(index),
            _ => None,
        };
        let Some(chosen) = chosen else {
            return Some(Overlay::Value { kind, ids, index });
        };
        match kind {
            ValueKind::Priority => self.set_priority(&ids, Priority::ALL.get(chosen).copied()),
            ValueKind::Points => self.set_points(&ids, POINTS.get(chosen).copied()),
        }
        None
    }

    fn sort_key(&mut self, key: KeyEvent, index: usize) -> Option<Overlay> {
        if let Some(index) = step(index, TaskSort::ALL.len(), &key) {
            return Some(Overlay::Sort { index });
        }
        let chosen = match digit_of(&key) {
            Some(digit @ 1..=4) => Some(digit as usize - 1),
            _ if key.code == KeyCode::Enter => Some(index),
            _ => None,
        };
        match chosen.and_then(|chosen| TaskSort::ALL.get(chosen)) {
            Some(sort) => {
                self.set_sort(*sort);
                None
            }
            None => Some(Overlay::Sort { index }),
        }
    }

    fn color_key(&mut self, key: KeyEvent, project_id: String, index: usize) -> Option<Overlay> {
        let len = PROJECT_COLORS.len();
        let next = match key.code {
            KeyCode::Right | KeyCode::Down | KeyCode::Tab => Some((index + 1).min(len - 1)),
            KeyCode::Left | KeyCode::Up | KeyCode::BackTab => Some(index.saturating_sub(1)),
            _ => None,
        };
        if let Some(index) = next {
            return Some(Overlay::Color { project_id, index });
        }
        if key.code == KeyCode::Enter {
            self.set_project_color(&project_id, PROJECT_COLORS[index]);
            return None;
        }
        Some(Overlay::Color { project_id, index })
    }

    fn name_key(
        &mut self,
        key: KeyEvent,
        mut input: TextInput,
        rename: Option<String>,
    ) -> Option<Overlay> {
        if key.code != KeyCode::Enter {
            input.handle_key(key);
            return Some(Overlay::Name { input, rename });
        }
        let name = input.text();
        if name.trim().is_empty() {
            return None;
        }
        let closed = match &rename {
            Some(id) => self.rename_project(id, &name),
            None => self.create_project(&name),
        };
        (!closed).then_some(Overlay::Name { input, rename })
    }

    fn quick_add_key(
        &mut self,
        key: KeyEvent,
        mut input: TextInput,
        targets: Vec<QuickTarget>,
        index: usize,
    ) -> Option<Overlay> {
        match key.code {
            KeyCode::Tab => {
                let index = (index + 1) % targets.len();
                return Some(Overlay::QuickAdd {
                    input,
                    targets,
                    index,
                });
            }
            KeyCode::Enter => {
                let title = input.text();
                if !title.trim().is_empty() {
                    let to = match &targets[index] {
                        QuickTarget::Inbox => Destination::Inbox,
                        QuickTarget::Today => Destination::Today,
                        QuickTarget::Date(on) => Destination::Scheduled(on.clone()),
                    };
                    // 絞り込んでいるプロジェクトがあれば、追加したタスクに付ける
                    let project_id = match self.screen {
                        Screen::Calendar => self.calendar.filter.project_id(),
                        Screen::Timeline => self.timeline.filter.project_id(),
                        _ => None,
                    };
                    if self.quick_add(&title, to, project_id) {
                        input.clear();
                        self.add_draft.clear();
                    }
                }
            }
            _ => {
                input.handle_key(key);
            }
        }
        Some(Overlay::QuickAdd {
            input,
            targets,
            index,
        })
    }

    /// 絞り込みの候補：すべて・プロジェクトなし・プロジェクトごと
    pub fn filter_choices(&self) -> Vec<ProjectFilter> {
        let mut choices = vec![ProjectFilter::All, ProjectFilter::None];
        choices.extend(
            self.store
                .lists()
                .projects
                .iter()
                .map(|id| ProjectFilter::Project(id.clone())),
        );
        choices
    }

    fn filter_key(&mut self, key: KeyEvent, index: usize) -> Option<Overlay> {
        let choices = self.filter_choices();
        if let Some(index) = step(index, choices.len(), &key) {
            return Some(Overlay::Filter { index });
        }
        if key.code != KeyCode::Enter {
            return Some(Overlay::Filter { index });
        }
        if let Some(filter) = choices.get(index).cloned() {
            if self.screen == Screen::Calendar {
                self.calendar.filter = filter;
                self.calendar.entry = 0;
            } else {
                self.timeline.filter = filter;
                self.ensure_timeline_cursor();
            }
        }
        None
    }

    // --- 検索とコマンド -----------------------------------------------------------------

    /// タスクが今ある場所の名前
    fn location_of(&self, task: &Task) -> String {
        if task.is_completed() {
            return "完了".to_string();
        }
        match task.bucket {
            Bucket::Inbox => "受信箱",
            Bucket::Today => "今日",
            Bucket::Scheduled => "予定",
            Bucket::Later => "あとで",
        }
        .to_string()
    }

    /// 検索とコマンドの候補。今使える割り当て、プロジェクト、（文字を打ったら）タスク
    pub fn palette_items(&self, query: &str) -> Vec<PaletteItem> {
        let mut items = Vec::new();
        let all = bindings();
        for group in Group::ORDER {
            for binding in all.iter().filter(|binding| binding.group == group) {
                // 開くこと自体は並べない
                if binding.action == Action::Palette
                    || !self.can_run(&binding.action)
                    || !matches_query(&binding.label, query)
                {
                    continue;
                }
                items.push(PaletteItem::Command {
                    action: binding.action.clone(),
                    label: binding.label.clone(),
                    key: binding.keys.first().map(|spec| key_label(spec)),
                    group: group.label(),
                });
            }
        }
        for id in &self.store.lists().projects {
            if let Some(name) = self.project_name(id)
                && matches_query(name, query)
            {
                items.push(PaletteItem::Project {
                    id: id.clone(),
                    name: name.to_string(),
                });
            }
        }
        if !query.trim().is_empty() {
            // 未完了を先に、そのあとに完了済み（新しい順）
            let lists = self.store.lists();
            let open = [&lists.today, &lists.inbox, &lists.scheduled, &lists.later];
            let completed = lists
                .completed_today
                .iter()
                .chain(lists.logbook.iter().flat_map(|day| &day.tasks));
            let found = open
                .into_iter()
                .flatten()
                .chain(completed)
                .filter_map(|id| self.task(id))
                .filter(|task| matches_query(&task.title, query))
                .take(TASK_RESULT_LIMIT);
            for task in found {
                let location = self.location_of(task);
                let project = task
                    .project_id
                    .as_deref()
                    .and_then(|id| self.project_name(id));
                items.push(PaletteItem::Task {
                    id: task.id.clone(),
                    title: task.title.clone(),
                    location: match project {
                        Some(name) => format!("{location}・{name}"),
                        None => location,
                    },
                });
            }
        }
        items
    }

    fn palette_key(
        &mut self,
        key: KeyEvent,
        mut input: TextInput,
        index: usize,
    ) -> Option<Overlay> {
        let mut items = self.palette_items(&input.text());
        if let Some(index) = step(index, items.len(), &key) {
            return Some(Overlay::Palette { input, index });
        }
        if key.code == KeyCode::Enter {
            if index < items.len() {
                match items.swap_remove(index) {
                    PaletteItem::Command { action, .. } => self.run_action(action),
                    PaletteItem::Project { id, .. } => {
                        self.navigate(Screen::Project(id));
                        self.focus = Focus::Main;
                    }
                    PaletteItem::Task { id, .. } => self.reveal_task(&id),
                }
            }
            return self.overlay.take();
        }
        let index = match input.handle_key(key) {
            InputOutcome::Changed => 0,
            InputOutcome::Ignored => index,
        };
        Some(Overlay::Palette { input, index })
    }

    /// 検索で選んだタスクを、そのリストで選ぶ。閉じているまとまり（今日の「完了 N件」）にあれば開き、
    /// 完了ログなら、その行まで読み込む
    pub fn reveal_task(&mut self, task_id: &str) {
        let Some(task) = self.task(task_id).cloned() else {
            return;
        };
        if task.deleted_at.is_some() {
            return;
        }
        let lists = self.store.lists();
        let screen = if !task.is_completed() {
            match task.bucket {
                Bucket::Inbox => Screen::Inbox,
                Bucket::Today => Screen::Today,
                Bucket::Scheduled => Screen::Upcoming,
                Bucket::Later => Screen::Later,
            }
        } else if lists.completed_today.iter().any(|id| id == task_id) {
            Screen::Today
        } else {
            Screen::Logbook
        };
        self.focus = Focus::Main;
        self.navigate(screen.clone());
        if screen == Screen::Logbook {
            let position = lists
                .logbook
                .iter()
                .flat_map(|day| &day.tasks)
                .position(|id| id == task_id)
                .unwrap_or(0);
            self.logbook_limit = self.logbook_limit.max(position + 1);
        }
        if let Some(view) = self.view() {
            if let Some(section) = view.section_of(task_id)
                && section.fold.is_some()
            {
                let key = section.key.clone();
                self.list.open_fold(&view, &key);
            }
            self.list.select(Some(task_id));
        }
    }
}
