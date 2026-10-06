//! 画面から呼ぶ操作の入口。どれも、今の表示（確定データ＋送信中の操作）をもとに操作のまとまりを作り、
//! すぐ表示に重ねて、送信の列に積む。業務のルール（どの置き場に入れるか、並び順キーの付け方）はここで決める。
//! オフラインのときは受け付けずに止める

use std::collections::{HashMap, HashSet};

use super::replica::{OperationKind, Partition, apply_task_mutation, partition_of};
use super::store::{Failure, OpResult, PerformOptions, Store};
use crate::dates::add_days;
use crate::model::{
    Bucket, Mutation, NewProject, NewTask, POINTS, PROJECT_COLORS, Priority, ProjectChanges,
    RowKind, Task, TaskChanges,
};
use crate::rank::{arrival_ranks, ranks_between};

/// 置き場の移動先。予定は日付と一緒に指定する
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Destination {
    Inbox,
    Today,
    Later,
    Scheduled(String),
}

impl Destination {
    fn bucket(&self) -> Bucket {
        match self {
            Destination::Inbox => Bucket::Inbox,
            Destination::Today => Bucket::Today,
            Destination::Later => Bucket::Later,
            Destination::Scheduled(_) => Bucket::Scheduled,
        }
    }

    fn scheduled_on(&self) -> Option<String> {
        match self {
            Destination::Scheduled(on) => Some(on.clone()),
            _ => None,
        }
    }
}

/// 追加の中身と行き先
#[derive(Clone, Debug)]
pub struct AddTask {
    pub title: String,
    pub project_id: Option<String>,
    pub to: Destination,
}

/// 並べ替えの1か所ぶん：ids（上から入れる順）を、after の行の後ろ・before の行の前へ入れる。
/// after と before は、画面で見えている動かさない行（端なら None。両方 None は受け付けない）
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub ids: Vec<String>,
    pub after: Option<String>,
    pub before: Option<String>,
}

/// 変える項目だけを残し、bucket と scheduledOn の対応、進行中と今日の対応を満たすようにそろえる。
/// - scheduled にするときは scheduledOn も、scheduled から外すときは scheduledOn: null も、同じ changes に入れる
/// - 進行中のタスクを今日から出すときは、同じ changes で startedAt: null にする（未着手に戻る）。
///   今日の外で startedAt を入れようとしたら（今と同じ値でも）受け付けない
///
/// 受け付けられない内容なら None
pub fn normalize_task_changes(current: &Task, changes: TaskChanges) -> Option<TaskChanges> {
    // 明示した startedAt と変えたあとの bucket の組み合わせを、同じ値を取り除く前に確かめる
    let started_given = matches!(changes.started_at, Some(Some(_)));
    if started_given && changes.bucket.unwrap_or(current.bucket) != Bucket::Today {
        return None;
    }
    if changes
        .title
        .as_deref()
        .is_some_and(|t| t.trim().is_empty())
    {
        return None;
    }
    let started_explicit = changes.started_at.is_some();
    let mut next = changes.without_unchanged(current);
    let bucket = next.bucket.unwrap_or(current.bucket);
    let scheduled_on = match &next.scheduled_on {
        Some(value) => value.clone(),
        None => current.scheduled_on.clone(),
    };
    if bucket == Bucket::Scheduled {
        scheduled_on.as_ref()?;
        if next.bucket.is_some() {
            next.scheduled_on = Some(scheduled_on);
        }
    } else if scheduled_on.is_some() {
        if next.scheduled_on.is_some() {
            return None;
        }
        next.scheduled_on = Some(None);
    }
    if current.started_at.is_some() && !started_explicit && bucket != Bucket::Today {
        next.started_at = Some(None);
    }
    Some(next)
}

/// 操作を今の表示に順に重ねると、タスクの決まり（「進行中なら今日」「予定なら日付あり」）が崩れるか。
/// 元に戻す操作は、戻すまでのあいだにほかの画面が同じタスクを動かしていると崩れることがある
fn breaks_task_rules(mutations: &[Mutation], read: impl Fn(&str) -> Option<Task>) -> bool {
    let mut tasks: HashMap<String, Option<Task>> = HashMap::new();
    for mutation in mutations {
        let (RowKind::Task, id) = mutation.target() else {
            continue;
        };
        let base = tasks.remove(id).unwrap_or_else(|| read(id));
        let next = apply_task_mutation(base, mutation, "");
        if next
            .as_ref()
            .is_some_and(|task| !(task.is_schedule_consistent() && task.is_start_consistent()))
        {
            return true;
        }
        tasks.insert(id.to_string(), next);
    }
    false
}

// --- 日付の決まり（d・⇧D・タイムラインで日をずらす） ----------------------------------

/// d の決まり：やる日を on にしたときの行き先。今日か過去の日なら今日
pub fn schedule_destination(on: &str, today: &str) -> Destination {
    if on <= today {
        Destination::Today
    } else {
        Destination::Scheduled(on.to_string())
    }
}

/// ⇧D の決まり：締切を deadline_on にしたとき、今日の到着の位置へ移すか。未完了の予定・あとでのタスクに、
/// 今日以前の締切を付けたとき（受信箱は振り分けの途中なので動かさない。今日にあるものはもう今日にある）
pub fn arrives_by_deadline(
    bucket: Bucket,
    completed: bool,
    deadline_on: Option<&str>,
    today: &str,
) -> bool {
    deadline_on.is_some_and(|on| on <= today)
        && !completed
        && matches!(bucket, Bucket::Scheduled | Bucket::Later)
}

/// 日付の操作をかけたあとの置き場と日付。arrived は、締切で今日の到着の位置へ移ったか
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DatePlacement {
    pub bucket: Bucket,
    pub scheduled_on: Option<String>,
    pub deadline_on: Option<String>,
    pub arrived: bool,
}

/// やる日と締切を同じ日数ずらしたあとの置き場と日付（並び順キーは除く）。
/// ずらした日で d をかけてから ⇧D をかけたときと同じ（やる日は、予定は予定の日付、今日のタスクは今日）
pub fn placement_after_shift(task: &Task, days: i64, today: &str) -> DatePlacement {
    let mut placement = DatePlacement {
        bucket: task.bucket,
        scheduled_on: task.scheduled_on.clone(),
        deadline_on: task.deadline_on.clone(),
        arrived: false,
    };
    let do_on = match task.bucket {
        Bucket::Scheduled => task.scheduled_on.clone(),
        Bucket::Today => Some(today.to_string()),
        _ => None,
    };
    if let Some(do_on) = do_on {
        match schedule_destination(&add_days(&do_on, days), today) {
            Destination::Scheduled(on) => {
                placement.bucket = Bucket::Scheduled;
                placement.scheduled_on = Some(on);
            }
            _ if placement.bucket != Bucket::Today => {
                placement.bucket = Bucket::Today;
                placement.scheduled_on = None;
            }
            _ => {}
        }
    }
    if let Some(deadline_on) = &task.deadline_on {
        let shifted = add_days(deadline_on, days);
        if arrives_by_deadline(
            placement.bucket,
            task.completed_at.is_some(),
            Some(&shifted),
            today,
        ) {
            placement.bucket = Bucket::Today;
            placement.scheduled_on = None;
            placement.arrived = true;
        }
        placement.deadline_on = Some(shifted);
    }
    placement
}

fn is_open(task: &Task) -> bool {
    task.completed_at.is_none() && task.deleted_at.is_none()
}

impl Store {
    // --- 並び順キー ---------------------------------------------------------------------

    /// 置き場にある行（完了済み・削除済みも含む）の rank。except の行は除く
    fn ranks_in(&self, bucket: Bucket, except: &HashSet<&str>) -> Vec<&str> {
        self.replica
            .tasks()
            .filter(|task| task.bucket == bucket && !except.contains(task.id.as_str()))
            .map(|task| task.rank.as_str())
            .collect()
    }

    /// 置き場の一番下に入れる n 個のキー（上から順）。
    /// その置き場にある完了済み・削除済みの行よりも後ろにする（元に戻したときに、元の位置に戻るように）
    pub fn bottom_ranks(&self, bucket: Bucket, n: usize) -> Vec<String> {
        let last = self.ranks_in(bucket, &HashSet::new()).into_iter().max();
        ranks_between(last, None, n)
    }

    /// 置き場の一番上に入れる n 個のキー（上から順）
    pub fn top_ranks(&self, bucket: Bucket, n: usize) -> Vec<String> {
        let first = self.ranks_in(bucket, &HashSet::new()).into_iter().min();
        ranks_between(None, first, n)
    }

    /// 日付の到来や締切で今日に入れる n 個のキー。位置は「今日来たタスクの後ろ、それ以外の今日のタスクの前」
    /// （Worker の日付の切り替えと同じ決まり）
    pub fn arrival_ranks(&self, n: usize) -> Vec<String> {
        let today_tasks: Vec<(&str, &str, Option<&str>)> = self
            .replica
            .tasks()
            .filter(|task| partition_of(task) == Partition::Open(Bucket::Today))
            .map(|task| {
                (
                    task.id.as_str(),
                    task.rank.as_str(),
                    task.arrived_on.as_deref(),
                )
            })
            .collect();
        arrival_ranks(&today_tasks, &self.today, n)
    }

    // --- タスク -------------------------------------------------------------------------

    /// 追加。置き場の一番下に入る。ids[0] が作ったタスクの id。
    /// 予定へ追加するときに、日付が今日か過去なら今日の一番下に入れる（move_tasks と同じ決まり）
    pub fn add_task(&mut self, input: AddTask) -> OpResult {
        if input.title.trim().is_empty() {
            return Err(Failure::Invalid);
        }
        let to = match input.to {
            Destination::Scheduled(on) => schedule_destination(&on, &self.today),
            other => other,
        };
        let bucket = to.bucket();
        let Some(rank) = self.bottom_ranks(bucket, 1).pop() else {
            return Err(Failure::Invalid);
        };
        let task = NewTask {
            id: self.new_id(),
            title: input.title,
            memo: String::new(),
            bucket,
            scheduled_on: to.scheduled_on(),
            project_id: input.project_id,
            rank,
        };
        self.perform(
            OperationKind::TaskAdd,
            vec![Mutation::TaskCreate { task }],
            PerformOptions::default(),
        )
    }

    /// 1つのタスクの項目を変える（タイトル、メモ、チェックリストなど）
    pub fn update_task(
        &mut self,
        id: &str,
        changes: TaskChanges,
        options: PerformOptions,
    ) -> OpResult {
        self.update_many(
            OperationKind::TaskUpdate,
            vec![(id.to_string(), changes)],
            options,
        )
    }

    /// 完了。bucket と rank は変えない（直後に元に戻すと、元の場所・元の位置に戻る）
    pub fn complete_tasks(&mut self, ids: &[String]) -> OpResult {
        let completed_at = self.now_iso();
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(is_open)
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        completed_at: Some(Some(completed_at.clone())),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskComplete,
            updates,
            PerformOptions::default(),
        )
    }

    /// あとから完了を外す（「完了 N件」や完了ログから）。今日の一番下に、未着手で戻る
    /// （進行中のまま完了していても startedAt を消す）。
    /// start なら、同じ操作で進行中にする（ボードで完了のカードを進行中の列へ移したとき。戻すのも1回）
    pub fn uncomplete_tasks(&mut self, ids: &[String], start: bool) -> OpResult {
        let targets: Vec<Task> = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.completed_at.is_some() && task.deleted_at.is_none())
            .collect();
        let ranks = self.bottom_ranks(Bucket::Today, targets.len());
        if ranks.len() != targets.len() {
            return Err(Failure::Invalid);
        }
        let started_at = start.then(|| self.now_iso());
        let updates = targets
            .into_iter()
            .zip(ranks)
            .map(|(task, rank)| {
                (
                    task.id,
                    TaskChanges {
                        completed_at: Some(None),
                        started_at: Some(started_at.clone()),
                        bucket: Some(Bucket::Today),
                        rank: Some(rank),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskUncomplete,
            updates,
            PerformOptions::default(),
        )
    }

    /// 進行中にする（未完了で、まだ進行中でないタスクだけ）。今日以外にあるタスクは、同じ操作で今日の一番上へ移す
    /// （移すタスクどうしは渡した順で上から並ぶ）。すでに今日にあるタスクは位置を変えない
    pub fn start_tasks(&mut self, ids: &[String]) -> OpResult {
        let started_at = self.now_iso();
        let targets: Vec<Task> = self
            .rows(ids)
            .into_iter()
            .filter(|task| is_open(task) && task.started_at.is_none())
            .collect();
        let moving = targets
            .iter()
            .filter(|task| task.bucket != Bucket::Today)
            .count();
        let ranks = self.top_ranks(Bucket::Today, moving);
        if ranks.len() != moving {
            return Err(Failure::Invalid);
        }
        let mut ranks = ranks.into_iter();
        let updates = targets
            .into_iter()
            .map(|task| {
                let mut changes = TaskChanges {
                    started_at: Some(Some(started_at.clone())),
                    ..Default::default()
                };
                if task.bucket != Bucket::Today {
                    changes.bucket = Some(Bucket::Today);
                    changes.rank = ranks.next();
                }
                (task.id, changes)
            })
            .collect();
        self.update_many(OperationKind::TaskStart, updates, PerformOptions::default())
    }

    /// 未着手に戻す（進行中のタスクだけ）。startedAt を消すだけで、位置は変えない
    pub fn stop_tasks(&mut self, ids: &[String]) -> OpResult {
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(|task| is_open(task) && task.started_at.is_some())
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        started_at: Some(None),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(OperationKind::TaskStop, updates, PerformOptions::default())
    }

    /// 置き場を移す（未完了のタスクだけ）。移した先の一番下に、渡した順で並ぶ。
    /// 予定へ移すときに、日付が今日か過去なら今日に入れる。
    /// 進行中のタスクを今日から出すと、同じ操作で未着手に戻る（normalize_task_changes）
    pub fn move_tasks(&mut self, ids: &[String], destination: Destination) -> OpResult {
        let to = match destination {
            Destination::Scheduled(on) => schedule_destination(&on, &self.today),
            other => other,
        };
        let (bucket, scheduled_on) = (to.bucket(), to.scheduled_on());
        let targets: Vec<Task> = self
            .rows(ids)
            .into_iter()
            .filter(|task| {
                is_open(task) && (task.bucket != bucket || task.scheduled_on != scheduled_on)
            })
            .collect();
        let ranks = self.bottom_ranks(bucket, targets.len());
        if ranks.len() != targets.len() {
            return Err(Failure::Invalid);
        }
        let updates = targets
            .into_iter()
            .zip(ranks)
            .map(|(task, rank)| {
                (
                    task.id,
                    TaskChanges {
                        bucket: Some(bucket),
                        scheduled_on: Some(scheduled_on.clone()),
                        rank: Some(rank),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(OperationKind::TaskMove, updates, PerformOptions::default())
    }

    /// 並べ替え。書き換えるのは動かした行の rank だけで、置き場は変えない。
    /// 動かす行は、同じ置き場の未完了のタスク。1回の操作で何か所に入れてもよい（まとめて戻る）。
    /// 新しい rank は、隣の行とのあいだで、その置き場のほかの行（完了済み・削除済みや、画面に出ていない
    /// ほかのプロジェクトの行も含む）の rank と重ならないところに作る（元に戻したときに並びが崩れないように）
    pub fn reorder_tasks(&mut self, placements: &[Placement]) -> OpResult {
        let moving_ids: Vec<String> = placements
            .iter()
            .flat_map(|placement| placement.ids.iter().cloned())
            .collect();
        let moving: HashSet<&str> = moving_ids.iter().map(String::as_str).collect();
        let rows = self.rows(&moving_ids);
        let Some(bucket) = rows.first().map(|task| task.bucket) else {
            return Err(Failure::Invalid);
        };
        if rows.len() != moving.len()
            || rows
                .iter()
                .any(|task| task.bucket != bucket || !is_open(task))
        {
            return Err(Failure::Invalid);
        }
        // 動かさない行の rank（小さい順）
        let mut fixed: Vec<String> = self
            .ranks_in(bucket, &moving)
            .into_iter()
            .map(str::to_string)
            .collect();
        fixed.sort();
        let rank_of =
            |id: &str| -> Option<String> { self.replica.task(id).map(|task| task.rank.clone()) };
        let mut updates = Vec::new();
        for placement in placements {
            if placement.ids.is_empty() {
                continue;
            }
            let after = match &placement.after {
                Some(id) => Some(rank_of(id).ok_or(Failure::Invalid)?),
                None => None,
            };
            let before = match &placement.before {
                Some(id) => Some(rank_of(id).ok_or(Failure::Invalid)?),
                None => None,
            };
            // after の直後（次の rank の手前）か、after が端なら before の直前（前の rank の後ろ）に入れる
            let (lower, upper) = match (&after, &before) {
                (Some(after), _) => (
                    Some(after.clone()),
                    fixed.iter().find(|rank| *rank > after).cloned(),
                ),
                (None, Some(before)) => (
                    fixed.iter().rfind(|rank| *rank < before).cloned(),
                    Some(before.clone()),
                ),
                (None, None) => return Err(Failure::Invalid),
            };
            let ranks = ranks_between(lower.as_deref(), upper.as_deref(), placement.ids.len());
            if ranks.len() != placement.ids.len() {
                return Err(Failure::Invalid);
            }
            for (id, rank) in placement.ids.iter().zip(ranks) {
                updates.push((
                    id.clone(),
                    TaskChanges {
                        rank: Some(rank),
                        ..Default::default()
                    },
                ));
            }
        }
        self.update_many(
            OperationKind::TaskReorder,
            updates,
            PerformOptions::default(),
        )
    }

    /// 締切を付ける・外す（None）。未完了の予定・あとでのタスクに今日以前の締切を付けたら、同じ操作で
    /// 今日の到着の位置（今日来たタスクの後ろ、それ以外の今日のタスクの前）へ移し、到着の印（arrivedOn）を付ける。
    /// 受信箱（振り分けの途中）と、すでに今日にあるタスクは動かさない
    pub fn set_deadline(&mut self, ids: &[String], deadline_on: Option<&str>) -> OpResult {
        let today = self.today.clone();
        let arrives = |task: &Task| {
            arrives_by_deadline(
                task.bucket,
                task.completed_at.is_some(),
                deadline_on,
                &today,
            )
        };
        let targets: Vec<Task> = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.deleted_at.is_none() && task.deadline_on.as_deref() != deadline_on)
            .collect();
        let arriving = targets.iter().filter(|task| arrives(task)).count();
        let ranks = self.arrival_ranks(arriving);
        if ranks.len() != arriving {
            return Err(Failure::Invalid);
        }
        let mut ranks = ranks.into_iter();
        let updates = targets
            .into_iter()
            .map(|task| {
                let mut changes = TaskChanges {
                    deadline_on: Some(deadline_on.map(str::to_string)),
                    ..Default::default()
                };
                if arrives(&task) {
                    changes.bucket = Some(Bucket::Today);
                    changes.scheduled_on = Some(None);
                    changes.rank = ranks.next();
                    changes.arrived_on = Some(Some(today.clone()));
                }
                (task.id, changes)
            })
            .collect();
        self.update_many(
            OperationKind::TaskDeadline,
            updates,
            PerformOptions::default(),
        )
    }

    /// やる日と締切を、同じ日数（days。負なら前へ）だけずらす（タイムラインの < >）。
    /// 1つの操作として送り、元に戻す 1 回でまとめて戻る。未完了のタスクだけが対象。
    /// 決まりは placement_after_shift（ずらした日で d をかけてから ⇧D をかけたときと同じ）。
    /// やる日のないタスク（受信箱・あとで）は締切だけを、締切のないタスクはやる日だけをずらす
    pub fn shift_task_dates(&mut self, ids: &[String], days: i64) -> OpResult {
        if days == 0 {
            return Err(Failure::Noop);
        }
        #[derive(PartialEq)]
        enum Place {
            Keep,
            Today,
            Scheduled,
            Arrive,
        }
        let today = self.today.clone();
        let plans: Vec<(Task, Place, DatePlacement)> = self
            .rows(ids)
            .into_iter()
            .filter(is_open)
            .filter_map(|task| {
                let after = placement_after_shift(&task, days, &today);
                let unchanged = after.bucket == task.bucket
                    && after.scheduled_on == task.scheduled_on
                    && after.deadline_on == task.deadline_on;
                if unchanged {
                    return None;
                }
                let place = if after.arrived {
                    Place::Arrive
                } else if after.bucket == Bucket::Scheduled {
                    Place::Scheduled
                } else if after.bucket == Bucket::Today && task.bucket != Bucket::Today {
                    Place::Today
                } else {
                    Place::Keep
                };
                Some((task, place, after))
            })
            .collect();
        let count = |place: Place| plans.iter().filter(|plan| plan.1 == place).count();
        let today_ranks = self.bottom_ranks(Bucket::Today, count(Place::Today));
        let scheduled_ranks = self.bottom_ranks(Bucket::Scheduled, count(Place::Scheduled));
        let arrive_ranks = self.arrival_ranks(count(Place::Arrive));
        if today_ranks.len() != count(Place::Today)
            || scheduled_ranks.len() != count(Place::Scheduled)
            || arrive_ranks.len() != count(Place::Arrive)
        {
            return Err(Failure::Invalid);
        }
        let (mut today_ranks, mut scheduled_ranks, mut arrive_ranks) = (
            today_ranks.into_iter(),
            scheduled_ranks.into_iter(),
            arrive_ranks.into_iter(),
        );
        let updates = plans
            .into_iter()
            .map(|(task, place, after)| {
                let mut changes = TaskChanges::default();
                if after.deadline_on != task.deadline_on {
                    changes.deadline_on = Some(after.deadline_on.clone());
                }
                match place {
                    Place::Keep => {}
                    Place::Today => {
                        changes.bucket = Some(Bucket::Today);
                        changes.scheduled_on = Some(None);
                        changes.rank = today_ranks.next();
                    }
                    Place::Scheduled => {
                        changes.bucket = Some(Bucket::Scheduled);
                        changes.scheduled_on = Some(after.scheduled_on.clone());
                        changes.rank = scheduled_ranks.next();
                    }
                    Place::Arrive => {
                        changes.bucket = Some(Bucket::Today);
                        changes.scheduled_on = Some(None);
                        changes.rank = arrive_ranks.next();
                        changes.arrived_on = Some(Some(today.clone()));
                    }
                }
                (task.id, changes)
            })
            .collect();
        self.update_many(OperationKind::TaskMove, updates, PerformOptions::default())
    }

    /// 優先度を付ける・外す（None）。完了済みのタスクにも付けられる（削除済みは除く）。
    /// 置き場も並び順キーも変えない（優先度で並べるのは表示だけ）
    pub fn set_priority(&mut self, ids: &[String], priority: Option<Priority>) -> OpResult {
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        priority: Some(priority),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskPriority,
            updates,
            PerformOptions::default(),
        )
    }

    /// 工数を付ける・外す（None）。完了済みのタスクにも付けられる（削除済みは除く）
    pub fn set_points(&mut self, ids: &[String], points: Option<u8>) -> OpResult {
        if points.is_some_and(|points| !POINTS.contains(&points)) {
            return Err(Failure::Invalid);
        }
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        points: Some(points),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskPoints,
            updates,
            PerformOptions::default(),
        )
    }

    /// 削除（論理削除）。確認は画面が出さない。元に戻すで戻る
    pub fn delete_tasks(&mut self, ids: &[String]) -> OpResult {
        let deleted_at = self.now_iso();
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        deleted_at: Some(Some(deleted_at.clone())),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskDelete,
            updates,
            PerformOptions::default(),
        )
    }

    // --- プロジェクト -------------------------------------------------------------------

    /// プロジェクトを作る。ids[0] が作ったプロジェクトの id。
    /// assign_to を渡すと、同じ操作でそのタスクに付ける（p の「「◯◯」を作成」。作成と付けるのを1回で戻せる）。
    /// 色は入れない（空のまま作り、表示は作成順の色に任せる）
    pub fn create_project(&mut self, name: &str, assign_to: &[String]) -> OpResult {
        let name = name.trim();
        if name.is_empty() {
            return Err(Failure::Invalid);
        }
        let id = self.new_id();
        let mut mutations = vec![Mutation::ProjectCreate {
            project: NewProject {
                id: id.clone(),
                name: name.to_string(),
            },
        }];
        for task in self.rows(assign_to) {
            if task.deleted_at.is_none() {
                mutations.push(Mutation::update_task(
                    &task.id,
                    TaskChanges {
                        project_id: Some(Some(id.clone())),
                        ..Default::default()
                    },
                ));
            }
        }
        self.perform(
            OperationKind::ProjectCreate,
            mutations,
            PerformOptions::default(),
        )
    }

    /// タスクにプロジェクトを付ける・外す（None）。アーカイブ済み・削除済みのプロジェクトは付けられない
    pub fn set_project(&mut self, ids: &[String], project_id: Option<&str>) -> OpResult {
        if let Some(project_id) = project_id {
            let usable = self
                .replica
                .project(project_id)
                .is_some_and(|p| p.archived_at.is_none() && p.deleted_at.is_none());
            if !usable {
                return Err(Failure::Invalid);
            }
        }
        let updates = self
            .rows(ids)
            .into_iter()
            .filter(|task| task.deleted_at.is_none())
            .map(|task| {
                (
                    task.id,
                    TaskChanges {
                        project_id: Some(project_id.map(str::to_string)),
                        ..Default::default()
                    },
                )
            })
            .collect();
        self.update_many(
            OperationKind::TaskUpdate,
            updates,
            PerformOptions::default(),
        )
    }

    /// 名前の変更・色の変更・アーカイブ・削除。未完了のタスクが残っているとアーカイブできない。
    /// 色はパレットの名前だけ（ほかは Invalid）。None にすると作成順の色に戻る
    pub fn update_project(&mut self, id: &str, mut changes: ProjectChanges) -> OpResult {
        let Some(current) = self
            .replica
            .project(id)
            .filter(|p| p.deleted_at.is_none())
            .cloned()
        else {
            return Err(Failure::Invalid);
        };
        if let Some(name) = &mut changes.name {
            *name = name.trim().to_string();
            if name.is_empty() {
                return Err(Failure::Invalid);
            }
        }
        if let Some(Some(color)) = &changes.color
            && !PROJECT_COLORS.contains(&color.as_str())
        {
            return Err(Failure::Invalid);
        }
        if matches!(changes.archived_at, Some(Some(_))) && self.open_task_count_of_project(id) > 0 {
            return Err(Failure::HasOpenTasks);
        }
        let next = changes.without_unchanged(&current);
        if next.is_empty() {
            return Err(Failure::Noop);
        }
        self.perform(
            OperationKind::ProjectUpdate,
            vec![Mutation::ProjectUpdate {
                id: id.to_string(),
                changes: next,
            }],
            PerformOptions::default(),
        )
    }

    /// そのプロジェクトの未完了のタスクの数（表示中の内容で数える）
    pub fn open_task_count_of_project(&self, project_id: &str) -> usize {
        self.replica
            .tasks()
            .filter(|task| is_open(task) && task.project_id.as_deref() == Some(project_id))
            .count()
    }

    // --- 元に戻す -----------------------------------------------------------------------

    /// 一番新しい操作を、逆向きの操作のまとまり1つで戻す。
    /// 戻すまでのあいだにほかの画面が同じタスクを動かしていて、戻すとタスクの決まりが崩れるときは、
    /// 直して送ることはせずに戻さない（Conflict）。その操作は元に戻すの対象から外し、ぶつかりを知らせて同期し直す
    pub fn undo(&mut self) -> OpResult {
        let Some(entry) = self.undo.pop() else {
            return Err(Failure::NothingToUndo);
        };
        // 戻す先の行がもうない（削除から 30 日たって捨てた）操作は送らない
        let mutations: Vec<Mutation> = entry
            .mutations(&self.now_iso(), |id| {
                self.replica.task(id).map(|task| task.checklist.clone())
            })
            .into_iter()
            .filter(|mutation| match mutation.target() {
                (RowKind::Task, id) => self.replica.task(id).is_some(),
                (RowKind::Project, id) => self.replica.project(id).is_some(),
            })
            .collect();
        if breaks_task_rules(&mutations, |id| self.replica.task(id).cloned()) {
            self.on_undo_conflict();
            return Err(Failure::Conflict);
        }
        let result = self.perform(
            OperationKind::Undo,
            mutations,
            PerformOptions {
                not_undoable: true,
                autosave: false,
            },
        );
        match &result {
            Ok(done) => self.undo.undoing(&done.operation_id, entry),
            Err(Failure::Noop) => {}
            // オフラインなどで止めたときは、戻す対象のまま残す
            Err(_) => self.undo.push(entry),
        }
        result
    }

    // --- 内部 ---------------------------------------------------------------------------

    /// ids の行（重なりは除く。ない行は飛ばす）
    fn rows(&self, ids: &[String]) -> Vec<Task> {
        let mut seen = HashSet::new();
        ids.iter()
            .filter(|id| seen.insert(id.as_str()))
            .filter_map(|id| self.replica.task(id).cloned())
            .collect()
    }

    fn update_many(
        &mut self,
        kind: OperationKind,
        updates: Vec<(String, TaskChanges)>,
        options: PerformOptions,
    ) -> OpResult {
        let mut mutations = Vec::new();
        for (id, changes) in updates {
            let Some(current) = self.replica.task(&id) else {
                continue;
            };
            let Some(normalized) = normalize_task_changes(current, changes) else {
                return Err(Failure::Invalid);
            };
            if normalized.is_empty() {
                continue;
            }
            // チェックリストは配列をまるごと置き換えるので、変える前の配列（確定データに、それより前の
            // 送信中の操作を重ねたもの）を添える。ほかの画面が先に変えていたら、Worker が断る
            let base_checklist = normalized
                .checklist
                .as_ref()
                .map(|_| current.checklist.clone());
            mutations.push(Mutation::TaskUpdate {
                id,
                changes: normalized,
                base_checklist,
            });
        }
        self.perform(kind, mutations, options)
    }
}
