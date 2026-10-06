//! 一覧の状態。画面（リスト）ごとの中身は ListView で受け取り、状態は1つだけ持つ。
//! - 選択中：ふだんは1つ（↑↓ で動かす）。⇧↑↓ で範囲を広げられる。
//!   選択の中の1行は「カーソル」（↑↓ の起点）。キーの操作は、選んでいるすべての行に働く
//! - ボード（まとまりに列のある一覧）では、↑↓・⇧↑↓ は同じ列の中だけを動き、←→ で隣の列へ移る
//! - 閉じられるまとまり（今日の「完了 N件」）の開閉
//!
//! データ（タスクの中身や並び）はストアが持ち、ここでは id で指すだけ

use std::collections::{HashMap, HashSet};

use crate::data::Destination;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListKind {
    Inbox,
    Today,
    Upcoming,
    Later,
    Logbook,
    Project,
}

/// ボードの列
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Column {
    NotStarted,
    InProgress,
    Completed,
}

impl Column {
    pub const ALL: [Column; 3] = [Column::NotStarted, Column::InProgress, Column::Completed];

    pub fn label(self) -> &'static str {
        match self {
            Column::NotStarted => "未着手",
            Column::InProgress => "進行中",
            Column::Completed => "完了",
        }
    }
}

/// n で追加する行き先
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AddTarget {
    pub to: Destination,
    pub project_id: Option<String>,
    /// 追加欄に小さく出す行き先（例：「今日に追加」）
    pub label: &'static str,
}

/// 一覧の中のまとまり（今日の未完了と「完了 N件」、完了ログの日ごと、プロジェクトごと、など）
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Section {
    pub key: String,
    /// まとまりの見出し。行が1つもないまとまりは見出しも出さない
    pub heading: Option<String>,
    pub rows: Vec<String>,
    /// 閉じられるまとまり（今日の「完了 N件」）の見出し。最初は閉じていて、閉じているあいだは ↑↓ でも選ばない
    pub fold: Option<String>,
    /// 自分で決めた順（rank）で並ぶまとまり。このまとまりの中で並べ替えられる
    pub reorderable: bool,
    /// 並び方（手動以外）で並べ替えて見せている、並べ替えられるまとまり。並べ替えは止めて知らせる
    pub sorted: bool,
    /// ボードの列
    pub column: Option<Column>,
}

/// 画面ごとの一覧の中身
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListView {
    /// 画面ごとの名前（例：`today`、プロジェクトなら `project:<id>`）。選択や開閉をこの名前で覚える
    pub key: String,
    pub kind: ListKind,
    pub sections: Vec<Section>,
    pub add_to: AddTarget,
    /// 追加欄を開くまとまり（そのまとまりの一番下に開く）。None なら一覧の一番上
    pub add_in_section: Option<String>,
    /// ボードで見ているか
    pub board: bool,
}

#[derive(Default)]
pub struct ListState {
    /// 選択の中のカーソル（↑↓ の起点）
    pub cursor: Option<String>,
    /// 選んでいる行（カーソルを含む）
    selection: HashSet<String>,
    /// ⇧↑↓ で広げる範囲の起点
    anchor: Option<String>,
    /// 開いているまとまり（`<画面>:<まとまり>`）
    open_folds: HashSet<String>,
    /// 画面ごとに最後に選んでいたタスク（リストを切り替えて戻ったときに戻す）
    selection_by_view: HashMap<String, String>,
    /// 列のある一覧で、最後にいた列
    column: Option<Column>,
}

impl ListView {
    pub fn is_fold_open(&self, state: &ListState, section: &Section) -> bool {
        section.fold.is_none()
            || state
                .open_folds
                .contains(&format!("{}:{}", self.key, section.key))
    }

    /// ↑↓ で選べる行（上から見えている順。閉じているまとまりの行は入らない）
    pub fn rows(&self, state: &ListState) -> Vec<&str> {
        self.sections
            .iter()
            .filter(|section| self.is_fold_open(state, section))
            .flat_map(|section| section.rows.iter().map(String::as_str))
            .collect()
    }

    /// そのタスクの行があるまとまり（閉じているまとまりも含む）
    pub fn section_of(&self, task_id: &str) -> Option<&Section> {
        self.sections
            .iter()
            .find(|section| section.rows.iter().any(|id| id == task_id))
    }

    /// ボードの列（左から順）。列のない一覧では空
    pub fn columns(&self) -> Vec<Column> {
        Column::ALL
            .into_iter()
            .filter(|column| self.sections.iter().any(|s| s.column == Some(*column)))
            .collect()
    }

    /// その列の行（上から順。閉じているまとまりの行は入らない）
    pub fn column_rows(&self, state: &ListState, column: Column) -> Vec<&str> {
        self.sections
            .iter()
            .filter(|section| section.column == Some(column) && self.is_fold_open(state, section))
            .flat_map(|section| section.rows.iter().map(String::as_str))
            .collect()
    }

    /// ids の行がすべて入っている、並べ替えられるまとまり
    pub fn reorderable_section_of(&self, ids: &[String]) -> Option<&Section> {
        let section = self.section_of(ids.first()?)?;
        (section.reorderable && ids.iter().all(|id| section.rows.contains(id))).then_some(section)
    }
}

impl ListState {
    pub fn is_selected(&self, id: &str) -> bool {
        self.selection.contains(id)
    }

    /// 選んでいる行の id（上から見えている順）
    pub fn selected_rows(&self, view: &ListView) -> Vec<String> {
        if self.selection.is_empty() {
            return Vec::new();
        }
        view.rows(self)
            .into_iter()
            .filter(|id| self.selection.contains(*id))
            .map(str::to_string)
            .collect()
    }

    pub fn select(&mut self, id: Option<&str>) {
        self.selection.clear();
        self.cursor = id.map(str::to_string);
        self.anchor = self.cursor.clone();
        if let Some(id) = id {
            self.selection.insert(id.to_string());
        }
    }

    /// 画面が変わるとき。前の画面の選択を覚え、次の画面で前に選んでいたタスクに戻す
    pub fn switch_view(&mut self, from: Option<&ListView>, to: Option<&ListView>) {
        if let (Some(from), Some(cursor)) = (from, &self.cursor) {
            self.selection_by_view
                .insert(from.key.clone(), cursor.clone());
        }
        self.column = None;
        self.select(None);
        if let Some(to) = to
            && let Some(remembered) = self.selection_by_view.get(&to.key).cloned()
            && to.rows(self).contains(&remembered.as_str())
        {
            self.select(Some(&remembered));
        }
    }

    /// カーソルが一覧から消えていたら、選択を片付ける（ほかの画面の変更で行が消えたときなど）
    pub fn reconcile(&mut self, view: &ListView) {
        let rows: HashSet<&str> = view.rows(self).into_iter().collect();
        if self.cursor.as_deref().is_some_and(|id| !rows.contains(id)) {
            self.select(None);
            return;
        }
        if self.selection.len() > 1 {
            self.selection.retain(|id| rows.contains(id.as_str()));
        }
    }

    pub fn toggle_fold(&mut self, view: &ListView, section_key: &str) {
        let key = format!("{}:{section_key}", view.key);
        if !self.open_folds.remove(&key) {
            self.open_folds.insert(key);
        }
    }

    pub fn open_fold(&mut self, view: &ListView, section_key: &str) {
        self.open_folds
            .insert(format!("{}:{section_key}", view.key));
    }

    /// ↑↓ で動ける行。ボードでは、今いる列（何も選んでいなければ最後にいた列か、行のある一番左の列）の行
    fn navigable_rows(&mut self, view: &ListView) -> Vec<String> {
        let columns = view.columns();
        if columns.is_empty() {
            return view.rows(self).into_iter().map(str::to_string).collect();
        }
        let current = self
            .cursor
            .as_deref()
            .and_then(|id| view.section_of(id))
            .and_then(|section| section.column)
            .or(self.column.filter(|column| columns.contains(column)))
            .or_else(|| {
                columns
                    .iter()
                    .copied()
                    .find(|column| !view.column_rows(self, *column).is_empty())
            });
        let Some(column) = current else {
            return Vec::new();
        };
        self.column = Some(column);
        view.column_rows(self, column)
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    /// 選択を上下に動かす。何も選んでいなければ、↓ で一番上、↑ で一番下を選ぶ。
    /// 一番下（上）からさらに進もうとしたら false（完了ログの続きを読み込むきっかけ）
    pub fn move_selection(&mut self, view: &ListView, delta: i32) -> bool {
        let rows = self.navigable_rows(view);
        if rows.is_empty() {
            return true;
        }
        let index = self
            .cursor
            .as_ref()
            .and_then(|id| rows.iter().position(|row| row == id));
        let last = rows.len() - 1;
        let next = match index {
            None => {
                if delta > 0 {
                    0
                } else {
                    last
                }
            }
            Some(index) => (index as i64 + i64::from(delta)).clamp(0, last as i64) as usize,
        };
        let moved = index != Some(next);
        self.select(Some(&rows[next]));
        moved
    }

    /// 一番上・一番下の行を選ぶ
    pub fn move_to_edge(&mut self, view: &ListView, bottom: bool) {
        let rows = self.navigable_rows(view);
        let target = if bottom { rows.last() } else { rows.first() };
        if let Some(id) = target {
            self.select(Some(id));
        }
    }

    /// ←→（ボード）：隣の列へ移る。行のない列は飛ばす。移った先では、前の列と同じ位置（上から何番目か）の行を選ぶ
    /// （先の列の行が少なければ一番下）。何も選んでいなければ、→ で行のある一番左の列、← で一番右の列の一番上を選ぶ
    pub fn move_column(&mut self, view: &ListView, delta: i32) {
        let columns = view.columns();
        let has_rows = |column: Column| !view.column_rows(self, column).is_empty();
        let current = self
            .cursor
            .as_deref()
            .and_then(|id| view.section_of(id))
            .and_then(|section| section.column);
        let mut index = 0;
        let target = match current {
            None => {
                let mut filled = columns.iter().copied().filter(|column| has_rows(*column));
                if delta > 0 {
                    filled.next()
                } else {
                    filled.next_back()
                }
            }
            Some(current) => {
                index = view
                    .column_rows(self, current)
                    .iter()
                    .position(|id| Some(*id) == self.cursor.as_deref())
                    .unwrap_or(0);
                let from = columns.iter().position(|column| *column == current);
                let mut found = None;
                let mut i = from.map_or(-1, |from| from as i32 + delta);
                while i >= 0 && (i as usize) < columns.len() {
                    if has_rows(columns[i as usize]) {
                        found = Some(columns[i as usize]);
                        break;
                    }
                    i += delta;
                }
                found
            }
        };
        let Some(target) = target else {
            return;
        };
        let rows = view.column_rows(self, target);
        let id = rows[index.min(rows.len() - 1)].to_string();
        self.column = Some(target);
        self.select(Some(&id));
    }

    /// ⇧↑↓：選択の範囲を広げる・縮める。起点（最初に選んだ行）からカーソルまでを選ぶ。
    /// ボードでは、今いる列の中だけで広げる。何も選んでいなければ ↑↓ と同じ
    pub fn extend_selection(&mut self, view: &ListView, delta: i32) {
        let rows = self.navigable_rows(view);
        let Some(cursor) = self
            .cursor
            .as_ref()
            .and_then(|id| rows.iter().position(|row| row == id))
        else {
            self.move_selection(view, delta);
            return;
        };
        let anchor = self
            .anchor
            .as_ref()
            .and_then(|id| rows.iter().position(|row| row == id))
            .unwrap_or(cursor);
        let next = (cursor as i64 + i64::from(delta)).clamp(0, rows.len() as i64 - 1) as usize;
        self.selection = rows[anchor.min(next)..=anchor.max(next)]
            .iter()
            .cloned()
            .collect();
        self.cursor = Some(rows[next].clone());
        self.anchor = Some(rows[anchor].clone());
    }

    /// ids を一覧から抜いたときに次に選ぶ行（下の行、なければ上の行）。
    /// 閉じられるまとまりの中と外、ボードの列はまたがない
    pub fn neighbor_after(&self, view: &ListView, ids: &[String]) -> Option<String> {
        let rows = view.rows(self);
        let removing: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let index = rows.iter().position(|id| removing.contains(id))?;
        let group = |id: &str| {
            view.section_of(id)
                .map(|section| (section.fold.is_some(), section.column))
        };
        let anchor_group = group(rows[index]);
        let candidate = |id: &str| !removing.contains(id) && group(id) == anchor_group;
        rows[index + 1..]
            .iter()
            .find(|id| candidate(id))
            .or_else(|| rows[..index].iter().rev().find(|id| candidate(id)))
            .map(|id| id.to_string())
    }
}

/// 並べ替えの計算。まとまりの今の並び（id の列）と動かす行から、「どの行を、見えているどの行のあいだへ入れるか」を作る。
/// 選んだ行を、まとめて1つ上（delta = -1）・下（1）へ。離れて選んだ行は、それぞれが隣の動かさない行を1つ越える。
/// どれかがもう端にあれば動かさない（None）
pub fn plan_step(
    order: &[String],
    selected: &HashSet<String>,
    delta: i32,
) -> Option<Vec<crate::data::Placement>> {
    let moving: HashSet<&str> = order
        .iter()
        .filter(|id| selected.contains(*id))
        .map(String::as_str)
        .collect();
    if moving.is_empty() || moving.len() == order.len() {
        return None;
    }
    let mut next: Vec<&str> = order.iter().map(String::as_str).collect();
    if delta > 0 {
        next.reverse();
    }
    if moving.contains(next[0]) {
        return None;
    }
    for i in 1..next.len() {
        if moving.contains(next[i]) && !moving.contains(next[i - 1]) {
            next.swap(i - 1, i);
        }
    }
    if delta > 0 {
        next.reverse();
    }
    // 新しい並びから、動かした行の連なりごとに、前後の動かさない行を拾う
    let mut placements = Vec::new();
    let mut run: Vec<String> = Vec::new();
    let mut after: Option<String> = None;
    for id in next {
        if moving.contains(id) {
            run.push(id.to_string());
            continue;
        }
        if !run.is_empty() {
            placements.push(crate::data::Placement {
                ids: std::mem::take(&mut run),
                after: after.clone(),
                before: Some(id.to_string()),
            });
        }
        after = Some(id.to_string());
    }
    if !run.is_empty() {
        placements.push(crate::data::Placement {
            ids: run,
            after,
            before: None,
        });
    }
    Some(placements)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::Placement;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|id| id.to_string()).collect()
    }

    fn view(sections: Vec<Section>) -> ListView {
        ListView {
            key: "today".into(),
            kind: ListKind::Today,
            sections,
            add_to: AddTarget {
                to: Destination::Today,
                project_id: None,
                label: "今日に追加",
            },
            add_in_section: None,
            board: false,
        }
    }

    fn today_view() -> ListView {
        view(vec![
            Section {
                key: "open".into(),
                rows: ids(&["a", "b", "c"]),
                reorderable: true,
                ..Default::default()
            },
            Section {
                key: "completed".into(),
                rows: ids(&["x", "y"]),
                fold: Some("完了 2件".into()),
                ..Default::default()
            },
        ])
    }

    #[test]
    fn 上下に動かし_閉じているまとまりは選ばない() {
        let view = today_view();
        let mut state = ListState::default();
        state.move_selection(&view, 1);
        assert_eq!(state.cursor.as_deref(), Some("a"));
        state.move_selection(&view, -1);
        assert_eq!(state.cursor.as_deref(), Some("a"));
        state.move_to_edge(&view, true);
        assert_eq!(state.cursor.as_deref(), Some("c"));
        assert!(!state.move_selection(&view, 1));
        state.toggle_fold(&view, "completed");
        assert!(state.move_selection(&view, 1));
        assert_eq!(state.cursor.as_deref(), Some("x"));
    }

    #[test]
    fn 範囲を広げたり縮めたりできる() {
        let view = today_view();
        let mut state = ListState::default();
        state.select(Some("a"));
        state.extend_selection(&view, 1);
        state.extend_selection(&view, 1);
        assert_eq!(state.selected_rows(&view), ids(&["a", "b", "c"]));
        state.extend_selection(&view, -1);
        assert_eq!(state.selected_rows(&view), ids(&["a", "b"]));
        assert_eq!(state.cursor.as_deref(), Some("b"));
        state.move_selection(&view, 1);
        assert_eq!(state.selected_rows(&view), ids(&["c"]));
    }

    #[test]
    fn 抜いたあとは下の行_なければ上の行を選ぶ_まとまりはまたがない() {
        let view = today_view();
        let mut state = ListState::default();
        state.toggle_fold(&view, "completed");
        assert_eq!(
            state.neighbor_after(&view, &ids(&["b"])).as_deref(),
            Some("c")
        );
        assert_eq!(
            state.neighbor_after(&view, &ids(&["c"])).as_deref(),
            Some("b")
        );
        assert_eq!(state.neighbor_after(&view, &ids(&["a", "b", "c"])), None);
        assert_eq!(
            state.neighbor_after(&view, &ids(&["y"])).as_deref(),
            Some("x")
        );
    }

    #[test]
    fn ボードでは列の中だけを動き_左右で隣の列へ移る() {
        let board = view(vec![
            Section {
                key: "notStarted".into(),
                rows: ids(&["a", "b", "c"]),
                column: Some(Column::NotStarted),
                ..Default::default()
            },
            Section {
                key: "inProgress".into(),
                rows: vec![],
                column: Some(Column::InProgress),
                ..Default::default()
            },
            Section {
                key: "completed".into(),
                rows: ids(&["x"]),
                column: Some(Column::Completed),
                ..Default::default()
            },
        ]);
        let mut state = ListState::default();
        state.move_selection(&board, 1);
        state.move_to_edge(&board, true);
        assert_eq!(state.cursor.as_deref(), Some("c"));
        assert!(!state.move_selection(&board, 1));
        // 行のない列は飛ばし、先の列の行が少なければ一番下
        state.move_column(&board, 1);
        assert_eq!(state.cursor.as_deref(), Some("x"));
        state.move_column(&board, 1);
        assert_eq!(state.cursor.as_deref(), Some("x"));
        state.move_column(&board, -1);
        assert_eq!(state.cursor.as_deref(), Some("a"));
    }

    #[test]
    fn 並べ替えは隣の動かさない行を1つ越える() {
        let order = ids(&["a", "b", "c", "d"]);
        let selected: HashSet<String> = ids(&["b", "c"]).into_iter().collect();
        assert_eq!(
            plan_step(&order, &selected, 1),
            Some(vec![Placement {
                ids: ids(&["b", "c"]),
                after: Some("d".into()),
                before: None
            }])
        );
        assert_eq!(
            plan_step(&order, &selected, -1),
            Some(vec![Placement {
                ids: ids(&["b", "c"]),
                after: None,
                before: Some("a".into())
            }])
        );
        // もう端にある
        let top: HashSet<String> = ids(&["a"]).into_iter().collect();
        assert_eq!(plan_step(&order, &top, -1), None);
    }
}
