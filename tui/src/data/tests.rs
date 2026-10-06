//! データ層のテスト。通信は偽物（送ったものを覚えるだけ）に差し替え、応答はテストが on_*_done で渡す

use std::cell::RefCell;
use std::rc::Rc;

use chrono::{DateTime, Utc};

use super::actions::{AddTask, Destination, Placement, normalize_task_changes};
use super::store::{
    ApiFailure, Failure, Notice, PerformOptions, SaveFailure, StopReason, Store, StoreOptions,
    SyncFlow, Transport,
};
use crate::dates::{APP_TIME_ZONE, parse_iso};
use crate::model::{
    Bucket, ChecklistItem, Mutation, MutationBatch, Priority, Project, ProjectChanges, SyncRow,
    Task, TaskChanges,
};

#[derive(Default)]
struct Sent {
    batches: Vec<MutationBatch>,
    syncs: Vec<u64>,
}

struct FakeTransport(Rc<RefCell<Sent>>);

impl Transport for FakeTransport {
    fn mutate(&mut self, batch: MutationBatch) {
        self.0.borrow_mut().batches.push(batch);
    }
    fn sync(&mut self, cursor: u64) {
        self.0.borrow_mut().syncs.push(cursor);
    }
}

/// 東京の 2026-10-06 12:00
const NOW: &str = "2026-10-06T03:00:00.000Z";
const TODAY: &str = "2026-10-06";

struct Harness {
    store: Store,
    sent: Rc<RefCell<Sent>>,
    clock: Rc<RefCell<DateTime<Utc>>>,
    next_seq: u64,
}

fn harness() -> Harness {
    let sent = Rc::new(RefCell::new(Sent::default()));
    let clock = Rc::new(RefCell::new(parse_iso(NOW).unwrap()));
    let store = Store::new(StoreOptions {
        transport: Box::new(FakeTransport(Rc::clone(&sent))),
        local: None,
        clock: {
            let clock = Rc::clone(&clock);
            Box::new(move || *clock.borrow())
        },
        tz: APP_TIME_ZONE,
    });
    Harness {
        store,
        sent,
        clock,
        next_seq: 100,
    }
}

fn task(id: &str, bucket: Bucket, rank: &str) -> Task {
    Task {
        id: id.into(),
        title: format!("タスク {id}"),
        memo: String::new(),
        bucket,
        scheduled_on: None,
        deadline_on: None,
        project_id: None,
        rank: rank.into(),
        arrived_on: None,
        checklist: Vec::new(),
        completed_at: None,
        started_at: None,
        priority: None,
        points: None,
        created_at: "2026-10-01T00:00:00.000Z".into(),
        updated_at: "2026-10-01T00:00:00.000Z".into(),
        deleted_at: None,
        seq: 1,
    }
}

fn ids(list: &[&str]) -> Vec<String> {
    list.iter().map(|id| id.to_string()).collect()
}

impl Harness {
    /// 確定データを入れる（差分の取得が終わったことにする）
    fn seed(&mut self, tasks: Vec<Task>) {
        self.store.sync();
        self.store.on_sync_done(Ok(SyncFlow {
            base_cursor: 0,
            rows: tasks.into_iter().map(SyncRow::Task).collect(),
            cursor: 10,
        }));
    }

    fn last_batch(&self) -> MutationBatch {
        self.sent.borrow().batches.last().cloned().unwrap()
    }

    fn batch_count(&self) -> usize {
        self.sent.borrow().batches.len()
    }

    /// 送った最後のまとまりを、Worker が受け付けたことにする（今の表示の行を、新しい seq で確定して返す）
    fn confirm_last(&mut self) {
        let batch = self.last_batch();
        let mut rows = Vec::new();
        for mutation in &batch.mutations {
            let (_, id) = mutation.target();
            self.next_seq += 1;
            if let Some(task) = self.store.replica.task(id) {
                rows.push(SyncRow::Task(Task {
                    seq: self.next_seq,
                    ..task.clone()
                }));
            } else if let Some(project) = self.store.replica.project(id) {
                rows.push(SyncRow::Project(Project {
                    seq: self.next_seq,
                    ..project.clone()
                }));
            }
        }
        self.store.on_mutate_done(&batch.id, Ok(rows));
    }

    fn fail_last(&mut self, error: ApiFailure) {
        let batch = self.last_batch();
        self.store.on_mutate_done(&batch.id, Err(error));
    }

    fn task(&self, id: &str) -> Task {
        self.store.replica.task(id).cloned().unwrap()
    }
}

#[test]
fn 追加はすぐ表示に重なり_確定すると送信中から外れる() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let done = h
        .store
        .add_task(AddTask {
            title: "牛乳を買う".into(),
            memo: String::new(),
            project_id: None,
            to: Destination::Inbox,
        })
        .unwrap();
    let id = done.ids[0].clone();
    // すぐ一覧に出る（古い順なので後ろ）
    assert_eq!(h.store.lists().inbox, vec!["t1".to_string(), id.clone()]);
    assert_eq!(h.task(&id).seq, 0);
    assert!(h.task(&id).rank.as_str() > "a0");
    assert_eq!(h.store.pending_count(), 1);
    h.confirm_last();
    assert_eq!(h.store.pending_count(), 0);
    assert!(h.task(&id).seq > 0);
    assert!(h.store.can_undo());
}

#[test]
fn 送信は1つずつ順に行い_失敗したら後ろのまとまりも捨てて表示を戻す() {
    let mut h = harness();
    h.seed(vec![
        task("t1", Bucket::Inbox, "a0"),
        task("t2", Bucket::Inbox, "a1"),
    ]);
    h.store.complete_tasks(&ids(&["t1"])).unwrap();
    h.store
        .move_tasks(&ids(&["t2"]), Destination::Today)
        .unwrap();
    // 2つ目は、1つ目の応答を待ってから送る
    assert_eq!(h.batch_count(), 1);
    assert!(h.task("t1").completed_at.is_some());
    assert_eq!(h.task("t2").bucket, Bucket::Today);

    h.fail_last(ApiFailure::Rejected {
        status: 400,
        reason: Some("schema".into()),
    });
    assert_eq!(h.store.pending_count(), 0);
    assert!(h.task("t1").completed_at.is_none());
    assert_eq!(h.task("t2").bucket, Bucket::Inbox);
    assert!(!h.store.can_undo());
    let notices = h.store.take_notices();
    assert!(matches!(
        notices.as_slice(),
        [Notice::SaveFailed {
            reason: SaveFailure::Rejected,
            discarded,
            ..
        }] if discarded.len() == 2
    ));
    // 捨てたあとは送らない
    assert_eq!(h.batch_count(), 1);
}

#[test]
fn 通信できなかったらオフラインになり_操作を止める_差分が取れたら戻る() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    h.store.complete_tasks(&ids(&["t1"])).unwrap();
    h.fail_last(ApiFailure::Network);
    assert!(!h.store.is_online);
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::SaveFailed {
            reason: SaveFailure::Network,
            ..
        }]
    ));
    assert_eq!(h.store.complete_tasks(&ids(&["t1"])), Err(Failure::Offline));
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::OfflineBlocked { autosave: false }]
    ));
    h.store.sync();
    h.store.on_sync_done(Ok(SyncFlow {
        base_cursor: 10,
        rows: vec![],
        cursor: 10,
    }));
    assert!(h.store.is_online);
    assert!(h.store.complete_tasks(&ids(&["t1"])).is_ok());
}

#[test]
fn ログインが切れたら止まり_送信中の操作を捨てる() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    h.store
        .add_task(AddTask {
            title: "戻ってくる追加".into(),
            memo: String::new(),
            project_id: None,
            to: Destination::Inbox,
        })
        .unwrap();
    h.fail_last(ApiFailure::Unauthorized);
    assert_eq!(h.store.stopped_by, Some(StopReason::Unauthorized));
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::Unauthorized { failed_creates }] if failed_creates[0].title == "戻ってくる追加"
    ));
    assert_eq!(h.store.complete_tasks(&ids(&["t1"])), Err(Failure::Stopped));
}

#[test]
fn 完了を元に戻すと_元の場所と状態に戻る() {
    let mut h = harness();
    let mut started = task("t1", Bucket::Today, "a0");
    started.started_at = Some("2026-10-06T01:00:00.000Z".into());
    h.seed(vec![started]);
    h.store.complete_tasks(&ids(&["t1"])).unwrap();
    h.confirm_last();
    assert_eq!(h.store.lists().completed_today, ids(&["t1"]));
    let done = h.store.undo().unwrap();
    assert_eq!(done.ids, ids(&["t1"]));
    let restored = h.task("t1");
    assert!(restored.completed_at.is_none());
    assert!(restored.is_in_progress());
    // 元に戻す操作は、元に戻すの対象にならない
    assert!(!h.store.can_undo());
    h.confirm_last();
    assert_eq!(h.store.undo(), Err(Failure::NothingToUndo));
}

#[test]
fn 元に戻すが通信で失敗したら_もう一度戻せるように積み直す() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    h.store.delete_tasks(&ids(&["t1"])).unwrap();
    h.confirm_last();
    h.store.undo().unwrap();
    h.fail_last(ApiFailure::Server(503));
    assert!(h.task("t1").deleted_at.is_some());
    assert!(h.store.can_undo());
}

#[test]
fn 追加の逆は削除で_一覧から消える() {
    let mut h = harness();
    h.seed(vec![]);
    let done = h
        .store
        .add_task(AddTask {
            title: "やっぱりやめる".into(),
            memo: String::new(),
            project_id: None,
            to: Destination::Today,
        })
        .unwrap();
    h.confirm_last();
    h.store.undo().unwrap();
    assert!(h.task(&done.ids[0]).deleted_at.is_some());
    assert!(h.store.lists().today.is_empty());
}

#[test]
fn 予定へ移すと日付が入り_今日以前の日付なら今日に入る() {
    let mut h = harness();
    h.seed(vec![
        task("t1", Bucket::Inbox, "a0"),
        task("t2", Bucket::Inbox, "a1"),
    ]);
    h.store
        .move_tasks(&ids(&["t1"]), Destination::Scheduled("2026-10-09".into()))
        .unwrap();
    let moved = h.task("t1");
    assert_eq!(moved.bucket, Bucket::Scheduled);
    assert_eq!(moved.scheduled_on.as_deref(), Some("2026-10-09"));
    h.store
        .move_tasks(&ids(&["t2"]), Destination::Scheduled(TODAY.into()))
        .unwrap();
    assert_eq!(h.task("t2").bucket, Bucket::Today);
    assert_eq!(h.task("t2").scheduled_on, None);
    // 予定から出すと、同じ操作で日付が消える
    h.store
        .move_tasks(&ids(&["t1"]), Destination::Later)
        .unwrap();
    assert_eq!(h.task("t1").scheduled_on, None);
    // 送るのは1つずつなので、まだ送っていない最後のまとまりを見る
    match &h.store.replica.pending().last().unwrap().mutations[0] {
        Mutation::TaskUpdate { changes, .. } => assert_eq!(changes.scheduled_on, Some(None)),
        other => panic!("{other:?}"),
    }
}

#[test]
fn 進行中にすると今日の一番上へ移り_今日から出すと未着手に戻る() {
    let mut h = harness();
    h.seed(vec![
        task("t1", Bucket::Today, "a0"),
        task("t2", Bucket::Later, "a0"),
    ]);
    h.store.start_tasks(&ids(&["t2"])).unwrap();
    assert_eq!(h.store.lists().today, ids(&["t2", "t1"]));
    assert!(h.task("t2").is_in_progress());
    h.store
        .move_tasks(&ids(&["t2"]), Destination::Later)
        .unwrap();
    assert!(h.task("t2").started_at.is_none());
    // 位置を変えずに未着手へ
    h.store.start_tasks(&ids(&["t1"])).unwrap();
    h.store.stop_tasks(&ids(&["t1"])).unwrap();
    assert!(h.task("t1").started_at.is_none());
    assert_eq!(h.task("t1").rank, "a0");
}

#[test]
fn 今日以前の締切を付けると_今日の到着の位置へ移る_受信箱は動かない() {
    let mut h = harness();
    h.seed(vec![
        task("t1", Bucket::Today, "a1"),
        task("t2", Bucket::Later, "a0"),
        task("t3", Bucket::Inbox, "a0"),
    ]);
    h.store
        .set_deadline(&ids(&["t2", "t3"]), Some(TODAY))
        .unwrap();
    let arrived = h.task("t2");
    assert_eq!(arrived.bucket, Bucket::Today);
    assert_eq!(arrived.arrived_on.as_deref(), Some(TODAY));
    assert_eq!(h.store.lists().today, ids(&["t2", "t1"]));
    assert_eq!(h.task("t3").bucket, Bucket::Inbox);
    assert_eq!(h.task("t3").deadline_on.as_deref(), Some(TODAY));
    // 1回で両方戻る
    h.store.undo().unwrap();
    assert_eq!(h.task("t2").bucket, Bucket::Later);
    assert_eq!(h.task("t3").deadline_on, None);
}

#[test]
fn 日をずらすと_やる日と締切が同じ日数だけ動く() {
    let mut h = harness();
    let mut scheduled = task("t1", Bucket::Scheduled, "a0");
    scheduled.scheduled_on = Some("2026-10-08".into());
    scheduled.deadline_on = Some("2026-10-10".into());
    h.seed(vec![scheduled, task("t2", Bucket::Today, "a0")]);
    h.store.shift_task_dates(&ids(&["t1", "t2"]), 2).unwrap();
    assert_eq!(h.task("t1").scheduled_on.as_deref(), Some("2026-10-10"));
    assert_eq!(h.task("t1").deadline_on.as_deref(), Some("2026-10-12"));
    // 今日のタスクは、2日後の予定になる
    assert_eq!(h.task("t2").bucket, Bucket::Scheduled);
    assert_eq!(h.task("t2").scheduled_on.as_deref(), Some("2026-10-08"));
    // 前へずらして今日以前になったら今日へ
    h.store.shift_task_dates(&ids(&["t1"]), -5).unwrap();
    assert_eq!(h.task("t1").bucket, Bucket::Today);
    assert_eq!(h.task("t1").scheduled_on, None);
    assert_eq!(h.task("t1").deadline_on.as_deref(), Some("2026-10-07"));
}

#[test]
fn 並べ替えは動かした行の_rank_だけを書き換える() {
    let mut h = harness();
    let mut done = task("done", Bucket::Today, "a1V");
    done.completed_at = Some("2026-10-06T02:00:00.000Z".into());
    h.seed(vec![
        task("t1", Bucket::Today, "a0"),
        task("t2", Bucket::Today, "a1"),
        task("t3", Bucket::Today, "a2"),
        done,
    ]);
    // t1 を t2 の後ろ（t3 の前）へ。完了済みの行（a1V）の rank と重ならないところに入る
    h.store
        .reorder_tasks(&[Placement {
            ids: ids(&["t1"]),
            after: Some("t2".into()),
            before: Some("t3".into()),
        }])
        .unwrap();
    assert_eq!(h.store.lists().today, ids(&["t2", "t1", "t3"]));
    let rank = h.task("t1").rank;
    assert!(rank.as_str() > "a1" && rank.as_str() < "a1V");
    assert_eq!(h.last_batch().mutations.len(), 1);
    // 一番上へ
    h.store
        .reorder_tasks(&[Placement {
            ids: ids(&["t3"]),
            after: None,
            before: Some("t2".into()),
        }])
        .unwrap();
    assert_eq!(h.store.lists().today, ids(&["t3", "t2", "t1"]));
}

#[test]
fn あとから完了を外すと_今日の一番下に未着手で戻る() {
    let mut h = harness();
    let mut done = task("t1", Bucket::Later, "a0");
    done.completed_at = Some("2026-10-01T02:00:00.000Z".into());
    h.seed(vec![done, task("t2", Bucket::Today, "a5")]);
    assert_eq!(h.store.lists().logbook[0].date, "2026-10-01");
    h.store.uncomplete_tasks(&ids(&["t1"]), false).unwrap();
    assert_eq!(h.store.lists().today, ids(&["t2", "t1"]));
    assert!(h.store.lists().logbook.is_empty());
}

#[test]
fn プロジェクトを作って付けるのは1つの操作で_1回で戻る() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Later, "a0")]);
    let done = h.store.create_project(" 家のこと ", &ids(&["t1"])).unwrap();
    let project_id = done.ids[0].clone();
    assert_eq!(h.last_batch().mutations.len(), 2);
    assert_eq!(
        h.store.replica.project(&project_id).unwrap().name,
        "家のこと"
    );
    assert_eq!(
        h.task("t1").project_id.as_deref(),
        Some(project_id.as_str())
    );
    assert_eq!(h.store.lists().projects, vec![project_id.clone()]);
    assert_eq!(h.store.lists().project_color(&project_id), Some("violet"));
    // 未完了のタスクが残っているとアーカイブできない
    assert_eq!(
        h.store.update_project(
            &project_id,
            ProjectChanges {
                archived_at: Some(Some(NOW.into())),
                ..Default::default()
            }
        ),
        Err(Failure::HasOpenTasks)
    );
    h.store.undo().unwrap();
    assert_eq!(h.task("t1").project_id, None);
    assert!(h.store.lists().projects.is_empty());
}

#[test]
fn チェックリストの更新には_変える前の配列を添える() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Today, "a0")]);
    let item = ChecklistItem {
        id: "c1".into(),
        title: "卵".into(),
        done: false,
    };
    h.store
        .update_task(
            "t1",
            TaskChanges {
                checklist: Some(vec![item.clone()]),
                ..Default::default()
            },
            PerformOptions::default(),
        )
        .unwrap();
    match &h.last_batch().mutations[0] {
        Mutation::TaskUpdate { base_checklist, .. } => {
            assert_eq!(base_checklist.as_deref(), Some(&[][..]));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(h.task("t1").checklist, vec![item]);
}

#[test]
fn 変えるものがなければ送らない() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Today, "a0")]);
    assert_eq!(
        h.store.set_priority(&ids(&["t1"]), None),
        Err(Failure::Noop)
    );
    assert_eq!(
        h.store.move_tasks(&ids(&["t1"]), Destination::Today),
        Err(Failure::Noop)
    );
    assert!(
        h.store
            .set_priority(&ids(&["t1"]), Some(Priority::High))
            .is_ok()
    );
    assert_eq!(
        h.store.set_points(&ids(&["t1"]), Some(4)),
        Err(Failure::Invalid)
    );
}

#[test]
fn 変える項目をそろえる() {
    let mut current = task("t1", Bucket::Today, "a0");
    current.started_at = Some(NOW.into());
    // 進行中のタスクを今日から出すと、未着手に戻る
    let moved = normalize_task_changes(
        &current,
        TaskChanges {
            bucket: Some(Bucket::Later),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(moved.started_at, Some(None));
    // 今日の外で startedAt を入れようとしたら受け付けない（今と同じ値でも）
    assert!(
        normalize_task_changes(
            &current,
            TaskChanges {
                bucket: Some(Bucket::Later),
                started_at: Some(Some(NOW.into())),
                ..Default::default()
            },
        )
        .is_none()
    );
    // 予定にするのに日付がない
    assert!(
        normalize_task_changes(
            &current,
            TaskChanges {
                bucket: Some(Bucket::Scheduled),
                ..Default::default()
            },
        )
        .is_none()
    );
    // 空のタイトル
    assert!(
        normalize_task_changes(
            &current,
            TaskChanges {
                title: Some("  ".into()),
                ..Default::default()
            },
        )
        .is_none()
    );
}

#[test]
fn 差分の取得のあいだに確定した行は_全件の置き換えのあとに重ね直す() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    h.store.complete_tasks(&ids(&["t1"])).unwrap();
    // 取り直し（reset）のあいだに、操作の応答が先に届く
    h.store.sync();
    h.confirm_last();
    h.store.on_sync_done(Ok(SyncFlow {
        base_cursor: 0,
        rows: vec![SyncRow::Task(task("t1", Bucket::Inbox, "a0"))],
        cursor: 20,
    }));
    assert!(h.task("t1").completed_at.is_some());
    // 取得中に来たきっかけは、終わったあとにもう1回
    h.store.sync();
    h.store.sync();
    assert_eq!(h.sent.borrow().syncs, vec![0, 10, 20]);
    h.store.on_sync_done(Ok(SyncFlow {
        base_cursor: 20,
        rows: vec![],
        cursor: 20,
    }));
    assert_eq!(h.sent.borrow().syncs, vec![0, 10, 20, 20]);
}

#[test]
fn 午前4時を過ぎると今日が変わり_完了は完了ログへ移る() {
    let mut h = harness();
    let mut done = task("t1", Bucket::Today, "a0");
    done.completed_at = Some(NOW.into());
    h.seed(vec![done]);
    assert_eq!(h.store.lists().completed_today, ids(&["t1"]));
    assert!(!h.store.refresh_day());
    *h.clock.borrow_mut() = parse_iso("2026-10-06T19:00:00.000Z").unwrap();
    assert!(h.store.refresh_day());
    assert_eq!(h.store.today, "2026-10-07");
    assert!(h.store.lists().completed_today.is_empty());
    assert_eq!(h.store.lists().logbook[0].date, TODAY);
}

#[test]
fn 元に戻すと決まりが崩れるときは_戻さずに知らせる() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Today, "a0")]);
    h.store.start_tasks(&ids(&["t1"])).unwrap();
    h.confirm_last();
    h.store.stop_tasks(&ids(&["t1"])).unwrap();
    h.confirm_last();
    // ほかの画面が、あとでへ移した
    let mut moved = h.task("t1");
    moved.bucket = Bucket::Later;
    moved.seq = 999;
    h.store.sync();
    h.store.on_sync_done(Ok(SyncFlow {
        base_cursor: 10,
        rows: vec![SyncRow::Task(moved)],
        cursor: 999,
    }));
    let sent = h.batch_count();
    // 「未着手に戻した」を戻すと、あとでにあるのに進行中になってしまう
    assert_eq!(h.store.undo(), Err(Failure::Conflict));
    assert_eq!(h.batch_count(), sent);
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::SaveFailed {
            reason: SaveFailure::Conflict,
            undo_conflict: true,
            ..
        }]
    ));
}
