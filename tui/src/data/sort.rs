//! 一覧の並び方（今日・あとで・プロジェクト・ボード）。並べ替えは表示だけで、rank は書き換えない
//! - 手動：渡された並びのまま（各一覧の並び順キーの順）
//! - 優先度：高・中・低・なしの順
//! - 工数が少ない順・多い順：工数のないタスクはどちらの向きでも最後
//!
//! どれも、同じ値の中は渡された並び（手動の順）のまま

use super::replica::Replica;
use crate::model::Priority;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TaskSort {
    #[default]
    Manual,
    Priority,
    PointsAsc,
    PointsDesc,
}

impl TaskSort {
    pub const ALL: [TaskSort; 4] = [
        TaskSort::Manual,
        TaskSort::Priority,
        TaskSort::PointsAsc,
        TaskSort::PointsDesc,
    ];

    pub fn label(self) -> &'static str {
        match self {
            TaskSort::Manual => "手動",
            TaskSort::Priority => "優先度",
            TaskSort::PointsAsc => "工数が少ない順",
            TaskSort::PointsDesc => "工数が多い順",
        }
    }

    /// 設定ファイルに残す名前
    pub fn key(self) -> &'static str {
        match self {
            TaskSort::Manual => "manual",
            TaskSort::Priority => "priority",
            TaskSort::PointsAsc => "points-asc",
            TaskSort::PointsDesc => "points-desc",
        }
    }

    pub fn from_key(key: &str) -> Option<TaskSort> {
        TaskSort::ALL.into_iter().find(|sort| sort.key() == key)
    }
}

/// 小さいほど上。値のないものは一番下
fn sort_key(priority: Option<Priority>, points: Option<u8>, sort: TaskSort) -> i32 {
    match sort {
        TaskSort::Manual => 0,
        TaskSort::Priority => priority.map_or(Priority::ALL.len(), Priority::order) as i32,
        TaskSort::PointsAsc => points.map_or(i32::MAX, i32::from),
        TaskSort::PointsDesc => points.map_or(i32::MAX, |points| -i32::from(points)),
    }
}

/// 並んだ行（各一覧の今の並び）を sort の並び方で並べ替える。同じ値の中は元の並びを保つ
pub fn sort_tasks(replica: &Replica, ids: Vec<String>, sort: TaskSort) -> Vec<String> {
    if sort == TaskSort::Manual {
        return ids;
    }
    let mut keyed: Vec<(i32, String)> = ids
        .into_iter()
        .map(|id| {
            let key = replica
                .task(&id)
                .map_or(i32::MAX, |task| sort_key(task.priority, task.points, sort));
            (key, id)
        })
        .collect();
    // sort_by_key は安定（同じ値の中は元の並びのまま）
    keyed.sort_by_key(|(key, _)| *key);
    keyed.into_iter().map(|(_, id)| id).collect()
}
