//! 元に戻す。1回のユーザー操作ごとに、逆向きの操作のまとまりを1つ作って積む。
//! - 作成の逆は削除（deletedAt を入れる）、削除の逆は deletedAt を消す更新、更新の逆は変える前の値への更新
//! - まとめて操作した3件は、1回でまとめて戻る
//! - 逆向きの操作は、操作した時点の表示（確定データ＋送信中の操作）から作る

use std::collections::{HashMap, HashSet};

use super::replica::{PendingBatch, apply_project_mutation, apply_task_mutation};
use crate::model::{ChecklistItem, Mutation, Project, ProjectChanges, Task, TaskChanges};

/// チェックリストの操作（チェック・追加・削除・並べ替え）を戻したあとのチェックリスト。
/// 操作の前の並びとチェックに戻しつつ、操作のあとで変わった文字とチェックは今の値を残す。
/// 操作のあとで足された項目は残し、消された項目は消したまま
pub fn revert_checklist(
    before: &[ChecklistItem],
    after: &[ChecklistItem],
    current: &[ChecklistItem],
) -> Vec<ChecklistItem> {
    let after_by_id: HashMap<&str, &ChecklistItem> =
        after.iter().map(|item| (item.id.as_str(), item)).collect();
    let current_by_id: HashMap<&str, &ChecklistItem> = current
        .iter()
        .map(|item| (item.id.as_str(), item))
        .collect();
    let before_ids: HashSet<&str> = before.iter().map(|item| item.id.as_str()).collect();
    let mut reverted = Vec::new();
    for item in before {
        match (
            after_by_id.get(item.id.as_str()),
            current_by_id.get(item.id.as_str()),
        ) {
            // 操作で消した項目は戻す
            (None, _) => reverted.push(item.clone()),
            (Some(was), Some(now)) => reverted.push(ChecklistItem {
                id: item.id.clone(),
                title: if now.title != was.title {
                    now.title.clone()
                } else {
                    item.title.clone()
                },
                done: if now.done != was.done {
                    now.done
                } else {
                    item.done
                },
            }),
            (Some(_), None) => {}
        }
    }
    for item in current {
        if !before_ids.contains(item.id.as_str()) && !after_by_id.contains_key(item.id.as_str()) {
            reverted.push(item.clone());
        }
    }
    reverted
}

/// 逆向きの操作の1つぶん（戻すときに操作へ直す）
#[derive(Clone, Debug)]
enum InverseStep {
    DeleteTask {
        id: String,
    },
    DeleteProject {
        id: String,
    },
    UpdateTask {
        id: String,
        previous: Box<TaskChanges>,
        /// チェックリストを変えた操作の、変える前とあとの配列
        checklist: Option<(Vec<ChecklistItem>, Vec<ChecklistItem>)>,
    },
    UpdateProject {
        id: String,
        previous: ProjectChanges,
    },
}

#[derive(Clone, Debug)]
pub struct UndoEntry {
    pub operation_id: String,
    /// 逆向きの操作（戻す順）
    steps: Vec<InverseStep>,
}

impl UndoEntry {
    /// 操作の逆向きを作る。操作を順にたどって行の状態を進めながら、各操作の逆を作り、逆の順に並べる
    /// （同じまとまりで作ったプロジェクトをタスクに付けた、などの順序を逆にたどれるように）
    pub fn build(
        operation_id: &str,
        mutations: &[Mutation],
        read_task: impl Fn(&str) -> Option<Task>,
        read_project: impl Fn(&str) -> Option<Project>,
    ) -> UndoEntry {
        let mut tasks: HashMap<String, Option<Task>> = HashMap::new();
        let mut projects: HashMap<String, Option<Project>> = HashMap::new();
        let mut steps = Vec::new();
        for mutation in mutations {
            match mutation {
                Mutation::TaskCreate { task } => {
                    let now = tasks
                        .remove(&task.id)
                        .unwrap_or_else(|| read_task(&task.id));
                    steps.push(InverseStep::DeleteTask {
                        id: task.id.clone(),
                    });
                    tasks.insert(task.id.clone(), apply_task_mutation(now, mutation, ""));
                }
                Mutation::TaskUpdate { id, changes, .. } => {
                    let before = tasks.remove(id).unwrap_or_else(|| read_task(id));
                    let after = apply_task_mutation(before.clone(), mutation, "");
                    if let (Some(before), Some(after)) = (&before, &after) {
                        steps.push(InverseStep::UpdateTask {
                            id: id.clone(),
                            previous: Box::new(changes.previous_in(before)),
                            checklist: changes
                                .checklist
                                .as_ref()
                                .map(|_| (before.checklist.clone(), after.checklist.clone())),
                        });
                    }
                    tasks.insert(id.clone(), after);
                }
                Mutation::ProjectCreate { project } => {
                    let now = projects
                        .remove(&project.id)
                        .unwrap_or_else(|| read_project(&project.id));
                    steps.push(InverseStep::DeleteProject {
                        id: project.id.clone(),
                    });
                    projects.insert(
                        project.id.clone(),
                        apply_project_mutation(now, mutation, ""),
                    );
                }
                Mutation::ProjectUpdate { id, changes } => {
                    let before = projects.remove(id).unwrap_or_else(|| read_project(id));
                    if let Some(before) = &before {
                        steps.push(InverseStep::UpdateProject {
                            id: id.clone(),
                            previous: changes.previous_in(before),
                        });
                    }
                    projects.insert(id.clone(), apply_project_mutation(before, mutation, ""));
                }
            }
        }
        steps.reverse();
        UndoEntry {
            operation_id: operation_id.to_string(),
            steps,
        }
    }

    /// 逆向きの操作。at は元に戻す時刻（作成の逆の deletedAt に使う）。
    /// チェックリストは、戻すときの今の中身と合わせ（revert_checklist）、今の配列を添える
    pub fn mutations(
        &self,
        at: &str,
        current_checklist: impl Fn(&str) -> Option<Vec<ChecklistItem>>,
    ) -> Vec<Mutation> {
        self.steps
            .iter()
            .map(|step| match step {
                InverseStep::DeleteTask { id } => Mutation::update_task(
                    id,
                    TaskChanges {
                        deleted_at: Some(Some(at.to_string())),
                        ..Default::default()
                    },
                ),
                InverseStep::DeleteProject { id } => Mutation::ProjectUpdate {
                    id: id.clone(),
                    changes: ProjectChanges {
                        deleted_at: Some(Some(at.to_string())),
                        ..Default::default()
                    },
                },
                InverseStep::UpdateTask {
                    id,
                    previous,
                    checklist,
                } => {
                    let current = checklist.as_ref().and_then(|_| current_checklist(id));
                    match (checklist, current) {
                        (Some((before, after)), Some(current)) => Mutation::TaskUpdate {
                            id: id.clone(),
                            changes: TaskChanges {
                                checklist: Some(revert_checklist(before, after, &current)),
                                ..previous.as_ref().clone()
                            },
                            base_checklist: Some(current),
                        },
                        _ => Mutation::update_task(id, previous.as_ref().clone()),
                    }
                }
                InverseStep::UpdateProject { id, previous } => Mutation::ProjectUpdate {
                    id: id.clone(),
                    changes: previous.clone(),
                },
            })
            .collect()
    }
}

/// 覚えておく操作の数
pub const UNDO_LIMIT: usize = 100;

#[derive(Default)]
pub struct UndoStack {
    entries: Vec<UndoEntry>,
    /// 送信中の「元に戻す」操作の ID → 戻した元の操作（失敗したら積み直す）
    undoing: HashMap<String, UndoEntry>,
}

impl UndoStack {
    pub fn can_undo(&self) -> bool {
        !self.entries.is_empty()
    }

    pub fn push(&mut self, entry: UndoEntry) {
        self.entries.push(entry);
        if self.entries.len() > UNDO_LIMIT {
            self.entries.remove(0);
        }
    }

    pub fn pop(&mut self) -> Option<UndoEntry> {
        self.entries.pop()
    }

    /// entry を元に戻す操作（operation_id）を送り始めた
    pub fn undoing(&mut self, operation_id: &str, entry: UndoEntry) {
        self.undoing.insert(operation_id.to_string(), entry);
    }

    /// まとまりが確定した
    pub fn confirmed(&mut self, batch: &PendingBatch) {
        self.undoing.remove(&batch.id);
    }

    /// まとまりが捨てられた。その操作は元に戻す対象から外す。
    /// 捨てられたのが「元に戻す」操作で、restore_undone（通信の失敗）なら、戻そうとした元の操作を積み直す
    /// （もう一度戻せるように）。400 などで捨てられたときは、同じ操作がまた失敗するので積み直さない
    pub fn discarded(&mut self, batches: &[PendingBatch], restore_undone: bool) {
        let operation_ids: HashSet<&str> = batches.iter().map(|batch| batch.id.as_str()).collect();
        self.entries
            .retain(|entry| !operation_ids.contains(entry.operation_id.as_str()));
        for batch in batches {
            if let Some(original) = self.undoing.remove(&batch.id)
                && restore_undone
                && !operation_ids.contains(original.operation_id.as_str())
            {
                self.entries.push(original);
            }
        }
        if self.entries.len() > UNDO_LIMIT {
            let extra = self.entries.len() - UNDO_LIMIT;
            self.entries.drain(..extra);
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.undoing.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, title: &str, done: bool) -> ChecklistItem {
        ChecklistItem {
            id: id.into(),
            title: title.into(),
            done,
        }
    }

    #[test]
    fn チェックを戻しても_あとから直した文字は残す() {
        let before = [item("a", "牛乳", false), item("b", "卵", false)];
        let after = [item("a", "牛乳", true), item("b", "卵", false)];
        // 操作のあとで b の文字を直し、c を足した
        let current = [
            item("a", "牛乳", true),
            item("b", "卵を1パック", false),
            item("c", "パン", false),
        ];
        assert_eq!(
            revert_checklist(&before, &after, &current),
            vec![
                item("a", "牛乳", false),
                item("b", "卵を1パック", false),
                item("c", "パン", false)
            ]
        );
    }

    #[test]
    fn 消した項目は戻し_あとから消された項目は消したまま() {
        let before = [item("a", "A", false), item("b", "B", false)];
        let after = [item("b", "B", false)];
        let current: [ChecklistItem; 0] = [];
        assert_eq!(
            revert_checklist(&before, &after, &current),
            vec![item("a", "A", false)]
        );
    }
}
