//! カレンダーとタイムラインの中身の計算

use std::collections::HashMap;

use crate::data::Store;
use crate::dates::{add_days, add_months, days_between, weekday_index};
use crate::model::{Bucket, Task};

/// 絞り込み：すべて・プロジェクトなし・1つのプロジェクト
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProjectFilter {
    All,
    None,
    Project(String),
}

impl ProjectFilter {
    pub fn matches(&self, task: &Task) -> bool {
        match self {
            ProjectFilter::All => true,
            ProjectFilter::None => task.project_id.is_none(),
            ProjectFilter::Project(id) => task.project_id.as_deref() == Some(id),
        }
    }

    /// 追加したタスクに付けるプロジェクト（絞り込んでいるプロジェクトがあれば）
    pub fn project_id(&self) -> Option<String> {
        match self {
            ProjectFilter::Project(id) => Some(id.clone()),
            _ => None,
        }
    }
}

// --- カレンダー -------------------------------------------------------------------------

/// マスに出す1つ：タスク（予定の日付を変える）か締切の◆（締切を変える）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CalendarEntry {
    pub task_id: String,
    pub deadline: bool,
}

/// 日付ごとの中身（出すものがない日は入らない）。
/// - タスク：予定のタスクは予定の日付のマス、今日のタスク（未完了。進行中を含む）は今日のマス
/// - 締切の◆：未完了のタスク（今日・予定・あとで・受信箱）の締切の日のマス
/// - マスの中は、締切の◆が先、そのあとにタスク（今日は今日の並び、予定は並び順キーの順）
pub fn calendar_entries(
    store: &Store,
    filter: &ProjectFilter,
) -> HashMap<String, Vec<CalendarEntry>> {
    let lists = store.lists();
    let replica = &store.replica;
    let mut days: HashMap<String, Vec<CalendarEntry>> = HashMap::new();
    let matching = |id: &String| replica.task(id).filter(|task| filter.matches(task));
    for rows in [&lists.today, &lists.scheduled, &lists.later, &lists.inbox] {
        for id in rows {
            if let Some(task) = matching(id)
                && let Some(deadline_on) = &task.deadline_on
            {
                days.entry(deadline_on.clone())
                    .or_default()
                    .push(CalendarEntry {
                        task_id: id.clone(),
                        deadline: true,
                    });
            }
        }
    }
    for id in &lists.today {
        if matching(id).is_some() {
            days.entry(store.today.clone())
                .or_default()
                .push(CalendarEntry {
                    task_id: id.clone(),
                    deadline: false,
                });
        }
    }
    for id in &lists.scheduled {
        if let Some(task) = matching(id)
            && let Some(scheduled_on) = &task.scheduled_on
        {
            days.entry(scheduled_on.clone())
                .or_default()
                .push(CalendarEntry {
                    task_id: id.clone(),
                    deadline: false,
                });
        }
    }
    days
}

/// 月の表の週（日曜始まり）。その月の1日を含む週から、末日を含む週まで（4〜6 週）。
/// 前後の月の日も、週の中ではそのまま並ぶ。month は YYYY-MM-01
pub fn month_weeks(month: &str) -> Vec<Vec<String>> {
    let last = add_days(&add_months(month, 1), -1);
    let end = add_days(&last, 6 - weekday_index(&last) as i64);
    let mut day = add_days(month, -(weekday_index(month) as i64));
    let mut weeks = Vec::new();
    while day <= end {
        let mut week = Vec::new();
        for _ in 0..7 {
            let next = add_days(&day, 1);
            week.push(std::mem::replace(&mut day, next));
        }
        weeks.push(week);
    }
    weeks
}

// --- タイムライン -----------------------------------------------------------------------

/// 今日より前に出す週の数
pub const WEEKS_BEFORE: i64 = 1;
/// 今日より先に出す週の数
pub const WEEKS_AFTER: i64 = 8;

/// 表示の範囲（両端を含む）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineRange {
    pub start: String,
    pub end: String,
    pub days: i64,
}

pub fn timeline_range(today: &str) -> TimelineRange {
    let start = add_days(today, -7 * WEEKS_BEFORE);
    let end = add_days(today, 7 * WEEKS_AFTER);
    let days = days_between(&start, &end) + 1;
    TimelineRange { start, end, days }
}

/// 棒か◆の形
/// - Bar：from（やる日）から to まで。締切がやる日以降なら to は締切で、右端に◆（end_diamond）。
///   締切がやる日より前なら to はやる日（1日の棒）で、締切は離れた◆（loose_deadline）
/// - Diamond：やる日がなく、締切の◆だけ
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TimelineShape {
    Bar {
        from: String,
        to: String,
        end_diamond: bool,
        loose_deadline: Option<String>,
    },
    Diamond {
        on: String,
    },
}

/// やる日と締切から、棒か◆の形を決める（どちらもなければ None）
pub fn shape_of(do_on: Option<&str>, deadline_on: Option<&str>) -> Option<TimelineShape> {
    match (do_on, deadline_on) {
        (Some(do_on), Some(deadline_on)) if deadline_on >= do_on => Some(TimelineShape::Bar {
            from: do_on.to_string(),
            to: deadline_on.to_string(),
            end_diamond: true,
            loose_deadline: None,
        }),
        (Some(do_on), deadline_on) => Some(TimelineShape::Bar {
            from: do_on.to_string(),
            to: do_on.to_string(),
            end_diamond: false,
            loose_deadline: deadline_on.map(str::to_string),
        }),
        (None, Some(deadline_on)) => Some(TimelineShape::Diamond {
            on: deadline_on.to_string(),
        }),
        (None, None) => None,
    }
}

fn is_in_range(shape: &TimelineShape, range: &TimelineRange) -> bool {
    let within = |date: &str| date >= range.start.as_str() && date <= range.end.as_str();
    match shape {
        TimelineShape::Diamond { on } => within(on),
        TimelineShape::Bar {
            from,
            to,
            loose_deadline,
            ..
        } => {
            (from.as_str() <= range.end.as_str() && to.as_str() >= range.start.as_str())
                || loose_deadline.as_deref().is_some_and(within)
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineItem {
    pub task_id: String,
    pub shape: TimelineShape,
}

/// プロジェクトごとのまとまり。project_id が None なら「プロジェクトなし」
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TimelineGroup {
    pub project_id: Option<String>,
    pub items: Vec<TimelineItem>,
}

/// タイムラインの中身。
/// - 縦：プロジェクトごとのまとまり（プロジェクトの作成順。プロジェクトなしは最後）。まとまりの中は、やる日の順
/// - 棒：やる日（予定は予定の日付、今日のタスクは今日）から締切まで。締切がなければ1日の棒
/// - やる日のないタスク（受信箱・あとで）で締切があるものは◆だけ。やる日も締切もないタスクと、完了したタスクは出さない
/// - 表示の範囲に棒も◆も入らないタスクは、行ごと出さない
pub fn timeline_groups(store: &Store, filter: &ProjectFilter) -> Vec<TimelineGroup> {
    let lists = store.lists();
    let replica = &store.replica;
    let range = timeline_range(&store.today);
    let mut by_project: HashMap<Option<String>, Vec<(String, String, TimelineItem)>> =
        HashMap::new();
    for rows in [&lists.today, &lists.scheduled, &lists.later, &lists.inbox] {
        for id in rows {
            let Some(task) = replica.task(id).filter(|task| filter.matches(task)) else {
                continue;
            };
            let do_on = match task.bucket {
                Bucket::Today => Some(store.today.as_str()),
                Bucket::Scheduled => task.scheduled_on.as_deref(),
                _ => None,
            };
            let Some(shape) = shape_of(do_on, task.deadline_on.as_deref())
                .filter(|shape| is_in_range(shape, &range))
            else {
                continue;
            };
            // 付いているプロジェクトが見つからなければ、プロジェクトなしに入れる
            let project_id = task
                .project_id
                .clone()
                .filter(|id| lists.project_colors.contains_key(id));
            // 並べ替えの鍵：やる日、締切（ないものは後ろ）
            let far = "9999-99-99".to_string();
            let order = (
                do_on.map_or_else(|| far.clone(), str::to_string),
                task.deadline_on.clone().unwrap_or(far),
            );
            by_project.entry(project_id).or_default().push((
                order.0,
                order.1,
                TimelineItem {
                    task_id: id.clone(),
                    shape,
                },
            ));
        }
    }
    // プロジェクトの作成順（アーカイブ済みも含む）。プロジェクトなしは最後
    let mut projects: Vec<&crate::model::Project> = replica
        .projects()
        .filter(|project| project.deleted_at.is_none())
        .collect();
    projects.sort_by(|a, b| {
        a.created_at
            .cmp(&b.created_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    let mut keys: Vec<Option<String>> = projects
        .into_iter()
        .map(|project| Some(project.id.clone()))
        .collect();
    keys.push(None);
    keys.into_iter()
        .filter_map(|project_id| {
            let mut items = by_project.remove(&project_id)?;
            // 同じ日の中は、元の並び（今日・予定・あとで・受信箱の順）を保つ
            items.sort_by(|a, b| (&a.0, &a.1).cmp(&(&b.0, &b.1)));
            Some(TimelineGroup {
                project_id,
                items: items.into_iter().map(|(_, _, item)| item).collect(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 月の表は日曜始まりで_前後の月の日も並ぶ() {
        let weeks = month_weeks("2026-10-01");
        assert_eq!(weeks.len(), 5);
        assert_eq!(weeks[0][0], "2026-09-27");
        assert_eq!(weeks[0][4], "2026-10-01");
        assert_eq!(weeks[4][6], "2026-10-31");
        // 2026 年 2 月は日曜に始まり土曜に終わる（4 週）
        assert_eq!(month_weeks("2026-02-01").len(), 4);
        assert_eq!(month_weeks("2026-08-01").len(), 6);
    }

    #[test]
    fn 棒と菱形の形() {
        assert_eq!(
            shape_of(Some("2026-10-06"), Some("2026-10-09")),
            Some(TimelineShape::Bar {
                from: "2026-10-06".into(),
                to: "2026-10-09".into(),
                end_diamond: true,
                loose_deadline: None
            })
        );
        // 締切がやる日より前なら、1日の棒と離れた◆
        assert_eq!(
            shape_of(Some("2026-10-06"), Some("2026-10-02")),
            Some(TimelineShape::Bar {
                from: "2026-10-06".into(),
                to: "2026-10-06".into(),
                end_diamond: false,
                loose_deadline: Some("2026-10-02".into())
            })
        );
        assert_eq!(
            shape_of(None, Some("2026-10-02")),
            Some(TimelineShape::Diamond {
                on: "2026-10-02".into()
            })
        );
        assert_eq!(shape_of(None, None), None);
        let range = timeline_range("2026-10-06");
        assert_eq!((range.start.as_str(), range.days), ("2026-09-29", 64));
    }
}
