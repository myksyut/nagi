//! 各リストの中身と並び。手元の写しから計算する値で、写しか今日の日付が変わったときだけ計算し直す（store.lists()）

use std::collections::HashMap;

use chrono_tz::Tz;

use super::replica::{Partition, Replica, partition_of};
use crate::dates::{add_days, day_start, iso, logical_date, parse_iso};
use crate::model::{Bucket, Project, Task, auto_project_color};

/// 完了ログの1日ぶん
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LogbookDay {
    pub date: String,
    pub tasks: Vec<String>,
}

/// プロジェクトの画面：未完了を置き場ごとに、完了済み（全期間。新しい順）を最後に
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProjectGroups {
    pub today: Vec<String>,
    pub scheduled: Vec<String>,
    pub later: Vec<String>,
    pub inbox: Vec<String>,
    pub completed: Vec<String>,
}

impl ProjectGroups {
    /// 未完了のタスクの数（アーカイブできるかの確認に使う）
    pub fn open_count(&self) -> usize {
        self.today.len() + self.scheduled.len() + self.later.len() + self.inbox.len()
    }

    pub fn open_ids(&self) -> impl Iterator<Item = &String> {
        self.today
            .iter()
            .chain(&self.scheduled)
            .chain(&self.later)
            .chain(&self.inbox)
    }
}

/// プロジェクトのボードの完了の列に出す日数（今日を含む。それより前は完了ログで見る）
pub const PROJECT_BOARD_COMPLETED_DAYS: i64 = 7;

#[derive(Clone, Debug, Default)]
pub struct Lists {
    /// 受信箱：古い順
    pub inbox: Vec<String>,
    /// 今日：並び順キーの順
    pub today: Vec<String>,
    /// 予定：日付の順
    pub scheduled: Vec<String>,
    /// あとで：並び順キーの順
    pub later: Vec<String>,
    /// 今日の「完了 N件」：今日（論理日付）完了したもの。新しい順
    pub completed_today: Vec<String>,
    /// 完了ログ：昨日までに完了したものを、完了した日ごとに新しい順で
    pub logbook: Vec<LogbookDay>,
    /// サイドバーと p の候補に出すプロジェクト（アーカイブ済み・削除済みを除く）。作成順
    pub projects: Vec<String>,
    /// 各プロジェクトの色（パレットの名前）。削除済みのプロジェクトは入らない
    pub project_colors: HashMap<String, &'static str>,
    by_project: HashMap<String, ProjectGroups>,
    /// プロジェクトのボードの完了の列の区切り（これ以降に完了したものを出す）
    board_completed_since: String,
}

static EMPTY_GROUPS: ProjectGroups = ProjectGroups {
    today: Vec::new(),
    scheduled: Vec::new(),
    later: Vec::new(),
    inbox: Vec::new(),
    completed: Vec::new(),
};

fn by_created(a: &Task, b: &Task) -> std::cmp::Ordering {
    a.created_at
        .cmp(&b.created_at)
        .then_with(|| a.id.cmp(&b.id))
}

fn by_rank(a: &Task, b: &Task) -> std::cmp::Ordering {
    a.rank.cmp(&b.rank).then_with(|| a.id.cmp(&b.id))
}

fn by_schedule(a: &Task, b: &Task) -> std::cmp::Ordering {
    a.scheduled_on
        .cmp(&b.scheduled_on)
        .then_with(|| by_rank(a, b))
}

fn by_completed_desc(a: &Task, b: &Task) -> std::cmp::Ordering {
    b.completed_at
        .cmp(&a.completed_at)
        .then_with(|| b.id.cmp(&a.id))
}

fn bucket_order(bucket: Bucket) -> fn(&Task, &Task) -> std::cmp::Ordering {
    match bucket {
        Bucket::Inbox => by_created,
        Bucket::Today | Bucket::Later => by_rank,
        Bucket::Scheduled => by_schedule,
    }
}

fn ids(tasks: &[&Task]) -> Vec<String> {
    tasks.iter().map(|task| task.id.clone()).collect()
}

/// 削除済みを除くプロジェクトを、作成の時刻の順（同じなら id の順）に並べる
fn order_for_auto_color<'a>(projects: impl Iterator<Item = &'a Project>) -> Vec<&'a Project> {
    let mut ordered: Vec<&Project> = projects.filter(|p| p.deleted_at.is_none()).collect();
    ordered.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    ordered
}

impl Lists {
    pub fn compute(replica: &Replica, today: &str, tz: Tz) -> Lists {
        let starts_at = iso(day_start(today, tz));
        let mut open: HashMap<Bucket, Vec<&Task>> = HashMap::new();
        let mut completed: Vec<&Task> = Vec::new();
        for task in replica.tasks() {
            match partition_of(task) {
                Partition::Open(bucket) => open.entry(bucket).or_default().push(task),
                Partition::Completed => completed.push(task),
                Partition::Deleted => {}
            }
        }
        for (bucket, tasks) in &mut open {
            tasks.sort_by(|a, b| bucket_order(*bucket)(a, b));
        }
        completed.sort_by(|a, b| by_completed_desc(a, b));

        let mut by_project: HashMap<String, ProjectGroups> = HashMap::new();
        for bucket in Bucket::ALL {
            for task in open.get(&bucket).map_or(&[][..], Vec::as_slice) {
                let Some(project_id) = &task.project_id else {
                    continue;
                };
                let groups = by_project.entry(project_id.clone()).or_default();
                match bucket {
                    Bucket::Inbox => groups.inbox.push(task.id.clone()),
                    Bucket::Today => groups.today.push(task.id.clone()),
                    Bucket::Scheduled => groups.scheduled.push(task.id.clone()),
                    Bucket::Later => groups.later.push(task.id.clone()),
                }
            }
        }

        // 完了済み（新しい順）を、今日の「完了 N件」と、完了した日ごとの完了ログに分ける
        let mut completed_today = Vec::new();
        let mut logbook: Vec<LogbookDay> = Vec::new();
        let mut current_starts_at = String::new();
        for task in &completed {
            if let Some(project_id) = &task.project_id {
                by_project
                    .entry(project_id.clone())
                    .or_default()
                    .completed
                    .push(task.id.clone());
            }
            let completed_at = task.completed_at.as_deref().unwrap_or("");
            if completed_at >= starts_at.as_str() {
                completed_today.push(task.id.clone());
                continue;
            }
            if logbook.is_empty() || completed_at < current_starts_at.as_str() {
                let date = parse_iso(completed_at)
                    .map(|time| logical_date(time, tz))
                    .unwrap_or_default();
                current_starts_at = iso(day_start(&date, tz));
                logbook.push(LogbookDay {
                    date,
                    tasks: Vec::new(),
                });
            }
            if let Some(day) = logbook.last_mut() {
                day.tasks.push(task.id.clone());
            }
        }

        let ordered = order_for_auto_color(replica.projects());
        let project_colors = ordered
            .iter()
            .enumerate()
            .map(|(i, project)| {
                let chosen = project.color.as_deref().and_then(|name| {
                    crate::model::PROJECT_COLORS
                        .iter()
                        .find(|color| **color == name)
                        .copied()
                });
                (project.id.clone(), chosen.unwrap_or(auto_project_color(i)))
            })
            .collect();
        let projects = ordered
            .iter()
            .filter(|project| project.archived_at.is_none())
            .map(|project| project.id.clone())
            .collect();

        let list = |bucket: Bucket| ids(open.get(&bucket).map_or(&[][..], Vec::as_slice));
        Lists {
            inbox: list(Bucket::Inbox),
            today: list(Bucket::Today),
            scheduled: list(Bucket::Scheduled),
            later: list(Bucket::Later),
            completed_today,
            logbook,
            projects,
            project_colors,
            by_project,
            board_completed_since: iso(day_start(
                &add_days(today, -(PROJECT_BOARD_COMPLETED_DAYS - 1)),
                tz,
            )),
        }
    }

    /// プロジェクトの画面のタスク
    pub fn project(&self, project_id: &str) -> &ProjectGroups {
        self.by_project.get(project_id).unwrap_or(&EMPTY_GROUPS)
    }

    /// プロジェクトの色（パレットの名前）。削除済みか、ないプロジェクトなら None
    pub fn project_color(&self, project_id: &str) -> Option<&'static str> {
        self.project_colors.get(project_id).copied()
    }

    /// プロジェクトのボードの完了の列：直近 7 日（論理日付で今日を含む）に完了したもの（新しい順）
    pub fn project_board_completed(&self, replica: &Replica, project_id: &str) -> Vec<String> {
        self.project(project_id)
            .completed
            .iter()
            .filter(|id| {
                replica
                    .task(id)
                    .and_then(|task| task.completed_at.as_deref())
                    .is_some_and(|at| at >= self.board_completed_since.as_str())
            })
            .cloned()
            .collect()
    }
}

/// 行を、未着手と進行中に分ける（並びは保つ）
pub fn split_by_started(replica: &Replica, ids: &[String]) -> (Vec<String>, Vec<String>) {
    ids.iter().cloned().partition(|id| {
        replica
            .task(id)
            .is_none_or(|task| task.started_at.is_none())
    })
}

/// 工数の合計。工数のないタスクは数えない
pub fn sum_points<'a>(replica: &Replica, ids: impl IntoIterator<Item = &'a String>) -> u32 {
    ids.into_iter()
        .filter_map(|id| replica.task(id)?.points)
        .map(u32::from)
        .sum()
}
