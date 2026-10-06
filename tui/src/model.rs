//! タスクとプロジェクトの形と、Worker とやり取りする形（src/shared の model.ts・mutations.ts・api.ts と同じ約束）。
//! 日付は YYYY-MM-DD（論理日付）、時刻は ISO 8601 の UTC（ミリ秒まで）。空は None

use serde::{Deserialize, Serialize};

/// API の版。すべての呼び出しで X-Api-Version に付ける。Worker の値と違えば 409
pub const API_VERSION: u32 = 3;
pub const API_VERSION_HEADER: &str = "X-Api-Version";

/// 1つのまとまりに入れられる操作の数（Worker の上限）
pub const MAX_MUTATIONS_PER_BATCH: usize = 500;

/// タスクの置き場。必ず1つだけ持つ
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Bucket {
    Inbox,
    Today,
    Scheduled,
    Later,
}

impl Bucket {
    pub const ALL: [Bucket; 4] = [
        Bucket::Inbox,
        Bucket::Today,
        Bucket::Scheduled,
        Bucket::Later,
    ];
}

/// 優先度。高い順
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    High,
    Medium,
    Low,
}

impl Priority {
    pub const ALL: [Priority; 3] = [Priority::High, Priority::Medium, Priority::Low];

    pub fn label(self) -> &'static str {
        match self {
            Priority::High => "高",
            Priority::Medium => "中",
            Priority::Low => "低",
        }
    }

    /// 並べ替えの順（小さいほど上）
    pub fn order(self) -> usize {
        self as usize
    }
}

/// 工数（ポイント）。少ない順
pub const POINTS: [u8; 6] = [1, 2, 3, 5, 8, 13];

/// プロジェクトの色のパレット（名前だけを保存する。並びは変えない）
pub const PROJECT_COLORS: [&str; 8] = [
    "violet", "sky", "pink", "amber", "emerald", "orange", "teal", "slate",
];

/// 作成順で i 番目（0 始まり）のプロジェクトの色
pub fn auto_project_color(index: usize) -> &'static str {
    PROJECT_COLORS[index % PROJECT_COLORS.len()]
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistItem {
    pub id: String,
    pub title: String,
    pub done: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub title: String,
    pub memo: String,
    pub bucket: Bucket,
    /// 予定の日付。bucket が scheduled のときだけ入る
    pub scheduled_on: Option<String>,
    pub deadline_on: Option<String>,
    pub project_id: Option<String>,
    /// 置き場の中の並び順（rank.rs）
    pub rank: String,
    /// 日付の到来や締切で今日に入った日
    pub arrived_on: Option<String>,
    pub checklist: Vec<ChecklistItem>,
    /// 完了した時刻。完了しても bucket は変えない
    pub completed_at: Option<String>,
    /// 進行中にした時刻。入っているときは bucket が必ず today。完了しても残す
    pub started_at: Option<String>,
    pub priority: Option<Priority>,
    pub points: Option<u8>,
    pub created_at: String,
    pub updated_at: String,
    /// 削除した時刻（論理削除）
    pub deleted_at: Option<String>,
    /// 行を書き換えるたびに Worker が振る通し番号。まだ Worker にない行は 0
    pub seq: u64,
}

impl Task {
    pub fn is_completed(&self) -> bool {
        self.completed_at.is_some()
    }

    /// 進行中（startedAt があり、未完了）
    pub fn is_in_progress(&self) -> bool {
        self.started_at.is_some() && self.completed_at.is_none()
    }

    /// bucket が scheduled のときだけ scheduledOn が入る
    pub fn is_schedule_consistent(&self) -> bool {
        (self.bucket == Bucket::Scheduled) == self.scheduled_on.is_some()
    }

    /// startedAt が入っているなら bucket は today
    pub fn is_start_consistent(&self) -> bool {
        self.started_at.is_none() || self.bucket == Bucket::Today
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    /// パレットの色の名前。空なら作成順で決まる色を使う
    pub color: Option<String>,
    pub archived_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub seq: u64,
}

/// 差分の取得と操作の送信で返る行
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "row", rename_all = "lowercase")]
pub enum SyncRow {
    Task(Task),
    Project(Project),
}

#[cfg(test)]
impl SyncRow {
    pub fn seq(&self) -> u64 {
        match self {
            SyncRow::Task(task) => task.seq,
            SyncRow::Project(project) => project.seq,
        }
    }
}

// --- 操作（/api/mutate） -----------------------------------------------------------------

/// 変える項目だけを持つ形。項目ごとに「送らない（None）」と値を分ける。
/// 空にできる項目は `Option<Option<T>>`（`Some(None)` は null として送る）
macro_rules! changes_struct {
    ($(#[$meta:meta])* $name:ident for $target:ident { $($field:ident : $ty:ty),* $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Debug, Default, PartialEq, Serialize)]
        #[serde(rename_all = "camelCase")]
        pub struct $name {
            $( #[serde(skip_serializing_if = "Option::is_none")] pub $field: Option<$ty>, )*
        }

        impl $name {
            pub fn is_empty(&self) -> bool {
                true $( && self.$field.is_none() )*
            }

            /// 送る項目だけを差し替える
            pub fn apply_to(&self, target: &mut $target) {
                $( if let Some(value) = &self.$field { target.$field = value.clone(); } )*
            }

            /// 変える項目の、今の値（元に戻すための逆向きの変更）
            pub fn previous_in(&self, target: &$target) -> Self {
                Self { $( $field: self.$field.as_ref().map(|_| target.$field.clone()), )* }
            }

            /// 今と同じ値の項目を取り除く
            pub fn without_unchanged(mut self, target: &$target) -> Self {
                $( if self.$field.as_ref() == Some(&target.$field) { self.$field = None; } )*
                self
            }
        }
    };
}

changes_struct! {
    /// タスクの更新で変える項目
    TaskChanges for Task {
        title: String,
        memo: String,
        bucket: Bucket,
        scheduled_on: Option<String>,
        deadline_on: Option<String>,
        project_id: Option<String>,
        rank: String,
        arrived_on: Option<String>,
        checklist: Vec<ChecklistItem>,
        completed_at: Option<String>,
        started_at: Option<String>,
        priority: Option<Priority>,
        points: Option<u8>,
        deleted_at: Option<String>,
    }
}

changes_struct! {
    /// プロジェクトの更新で変える項目
    ProjectChanges for Project {
        name: String,
        color: Option<String>,
        archived_at: Option<String>,
        deleted_at: Option<String>,
    }
}

/// 作成するタスク。省いた項目は空（締切・チェックリスト・優先度・工数など）
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewTask {
    pub id: String,
    pub title: String,
    pub memo: String,
    pub bucket: Bucket,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_on: Option<String>,
    pub project_id: Option<String>,
    pub rank: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct NewProject {
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum Mutation {
    #[serde(rename = "task.create")]
    TaskCreate { task: NewTask },
    /// チェックリストは配列をまるごと置き換えるので、変える前の配列（baseChecklist）を添える。
    /// Worker は今の配列がそれと違えば、まとまりごと断る（checklist_conflict）
    #[serde(rename = "task.update")]
    TaskUpdate {
        id: String,
        changes: TaskChanges,
        #[serde(rename = "baseChecklist", skip_serializing_if = "Option::is_none")]
        base_checklist: Option<Vec<ChecklistItem>>,
    },
    #[serde(rename = "project.create")]
    ProjectCreate { project: NewProject },
    #[serde(rename = "project.update")]
    ProjectUpdate { id: String, changes: ProjectChanges },
}

/// 操作の対象の行
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RowKind {
    Task,
    Project,
}

impl Mutation {
    pub fn target(&self) -> (RowKind, &str) {
        match self {
            Mutation::TaskCreate { task } => (RowKind::Task, &task.id),
            Mutation::TaskUpdate { id, .. } => (RowKind::Task, id),
            Mutation::ProjectCreate { project } => (RowKind::Project, &project.id),
            Mutation::ProjectUpdate { id, .. } => (RowKind::Project, id),
        }
    }

    pub fn update_task(id: &str, changes: TaskChanges) -> Mutation {
        Mutation::TaskUpdate {
            id: id.to_string(),
            changes,
            base_checklist: None,
        }
    }
}

/// 操作のまとまり。id（UUIDv7）で再送を見分ける
#[derive(Clone, Debug, Serialize)]
pub struct MutationBatch {
    pub id: String,
    pub mutations: Vec<Mutation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncRequest {
    pub cursor: u64,
    pub base_cursor: u64,
}

/// POST /api/sync の応答。reset なら手元を捨てて最初から取り直す
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResponse {
    pub reset: bool,
    #[serde(default)]
    pub rows: Vec<SyncRow>,
    #[serde(default)]
    pub next_cursor: u64,
    #[serde(default)]
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize)]
pub struct MutateResponse {
    pub rows: Vec<SyncRow>,
}

/// 400 などの本文
#[derive(Clone, Debug, Default, Deserialize)]
pub struct ApiErrorBody {
    #[serde(default)]
    pub error: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn 更新は送る項目だけを_null_も含めて書き出す() {
        let mutation = Mutation::update_task(
            "t1",
            TaskChanges {
                bucket: Some(Bucket::Today),
                scheduled_on: Some(None),
                priority: Some(Some(Priority::High)),
                ..Default::default()
            },
        );
        assert_eq!(
            serde_json::to_value(&mutation).unwrap(),
            json!({
                "type": "task.update",
                "id": "t1",
                "changes": { "bucket": "today", "scheduledOn": null, "priority": "high" }
            })
        );
    }

    #[test]
    fn 作成は予定の日付を省ける() {
        let mutation = Mutation::TaskCreate {
            task: NewTask {
                id: "t1".into(),
                title: "見積もり".into(),
                memo: String::new(),
                bucket: Bucket::Inbox,
                scheduled_on: None,
                project_id: None,
                rank: "a0".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(&mutation).unwrap(),
            json!({
                "type": "task.create",
                "task": { "id": "t1", "title": "見積もり", "memo": "", "bucket": "inbox", "projectId": null, "rank": "a0" }
            })
        );
    }

    #[test]
    fn 行を読める() {
        let row: SyncRow = serde_json::from_value(json!({
            "kind": "project",
            "row": { "id": "p1", "name": "家", "color": null, "archivedAt": null,
                     "createdAt": "2026-10-01T00:00:00.000Z", "updatedAt": "2026-10-01T00:00:00.000Z",
                     "deletedAt": null, "seq": 3 }
        }))
        .unwrap();
        assert_eq!(row.seq(), 3);
        let reset: SyncResponse = serde_json::from_value(json!({ "reset": true })).unwrap();
        assert!(reset.reset);
    }
}
