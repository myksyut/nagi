//! タスクへの操作（キーから呼ぶ）。データを変えるのはストアの操作で、ここでは選択の移動、
//! 開いているタスクを閉じること、「元に戻す」のトーストを受け持つ。
//! 複数選んでいるときも、1回の操作は1つのまとまりとして送る（元に戻す1回でまとめて戻る）

use std::collections::HashSet;

use super::app::{App, Screen, TextField};
use super::clipboard::{copied_message, task_clipboard_text, write_clipboard};
use super::list::plan_step;
use crate::data::{AddTask, Destination, Failure, OpResult, Store};
use crate::dates::format_long_date;
use crate::model::{MAX_MUTATIONS_PER_BATCH, Priority, ProjectChanges};

/// 一度に扱える件数（データ層の1回の操作の上限と同じ）。超えたら分けずに断る
pub const MAX_BULK: usize = MAX_MUTATIONS_PER_BATCH;
/// 並び方（手動以外）で並べ替えて見せているあいだに並べ替えようとしたときの知らせ
const MANUAL_ORDER_ONLY: &str = "手動の並びのときに使えます";

fn too_many_message() -> String {
    format!("一度に扱えるのは {MAX_BULK} 件まで")
}

impl App {
    /// 件数が上限以内か。超えていたら知らせて false（データ層に送る前に止める）
    fn within_bulk_limit(&mut self, count: usize) -> bool {
        if count <= MAX_BULK {
            return true;
        }
        self.toast_error(&too_many_message(), None);
        false
    }

    /// 受け付けられなかった操作を知らせる。変えるものがなかったときは知らせない。
    /// オフライン・ログインが切れた・版が古いは、それぞれの知らせが受け持つ
    fn notify_failure(&mut self, reason: Failure) {
        match reason {
            Failure::TooMany => self.toast_error(&too_many_message(), None),
            // 並び順キーが長くなりすぎた（同じ隙間へ入れ続けた）など
            Failure::Invalid => self.toast_error("保存できませんでした", None),
            _ => {}
        }
        self.handle_notices();
    }

    /// 操作を1つ実行する。
    /// - advance：選んでいた行が対象なら、一覧に残っていても次の行へ選択を移す（完了）
    /// - toast：「元に戻す」付きのトーストの文言。left は一覧から抜けた行、changed は実際に変えたタスク
    pub fn run_op(
        &mut self,
        ids: &[String],
        advance: bool,
        perform: impl FnOnce(&mut Store) -> OpResult,
        toast: impl FnOnce(&App, &[String], &[String]) -> Option<String>,
    ) -> OpResult {
        if !self.within_bulk_limit(ids.len()) {
            return Err(Failure::TooMany);
        }
        let before = self.view();
        let selected_before = self.list.cursor.clone();
        let next = before
            .as_ref()
            .and_then(|view| self.list.neighbor_after(view, ids));
        let visible_before: HashSet<String> = before
            .as_ref()
            .map(|view| {
                view.rows(&self.list)
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();

        let done = match perform(&mut self.store) {
            Ok(done) => done,
            Err(reason) => {
                self.notify_failure(reason);
                return Err(reason);
            }
        };

        let after = self.view();
        let visible: HashSet<String> = after
            .as_ref()
            .map(|view| {
                view.rows(&self.list)
                    .into_iter()
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        // 一覧から抜けた行：前は一覧にあって、今はない行
        let left: Vec<String> = ids
            .iter()
            .filter(|id| visible_before.contains(*id) && !visible.contains(*id))
            .cloned()
            .collect();
        let changed: Vec<String> = done
            .ids
            .iter()
            .filter(|id| ids.contains(id))
            .cloned()
            .collect();
        let moves = |id: &str| {
            ids.iter().any(|other| other == id)
                && (advance || (after.is_some() && !visible.contains(id)))
        };
        if self
            .detail
            .as_ref()
            .is_some_and(|detail| moves(&detail.task_id))
        {
            self.detail = None;
        }
        if selected_before.as_deref().is_some_and(moves) {
            self.list.select(next.as_deref());
        }
        if let Some(message) = toast(self, &left, &changed) {
            self.toast_undo(&message);
        }
        self.reconcile();
        Ok(done)
    }

    /// トーストの対象の書き方。2件以上をまとめて変えたら、一覧に残っていても件数（「3件」）。
    /// 1件なら、一覧から抜けたときだけタイトル（「「請求書の確認」」）。残っているときは出さない
    fn toast_subject(&self, left: &[String], changed: &[String]) -> Option<String> {
        if changed.len() >= 2 {
            return Some(format!("{}件", changed.len()));
        }
        match left {
            [] => None,
            [id] => Some(format!(
                "「{}」",
                self.task(id).map_or("", |task| task.title.as_str())
            )),
            _ => Some(format!("{}件", left.len())),
        }
    }

    // --- 完了 ---------------------------------------------------------------------------

    /// 完了。今日以外のリストで完了したら「完了しました」。2件以上なら今日でも「3件を完了しました」
    pub fn complete_tasks(&mut self, ids: &[String]) -> OpResult {
        let in_today = self.screen == Screen::Today;
        self.run_op(
            ids,
            true,
            |store| store.complete_tasks(ids),
            |_, _, changed| {
                if changed.len() >= 2 {
                    Some(format!("{}件を完了しました", changed.len()))
                } else if in_today {
                    None
                } else {
                    Some("完了しました".to_string())
                }
            },
        )
    }

    /// あとから完了を外す（「完了 N件」や完了ログの行で）。今日の一番下に戻る
    pub fn uncomplete_tasks(&mut self, ids: &[String]) -> OpResult {
        self.run_op(
            ids,
            false,
            |store| store.uncomplete_tasks(ids, false),
            |app, left, changed| {
                app.toast_subject(left, changed)
                    .map(|subject| format!("{subject}を今日に戻しました"))
            },
        )
    }

    /// x：未完了のものがあれば完了、すべて完了済みなら完了を外す
    pub fn toggle_complete(&mut self, ids: &[String]) {
        let rows: Vec<&crate::model::Task> = ids
            .iter()
            .filter_map(|id| self.task(id))
            .filter(|task| task.deleted_at.is_none())
            .collect();
        let open: Vec<String> = rows
            .iter()
            .filter(|task| !task.is_completed())
            .map(|task| task.id.clone())
            .collect();
        let all: Vec<String> = rows.iter().map(|task| task.id.clone()).collect();
        let _ = if open.is_empty() {
            self.uncomplete_tasks(&all)
        } else {
            self.complete_tasks(&open)
        };
    }

    // --- 振り分け -----------------------------------------------------------------------

    /// 振り分け（t：今日の一番下へ、l：あとでへ）。一覧から抜けたら（2件以上なら残っていても）「今日へ」
    pub fn move_tasks(&mut self, ids: &[String], to: Destination) {
        let name = match &to {
            Destination::Inbox => "受信箱",
            Destination::Today => "今日",
            Destination::Later => "あとで",
            Destination::Scheduled(_) => "予定",
        };
        let _ = self.run_op(
            ids,
            false,
            |store| store.move_tasks(ids, to.clone()),
            |app, left, changed| {
                app.toast_subject(left, changed)
                    .map(|subject| format!("{subject}を{name}へ"))
            },
        );
    }

    /// d：日付を決めて予定へ。今日か過去の日付なら今日の一番下へ入る
    pub fn schedule_tasks(&mut self, ids: &[String], on: &str) {
        let today = self.store.today.clone();
        let destination = if on <= today.as_str() {
            "今日".to_string()
        } else {
            format_long_date(on, &today)
        };
        let _ = self.run_op(
            ids,
            false,
            |store| store.move_tasks(ids, Destination::Scheduled(on.to_string())),
            |app, left, changed| {
                app.toast_subject(left, changed)
                    .map(|subject| format!("{subject}を{destination}へ"))
            },
        );
    }

    /// D：締切を付ける・外す（None）。予定・あとでのタスクに今日以前の締切を付けると今日の一番上へ移る
    pub fn set_deadline(&mut self, ids: &[String], deadline_on: Option<&str>) {
        let today = self.store.today.clone();
        let _ = self.run_op(
            ids,
            false,
            |store| store.set_deadline(ids, deadline_on),
            |app, left, changed| {
                // 2件以上なら、一覧に残っていても件数で
                if changed.len() >= 2 {
                    return Some(match deadline_on {
                        None => format!("{}件の締切を外しました", changed.len()),
                        Some(on) => format!(
                            "{}件の締切を{}にしました",
                            changed.len(),
                            format_long_date(on, &today)
                        ),
                    });
                }
                app.toast_subject(left, changed)
                    .map(|subject| format!("{subject}を今日へ"))
            },
        );
    }

    /// やる日と締切を、同じ日数だけずらす（タイムラインの < >）
    pub fn shift_dates(&mut self, ids: &[String], days: i64) {
        let _ = self.run_op(
            ids,
            false,
            |store| store.shift_task_dates(ids, days),
            |_, _, changed| {
                (changed.len() >= 2).then(|| format!("{}件の日付をずらしました", changed.len()))
            },
        );
    }

    // --- 進行中 -------------------------------------------------------------------------

    /// s：選んだ中に未着手が1つでもあれば、未着手のものを進行中にする。全部が進行中のときだけ未着手に戻す。
    /// 完了済みの行には効かない（ボードの完了のカードだけは、進行中で戻す）
    pub fn toggle_started(&mut self, ids: &[String]) {
        let rows: Vec<&crate::model::Task> = ids
            .iter()
            .filter_map(|id| self.task(id))
            .filter(|task| task.deleted_at.is_none() && !task.is_completed())
            .collect();
        if rows.is_empty() {
            // ボードの完了のカードは、進行中で戻せる（完了を外して今日の一番下に進行中で戻すのを、1つの操作にする）
            let completed: Vec<String> = ids
                .iter()
                .filter(|id| {
                    self.task(id)
                        .is_some_and(|task| task.deleted_at.is_none() && task.is_completed())
                })
                .cloned()
                .collect();
            if self.is_board() && !completed.is_empty() {
                let _ = self.run_op(
                    &completed,
                    false,
                    |store| store.uncomplete_tasks(&completed, true),
                    |_, _, changed| {
                        (changed.len() >= 2)
                            .then(|| format!("{}件を進行中に戻しました", changed.len()))
                    },
                );
            }
            return;
        }
        let not_started: Vec<String> = rows
            .iter()
            .filter(|task| task.started_at.is_none())
            .map(|task| task.id.clone())
            .collect();
        let all: Vec<String> = rows.iter().map(|task| task.id.clone()).collect();
        let _ = if not_started.is_empty() {
            // 未着手に戻す（位置は変わらない）
            self.run_op(
                &all,
                false,
                |store| store.stop_tasks(&all),
                |_, _, changed| {
                    (changed.len() >= 2).then(|| format!("{}件を未着手に戻しました", changed.len()))
                },
            )
        } else {
            // 進行中にする。今日以外の行は今日の一番上へ移る
            self.run_op(
                &not_started,
                false,
                |store| store.start_tasks(&not_started),
                |app, left, changed| {
                    if changed.len() >= 2 {
                        return Some(format!("{}件を進行中にしました", changed.len()));
                    }
                    app.toast_subject(left, changed)
                        .map(|subject| format!("{subject}を今日へ"))
                },
            )
        };
    }

    // --- 並べ替え・削除・元に戻す -------------------------------------------------------

    /// 選んでいる行を、まとめて1つ上（-1）・下（1）へ。選んでいる行がすべて同じ並べ替えられるまとまりにあるときだけ動かす
    pub fn move_selected_rows(&mut self, delta: i32) {
        let Some(view) = self.view() else {
            return;
        };
        let ids = self.list.selected_rows(&view);
        if ids.is_empty() || !self.within_bulk_limit(ids.len()) {
            return;
        }
        let Some(section) = view.reorderable_section_of(&ids) else {
            return;
        };
        if section.sorted {
            self.toast_error(MANUAL_ORDER_ONLY, None);
            return;
        }
        let selected: HashSet<String> = ids.iter().cloned().collect();
        let Some(placements) = plan_step(&section.rows, &selected, delta) else {
            return;
        };
        let _ = self.run_op(
            &ids,
            false,
            |store| store.reorder_tasks(&placements),
            |_, _, _| None,
        );
    }

    /// 削除（確認は出さない）。「削除しました」
    pub fn delete_tasks(&mut self, ids: &[String]) {
        let _ = self.run_op(
            ids,
            false,
            |store| store.delete_tasks(ids),
            |_, _, changed| {
                Some(if changed.len() >= 2 {
                    format!("{}件を削除しました", changed.len())
                } else {
                    "削除しました".to_string()
                })
            },
        );
    }

    /// 元に戻す。戻ったタスクが今の一覧にあれば選ぶ
    pub fn undo(&mut self) {
        let result = self.store.undo();
        self.handle_notices();
        let Ok(done) = result else {
            return;
        };
        self.dismiss_undo_toasts();
        if let Some(view) = self.view() {
            let rows = view.rows(&self.list);
            if let Some(restored) = done.ids.iter().find(|id| rows.contains(&id.as_str())) {
                let restored = restored.clone();
                self.list.select(Some(&restored));
            }
        }
        self.reconcile();
    }

    /// y：タスクのタイトルとメモをクリップボードに入れる（データは変えないので、元に戻すものはない）。
    /// 保存できていないタイトルとメモがあれば、開いたときに欄に出るそちらを入れる
    pub fn copy_tasks(&mut self, ids: &[String]) {
        if !self.within_bulk_limit(ids.len()) {
            return;
        }
        let tasks: Vec<(String, String)> = ids
            .iter()
            .filter_map(|id| self.task(id))
            .map(|task| {
                let unsaved = |field| self.unsaved_text.get(&(task.id.clone(), field)).cloned();
                (
                    // タイトルは空なら保存しない決まりなので、空のときは保存したほうを使う
                    unsaved(TextField::Title)
                        .filter(|title| !title.trim().is_empty())
                        .unwrap_or_else(|| task.title.clone()),
                    unsaved(TextField::Memo).unwrap_or_else(|| task.memo.clone()),
                )
            })
            .collect();
        if tasks.is_empty() {
            return;
        }
        match write_clipboard(&task_clipboard_text(&tasks)) {
            Ok(()) => self.toast_info(&copied_message(&tasks)),
            Err(_) => self.toast_error("コピーできませんでした", None),
        }
    }

    // --- プロジェクト・優先度・工数 -----------------------------------------------------

    /// タスクにプロジェクトを付ける・外す（None）
    pub fn set_task_project(&mut self, ids: &[String], project_id: Option<&str>) {
        let name = project_id
            .and_then(|id| self.project_name(id))
            .map(str::to_string);
        let _ = self.run_op(
            ids,
            false,
            |store| store.set_project(ids, project_id),
            |app, left, changed| {
                let subject = app.toast_subject(left, changed)?;
                Some(match &name {
                    None => format!("{subject}のプロジェクトを外しました"),
                    Some(name) => format!("{subject}を「{name}」へ"),
                })
            },
        );
    }

    /// 新しいプロジェクトを作って、同じ操作でタスクに付ける（p の「「◯◯」を作成」）
    pub fn create_project_for(&mut self, ids: &[String], name: &str) {
        let _ = self.run_op(
            ids,
            false,
            |store| store.create_project(name, ids),
            |app, left, changed| {
                app.toast_subject(left, changed)
                    .map(|subject| format!("{subject}を「{}」へ", name.trim()))
            },
        );
    }

    pub fn set_priority(&mut self, ids: &[String], priority: Option<Priority>) {
        let _ = self.run_op(
            ids,
            false,
            |store| store.set_priority(ids, priority),
            |_, _, changed| {
                (changed.len() >= 2).then(|| match priority {
                    Some(priority) => format!(
                        "{}件の優先度を{}にしました",
                        changed.len(),
                        priority.label()
                    ),
                    None => format!("{}件の優先度を外しました", changed.len()),
                })
            },
        );
    }

    pub fn set_points(&mut self, ids: &[String], points: Option<u8>) {
        let _ = self.run_op(
            ids,
            false,
            |store| store.set_points(ids, points),
            |_, _, changed| {
                (changed.len() >= 2).then(|| match points {
                    Some(points) => format!("{}件の工数を {points} にしました", changed.len()),
                    None => format!("{}件の工数を外しました", changed.len()),
                })
            },
        );
    }

    /// プロジェクトを作って、その画面を開く。同じ名前のプロジェクトがあれば、作らずに開く
    pub fn create_project(&mut self, name: &str) -> bool {
        let name = name.trim();
        if name.is_empty() {
            return false;
        }
        let lists = self.store.lists();
        let existing = lists
            .projects
            .iter()
            .find(|id| {
                self.project_name(id)
                    .is_some_and(|other| super::text::fold(other) == super::text::fold(name))
            })
            .cloned();
        if let Some(id) = existing {
            self.navigate(Screen::Project(id));
            return true;
        }
        match self.store.create_project(name, &[]) {
            Ok(done) => {
                self.navigate(Screen::Project(done.ids[0].clone()));
                true
            }
            Err(reason) => {
                self.notify_failure(reason);
                false
            }
        }
    }

    /// 名前を変える。空の名前は受け付けない（元の名前のまま）
    pub fn rename_project(&mut self, id: &str, name: &str) -> bool {
        let result = self.store.update_project(
            id,
            ProjectChanges {
                name: Some(name.to_string()),
                ..Default::default()
            },
        );
        match result {
            Ok(_) | Err(Failure::Noop) => true,
            Err(reason) => {
                self.notify_failure(reason);
                // オフラインのときは、打った名前を消さないように欄を開いたままにする
                reason != Failure::Offline
            }
        }
    }

    /// アーカイブする（サイドバーから隠す）。未完了のタスクが残っていたら、アーカイブせずに件数を知らせる。
    /// アーカイブしたらサイドバーから消えるので、今日へ移る（「元に戻す」で戻せる）
    pub fn archive_project(&mut self, id: &str) {
        let name = self.project_name(id).unwrap_or_default().to_string();
        let result = self.store.update_project(
            id,
            ProjectChanges {
                archived_at: Some(Some(self.store.now_iso())),
                ..Default::default()
            },
        );
        match result {
            Ok(_) => {
                self.toast_undo(&format!("「{name}」をアーカイブしました"));
                self.navigate(Screen::Today);
            }
            Err(Failure::HasOpenTasks) => {
                let count = self.store.open_task_count_of_project(id);
                self.toast_error(
                    "アーカイブできません",
                    Some(&format!("未完了のタスクが {count} 件残っています")),
                );
            }
            Err(reason) => self.notify_failure(reason),
        }
    }

    /// アーカイブを外す（アーカイブ済みのプロジェクトの画面から。サイドバーに戻る）
    pub fn unarchive_project(&mut self, id: &str) {
        let result = self.store.update_project(
            id,
            ProjectChanges {
                archived_at: Some(None),
                ..Default::default()
            },
        );
        if let Err(reason) = result {
            self.notify_failure(reason);
        }
    }

    pub fn set_project_color(&mut self, id: &str, color: &str) {
        let result = self.store.update_project(
            id,
            ProjectChanges {
                color: Some(Some(color.to_string())),
                ..Default::default()
            },
        );
        if let Err(reason) = result {
            self.notify_failure(reason);
        }
    }

    // --- 追加 ---------------------------------------------------------------------------

    /// 追加欄の文字でタスクを追加する。追加できたら欄を空にして、開いたまま続けられる
    pub fn add_from_row(&mut self) {
        let Some(view) = self.view() else {
            return;
        };
        let title = self
            .adding
            .as_ref()
            .map(|input| input.text())
            .unwrap_or_default();
        if title.trim().is_empty() {
            return;
        }
        let result = self.store.add_task(AddTask {
            title: title.trim().to_string(),
            memo: String::new(),
            project_id: view.add_to.project_id.clone(),
            to: view.add_to.to.clone(),
        });
        match result {
            Ok(done) => {
                self.last_added = done.ids.first().cloned();
                self.add_draft.clear();
                if let Some(input) = &mut self.adding {
                    input.clear();
                }
                self.fill_draft_from_queue();
            }
            Err(reason) => self.notify_failure(reason),
        }
    }

    /// 小さな追加欄から追加する。追加しても画面に出ないことがある（受信箱など）ので、追加したら知らせる
    pub fn quick_add(&mut self, title: &str, to: Destination, project_id: Option<String>) -> bool {
        let name = match &to {
            Destination::Inbox => "受信箱".to_string(),
            Destination::Today => "今日".to_string(),
            Destination::Later => "あとで".to_string(),
            Destination::Scheduled(on) if on.as_str() <= self.store.today.as_str() => {
                "今日".to_string()
            }
            Destination::Scheduled(on) => format_long_date(on, &self.store.today),
        };
        match self.store.add_task(AddTask {
            title: title.trim().to_string(),
            memo: String::new(),
            project_id,
            to,
        }) {
            Ok(_) => {
                self.toast_undo(&format!("{name}に追加しました"));
                self.reconcile();
                true
            }
            Err(reason) => {
                self.notify_failure(reason);
                false
            }
        }
    }
}
