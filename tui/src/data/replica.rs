//! 手元の写し。確定データ（Worker で保存済みの行）と送信中の操作を持ち、画面にはその2つを重ねた行を出す。
//! 送信中の操作を外せば、その行は確定データの内容に戻る。
//! 確定データに取り込むのは、手元より seq が新しい行だけ。削除済みの行も確定データには残す
//! （遅れて届いた古い版を seq で退けるため）。リストの計算で削除済みを外す

use std::collections::{HashMap, HashSet};

use crate::model::{Bucket, Mutation, Project, RowKind, SyncRow, Task};

/// 画面から呼ぶ操作の種類（知らせと、元に戻すの表示に使う）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OperationKind {
    TaskAdd,
    TaskUpdate,
    TaskComplete,
    TaskUncomplete,
    TaskStart,
    TaskStop,
    TaskMove,
    TaskReorder,
    TaskDeadline,
    TaskPriority,
    TaskPoints,
    TaskDelete,
    ProjectCreate,
    ProjectUpdate,
    Undo,
}

/// 送信中の操作のまとまり（1つのリクエスト。1回のユーザー操作が1つのまとまり）
#[derive(Clone, Debug)]
pub struct PendingBatch {
    /// まとまりの ID（UUIDv7）。再送でも同じ ID を使う。操作の ID も兼ねる
    pub id: String,
    pub mutations: Vec<Mutation>,
    /// 操作した時刻（ISO 8601）。作成を送信中の行の、仮の createdAt・updatedAt に使う
    pub at: String,
    pub kind: OperationKind,
}

/// タスクの置き場の区分。未完了は置き場ごと、完了済みと削除済みはそれぞれ1つにまとめる
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Partition {
    Open(Bucket),
    Completed,
    Deleted,
}

pub fn partition_of(task: &Task) -> Partition {
    if task.deleted_at.is_some() {
        Partition::Deleted
    } else if task.completed_at.is_some() {
        Partition::Completed
    } else {
        Partition::Open(task.bucket)
    }
}

/// タスクに操作を1つ重ねる。at は操作した時刻。対象の行がない更新は何もしない
pub fn apply_task_mutation(base: Option<Task>, mutation: &Mutation, at: &str) -> Option<Task> {
    match mutation {
        Mutation::TaskUpdate { changes, .. } => base.map(|mut task| {
            changes.apply_to(&mut task);
            task
        }),
        Mutation::TaskCreate { task } => {
            // 応答より先に、差分の取得で確定した行が届いていたら、その上に重ねる
            let mut next = base.unwrap_or_else(|| Task {
                id: task.id.clone(),
                title: String::new(),
                memo: String::new(),
                bucket: task.bucket,
                scheduled_on: None,
                deadline_on: None,
                project_id: None,
                rank: String::new(),
                arrived_on: None,
                checklist: Vec::new(),
                completed_at: None,
                started_at: None,
                priority: None,
                points: None,
                created_at: at.to_string(),
                updated_at: at.to_string(),
                deleted_at: None,
                seq: 0,
            });
            next.title = task.title.clone();
            next.memo = task.memo.clone();
            next.bucket = task.bucket;
            next.scheduled_on = task.scheduled_on.clone();
            next.deadline_on = None;
            next.project_id = task.project_id.clone();
            next.rank = task.rank.clone();
            next.arrived_on = None;
            next.checklist = Vec::new();
            next.priority = None;
            next.points = None;
            Some(next)
        }
        _ => base,
    }
}

pub fn apply_project_mutation(
    base: Option<Project>,
    mutation: &Mutation,
    at: &str,
) -> Option<Project> {
    match mutation {
        Mutation::ProjectUpdate { changes, .. } => base.map(|mut project| {
            changes.apply_to(&mut project);
            project
        }),
        Mutation::ProjectCreate { project } => {
            let mut next = base.unwrap_or_else(|| Project {
                id: project.id.clone(),
                name: String::new(),
                color: None,
                archived_at: None,
                created_at: at.to_string(),
                updated_at: at.to_string(),
                deleted_at: None,
                seq: 0,
            });
            next.name = project.name.clone();
            next.color = None;
            Some(next)
        }
        _ => base,
    }
}

#[derive(Default)]
pub struct Replica {
    confirmed_tasks: HashMap<String, Task>,
    confirmed_projects: HashMap<String, Project>,
    tasks: HashMap<String, Task>,
    projects: HashMap<String, Project>,
    pending: Vec<PendingBatch>,
    /// 画面に出す行が変わるたびに進む（リストの計算をやり直す目印）
    version: u64,
}

impl Replica {
    /// 画面に出すタスク（削除済みも含む）
    pub fn task(&self, id: &str) -> Option<&Task> {
        self.tasks.get(id)
    }

    pub fn project(&self, id: &str) -> Option<&Project> {
        self.projects.get(id)
    }

    /// 画面に出すすべてのタスク（削除済み・完了済みも含む。並びは決めない）
    pub fn tasks(&self) -> impl Iterator<Item = &Task> {
        self.tasks.values()
    }

    /// すべてのプロジェクト（削除済み・アーカイブ済みも含む。並びは決めない）
    pub fn projects(&self) -> impl Iterator<Item = &Project> {
        self.projects.values()
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// 確定データのうち、cutoff（ISO 8601）より前に削除された行
    pub fn expired_deleted(&self, cutoff: &str) -> (Vec<String>, Vec<String>) {
        let expired =
            |deleted_at: &Option<String>| deleted_at.as_deref().is_some_and(|at| at < cutoff);
        (
            self.confirmed_tasks
                .values()
                .filter(|row| expired(&row.deleted_at))
                .map(|row| row.id.clone())
                .collect(),
            self.confirmed_projects
                .values()
                .filter(|row| expired(&row.deleted_at))
                .map(|row| row.id.clone())
                .collect(),
        )
    }

    /// 送信中のまとまり（送る順）
    pub fn pending(&self) -> &[PendingBatch] {
        &self.pending
    }

    /// 確定データを rows で置き換える（起動時の読み込みと、全件の取り直しのあと）。seq は比べない。
    /// 送信中の操作はそのまま重ねる
    pub fn replace_confirmed(&mut self, rows: Vec<SyncRow>) {
        let mut task_ids: HashSet<String> = self.confirmed_tasks.keys().cloned().collect();
        let mut project_ids: HashSet<String> = self.confirmed_projects.keys().cloned().collect();
        self.confirmed_tasks.clear();
        self.confirmed_projects.clear();
        for row in rows {
            match row {
                SyncRow::Task(task) => {
                    task_ids.insert(task.id.clone());
                    self.confirmed_tasks.insert(task.id.clone(), task);
                }
                SyncRow::Project(project) => {
                    project_ids.insert(project.id.clone());
                    self.confirmed_projects.insert(project.id.clone(), project);
                }
            }
        }
        self.rematerialize(&task_ids, &project_ids);
    }

    /// 手元より seq が新しい行だけを確定データに取り込む。取り込んだ行を返す
    pub fn merge_confirmed(&mut self, rows: &[SyncRow]) -> Vec<SyncRow> {
        let accepted = self.merge(rows);
        self.rematerialize_rows(&[], &accepted);
        accepted
    }

    /// 確定データから行を捨てる（削除から 30 日たった行）。送信中の操作は重ねたまま
    pub fn drop_confirmed(&mut self, task_ids: &[String], project_ids: &[String]) {
        for id in task_ids {
            self.confirmed_tasks.remove(id);
        }
        for id in project_ids {
            self.confirmed_projects.remove(id);
        }
        self.rematerialize(
            &task_ids.iter().cloned().collect(),
            &project_ids.iter().cloned().collect(),
        );
    }

    /// 送信中のまとまりを後ろに積む（画面にはすぐ重ねて出る）
    pub fn add_pending(&mut self, batch: PendingBatch) {
        self.pending.push(batch);
        let last = self.pending.len() - 1;
        let batches = [self.pending[last].clone()];
        self.rematerialize_rows(&batches, &[]);
    }

    /// 送信に成功したまとまりを外し、確定した行を取り込む（1回の更新で行うので、表示はちらつかない）。
    /// 外したまとまりと、取り込んだ行を返す
    pub fn confirm_batch(
        &mut self,
        batch_id: &str,
        rows: &[SyncRow],
    ) -> (Option<PendingBatch>, Vec<SyncRow>) {
        let batch = self
            .pending
            .iter()
            .position(|batch| batch.id == batch_id)
            .map(|index| self.pending.remove(index));
        let accepted = self.merge(rows);
        self.rematerialize_rows(batch.as_slice(), rows);
        (batch, accepted)
    }

    /// 送信中のまとまりをすべて捨てる（表示はその操作の前に戻る）。捨てたまとまりを返す
    pub fn discard_pending(&mut self) -> Vec<PendingBatch> {
        let batches = std::mem::take(&mut self.pending);
        self.rematerialize_rows(&batches, &[]);
        batches
    }

    fn merge(&mut self, rows: &[SyncRow]) -> Vec<SyncRow> {
        let mut accepted = Vec::new();
        for row in rows {
            let newer = match row {
                SyncRow::Task(task) => {
                    let newer = self
                        .confirmed_tasks
                        .get(&task.id)
                        .is_none_or(|current| current.seq < task.seq);
                    if newer {
                        self.confirmed_tasks.insert(task.id.clone(), task.clone());
                    }
                    newer
                }
                SyncRow::Project(project) => {
                    let newer = self
                        .confirmed_projects
                        .get(&project.id)
                        .is_none_or(|current| current.seq < project.seq);
                    if newer {
                        self.confirmed_projects
                            .insert(project.id.clone(), project.clone());
                    }
                    newer
                }
            };
            if newer {
                accepted.push(row.clone());
            }
        }
        accepted
    }

    fn rematerialize_rows(&mut self, batches: &[PendingBatch], rows: &[SyncRow]) {
        let mut task_ids = HashSet::new();
        let mut project_ids = HashSet::new();
        for batch in batches {
            for mutation in &batch.mutations {
                let (kind, id) = mutation.target();
                match kind {
                    RowKind::Task => task_ids.insert(id.to_string()),
                    RowKind::Project => project_ids.insert(id.to_string()),
                };
            }
        }
        for row in rows {
            match row {
                SyncRow::Task(task) => task_ids.insert(task.id.clone()),
                SyncRow::Project(project) => project_ids.insert(project.id.clone()),
            };
        }
        self.rematerialize(&task_ids, &project_ids);
    }

    /// 指定した行を、確定データに送信中の操作を重ねて作り直す
    fn rematerialize(&mut self, task_ids: &HashSet<String>, project_ids: &HashSet<String>) {
        if task_ids.is_empty() && project_ids.is_empty() {
            return;
        }
        let mut tasks: HashMap<&str, Option<Task>> = task_ids
            .iter()
            .map(|id| (id.as_str(), self.confirmed_tasks.get(id).cloned()))
            .collect();
        let mut projects: HashMap<&str, Option<Project>> = project_ids
            .iter()
            .map(|id| (id.as_str(), self.confirmed_projects.get(id).cloned()))
            .collect();
        for batch in &self.pending {
            for mutation in &batch.mutations {
                match mutation.target() {
                    (RowKind::Task, id) => {
                        if let Some(value) = tasks.get_mut(id) {
                            *value = apply_task_mutation(value.take(), mutation, &batch.at);
                        }
                    }
                    (RowKind::Project, id) => {
                        if let Some(value) = projects.get_mut(id) {
                            *value = apply_project_mutation(value.take(), mutation, &batch.at);
                        }
                    }
                }
            }
        }
        for (id, value) in tasks {
            match value {
                Some(task) => self.tasks.insert(id.to_string(), task),
                None => self.tasks.remove(id),
            };
        }
        for (id, value) in projects {
            match value {
                Some(project) => self.projects.insert(id.to_string(), project),
                None => self.projects.remove(id),
            };
        }
        self.version += 1;
    }
}
