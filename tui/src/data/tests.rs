//! データ層のテスト。通信は偽物（送ったものを覚えるだけ）に差し替え、応答はテストが on_*_done で渡す

use std::cell::RefCell;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::rc::Rc;
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::Duration;

use chrono::{DateTime, Utc};
use crossterm::event::{KeyCode, KeyEvent};

use super::actions::{AddTask, Destination, Placement, normalize_task_changes};
use super::device::DeviceDb;
use super::local_db::{LocalDb, PendingOwner, unsent_count_at};
use super::open_local;
use super::replica::PendingBatch;
use super::store::{
    ApiFailure, Failure, Limit, Notice, PerformOptions, Quota, SaveFailure, StopReason, Store,
    StoreOptions, SyncFlow, Transport,
};
use crate::config::Config;
use crate::dates::{APP_TIME_ZONE, device_time_zone, parse_iso};
use crate::model::{
    Bucket, ChecklistItem, Mutation, MutationBatch, NewTask, Priority, Project, ProjectChanges,
    SyncRow, Task, TaskChanges,
};
use crate::ui::AppEvent;
use crate::ui::app::App;
use crate::ui::login::LoginStep;

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
    harness_with(None)
}

fn harness_with(local: Option<LocalDb>) -> Harness {
    open(local, PendingOwner::default())
}

/// owner のログインで開く
fn open(local: Option<LocalDb>, owner: PendingOwner) -> Harness {
    let sent = Rc::new(RefCell::new(Sent::default()));
    let clock = Rc::new(RefCell::new(parse_iso(NOW).unwrap()));
    let store = Store::new(StoreOptions {
        transport: Box::new(FakeTransport(Rc::clone(&sent))),
        local,
        owner,
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
            time_zone: None,
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
        mutation_index: None,
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
        time_zone: None,
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

fn temp_db_path(name: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "nagi-store-test-{name}-{}-{}.db",
        std::process::id(),
        uuid::Uuid::now_v7()
    ))
}

fn remove_db(path: &std::path::Path) {
    for suffix in ["", "-wal", "-shm"] {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        let _ = std::fs::remove_file(name);
    }
}

/// 控えの pending の表にある、送っていないまとまりの数（持ち主を問わない）
fn kept(path: &std::path::Path) -> usize {
    unsent_count_at(path).unwrap()
}

fn add_to_inbox(h: &mut Harness, title: &str) -> String {
    h.store
        .add_task(AddTask {
            title: title.into(),
            memo: String::new(),
            project_id: None,
            to: Destination::Inbox,
        })
        .unwrap()
        .ids[0]
        .clone()
}

fn write_memo(h: &mut Harness, id: &str, memo: &str) {
    h.store
        .update_task(
            id,
            TaskChanges {
                memo: Some(memo.into()),
                ..Default::default()
            },
            PerformOptions::default(),
        )
        .unwrap();
}

fn pending_ids(h: &Harness) -> Vec<String> {
    h.store
        .replica
        .pending()
        .iter()
        .map(|batch| batch.id.clone())
        .collect()
}

impl Harness {
    /// 差分の取得が、何も変わらずに通る
    fn sync_unchanged(&mut self) {
        self.store.sync();
        self.store.on_sync_done(Ok(SyncFlow {
            base_cursor: 10,
            rows: vec![],
            cursor: 10,
            time_zone: None,
        }));
    }
}

#[test]
fn nagiの更新が要るときは_送っていない変更を捨てずに止まり_控えのpendingに書く() {
    let path = temp_db_path("upgrade");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut h, "残る追加");
    write_memo(&mut h, "t1", "残るメモ");
    h.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });

    assert_eq!(h.store.stopped_by, Some(StopReason::VersionMismatch));
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::UpgradeRequired]
    ));
    assert!(h.store.unsent_kept());
    assert_eq!(h.store.pending_count(), 2);
    assert_eq!(h.task(&added).title, "残る追加");
    assert_eq!(h.task("t1").memo, "残るメモ");
    let db = LocalDb::open(&path).unwrap();
    let loaded = |db: &LocalDb| -> Vec<PendingBatch> {
        db.load_pending(&PendingOwner::default()).unwrap().batches
    };
    assert_eq!(loaded(&db), h.store.replica.pending());

    // 止まったあとの操作も受け付けて、送らずに書き足す
    let sent = h.batch_count();
    add_to_inbox(&mut h, "止まったあとの追加");
    assert_eq!(h.batch_count(), sent);
    assert_eq!(h.store.pending_count(), 3);
    assert_eq!(loaded(&db), h.store.replica.pending());
    assert_eq!(kept(&path), 3);
    remove_db(&path);
}

#[test]
fn 開き直すと_控えのpendingのまとまりが列に戻り_最初の同期のあとに同じidで送られ_確定した分から表を消す()
 {
    let path = temp_db_path("reopen");
    let mut before = harness_with(Some(LocalDb::open(&path).unwrap()));
    before.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut before, "残る追加");
    write_memo(&mut before, "t1", "残るメモ");
    before.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    let kept_ids = pending_ids(&before);
    drop(before);

    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    assert_eq!(h.store.pending_count(), 2);
    assert_eq!(h.task(&added).title, "残る追加");
    assert_eq!(h.task("t1").memo, "残るメモ");
    assert_eq!(h.batch_count(), 0);

    h.sync_unchanged();
    assert_eq!(h.last_batch().id, kept_ids[0]);
    h.confirm_last();
    assert_eq!(kept(&path), 1);
    assert_eq!(h.last_batch().id, kept_ids[1]);
    h.confirm_last();
    assert_eq!(kept(&path), 0);
    assert_eq!(h.store.pending_count(), 0);
    assert_eq!(h.task("t1").memo, "残るメモ");
    remove_db(&path);
}

#[test]
fn workerの更新を待つあいだは止めずに持ち_同期が通ったら同じidで送り直す() {
    let path = temp_db_path("server-behind");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut h, "待つ追加");
    let first = h.last_batch().id;
    h.fail_last(ApiFailure::ServerBehind);

    assert_eq!(h.store.stopped_by, None);
    assert!(h.store.waiting_for_server);
    assert!(!h.store.is_online);
    assert!(h.store.take_notices().is_empty());
    assert_eq!(h.task(&added).title, "待つ追加");
    // 待つあいだも受け付けるが、送らない（閉じても残るよう控えに書く）
    add_to_inbox(&mut h, "待つあいだの追加");
    assert_eq!(h.batch_count(), 1);
    assert_eq!(kept(&path), 2);

    // まだ古い Worker
    h.store.sync();
    h.store.on_sync_done(Err(ApiFailure::ServerBehind));
    assert_eq!(h.batch_count(), 1);
    // Worker が更新された
    h.sync_unchanged();
    assert!(h.store.is_online && !h.store.waiting_for_server);
    assert_eq!(h.batch_count(), 2);
    assert_eq!(h.last_batch().id, first);
    h.confirm_last();
    h.confirm_last();
    assert_eq!(h.store.pending_count(), 0);
    assert_eq!(kept(&path), 0);
    remove_db(&path);
}

#[test]
fn 持っていたまとまりも_ログインが切れたら捨て_控えのpendingから消す() {
    let path = temp_db_path("kept-unauthorized");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut h, "捨てる追加");
    h.fail_last(ApiFailure::ServerBehind);
    assert_eq!(kept(&path), 1);

    h.store.sync();
    h.store.on_sync_done(Err(ApiFailure::Unauthorized));
    assert_eq!(h.store.stopped_by, Some(StopReason::Unauthorized));
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::Unauthorized { failed_creates }] if failed_creates[0].title == "捨てる追加"
    ));
    assert_eq!(h.store.pending_count(), 0);
    assert!(h.store.replica.task(&added).is_none());
    assert_eq!(kept(&path), 0);
    remove_db(&path);
}

#[test]
fn nagiの更新を待って止まったあとに届いた401も受け_持っていた変更を捨てる() {
    // 同期が先に版のずれで返り、送っていた操作があとから 401 で返る
    let path = temp_db_path("upgrade-then-401");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut h, "捨てる追加");
    h.store.sync();
    h.store
        .on_sync_done(Err(ApiFailure::UpgradeRequired { min_api_version: 4 }));
    assert_eq!(h.store.stopped_by, Some(StopReason::VersionMismatch));
    assert_eq!(kept(&path), 1);
    h.fail_last(ApiFailure::Unauthorized);
    assert_eq!(h.store.stopped_by, Some(StopReason::Unauthorized));
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::UpgradeRequired, Notice::Unauthorized { failed_creates }]
            if failed_creates[0].title == "捨てる追加"
    ));
    assert_eq!(h.store.pending_count(), 0);
    assert_eq!(kept(&path), 0);
    remove_db(&path);

    // 逆の順：送っていた操作が先に版のずれで返り、同期があとから 401 で返る
    let path = temp_db_path("upgrade-then-401-sync");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut h, "捨てる追加");
    h.store.sync();
    h.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    assert_eq!(kept(&path), 1);
    h.store.on_sync_done(Err(ApiFailure::Unauthorized));
    assert_eq!(h.store.stopped_by, Some(StopReason::Unauthorized));
    assert_eq!(h.store.pending_count(), 0);
    assert_eq!(kept(&path), 0);
    remove_db(&path);
}

#[test]
fn 持ち主の分からないトークンで残した変更は_別のトークンでは送らずに控えに残す() {
    // NAGI_TOKEN で開き、Worker に持ち主を聞けなかった（利用者の ID なし）。控えは Worker ごとの 1 つ
    let path = temp_db_path("owner");
    let token_a = PendingOwner::new(None, Some("token-a"));
    let mut before = open(Some(LocalDb::open(&path).unwrap()), token_a.clone());
    before.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut before, "A の非公開の追加");
    before.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    let kept_ids = pending_ids(&before);
    drop(before);

    // NAGI_TOKEN を B に替えたが、B の持ち主も聞けなかった
    let mut other = open(
        Some(LocalDb::open(&path).unwrap()),
        PendingOwner::new(None, Some("token-b")),
    );
    assert_eq!(other.store.pending_count(), 0);
    assert!(other.store.replica.task(&added).is_none());
    other.sync_unchanged();
    assert_eq!(other.batch_count(), 0);
    assert_eq!(kept(&path), 1);
    drop(other);

    // A のトークンで開き直せば送る
    let mut again = open(Some(LocalDb::open(&path).unwrap()), token_a);
    assert_eq!(again.store.pending_count(), 1);
    again.sync_unchanged();
    assert_eq!(again.last_batch().id, kept_ids[0]);
    remove_db(&path);
}

#[test]
fn 持ち主を聞けずにworkerごとの控えへ残した変更は_持ち主が分かった起動で利用者の控えへ移して送る() {
    let dir = std::env::temp_dir().join(format!(
        "nagi-store-test-adopt-{}-{}",
        std::process::id(),
        uuid::Uuid::now_v7()
    ));
    let config = Config::at("https://nagi.example.com", &dir);
    // NAGI_TOKEN（A）で開き、Worker に持ち主を聞けなかった。控えは Worker ごとの 1 つ
    let unknown_a = PendingOwner::new(None, Some("token-a"));
    let mut before = open(open_local(&config, None, &unknown_a), unknown_a);
    before.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut before, "A の 1 つめ");
    before.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    add_to_inbox(&mut before, "A の 2 つめ");
    let kept_ids = pending_ids(&before);
    assert_eq!(kept_ids.len(), 2);
    drop(before);
    // 別のトークン（B）で残したものは、移さない
    let unknown_b = PendingOwner::new(None, Some("token-b"));
    let mut other = open(open_local(&config, None, &unknown_b), unknown_b);
    other.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut other, "B の追加");
    other.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    drop(other);
    assert_eq!(kept(&config.db_path(None)), 3);

    // 次の起動では、A の持ち主（u1）が分かった。利用者の控えを開く
    let owner = PendingOwner::new(Some("u1"), Some("token-a"));
    assert_ne!(config.db_path(Some("u1")), config.db_path(None));
    let mut after = open(open_local(&config, Some("u1"), &owner), owner.clone());
    assert_eq!(pending_ids(&after), kept_ids);
    assert_eq!(kept(&config.db_path(None)), 1);
    after.sync_unchanged();
    assert_eq!(after.last_batch().id, kept_ids[0]);
    drop(after);

    // 開き直しても、二重にはならない
    let again = open(open_local(&config, Some("u1"), &owner), owner);
    assert_eq!(pending_ids(&again), kept_ids);
    drop(again);
    let _ = std::fs::remove_dir_all(&dir);
}

/// path の控えで追加を 1 つ送り、版のずれで断られて控えに残す（止まったあいだの操作は、呼んだ側が足す）
fn keep_on_upgrade(path: &std::path::Path, title: &str) -> (String, Harness) {
    let mut before = harness_with(Some(LocalDb::open(path).unwrap()));
    before.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let added = add_to_inbox(&mut before, title);
    before.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    (added, before)
}

#[test]
fn 控えに書けなければ_残したことにせず_書けるまで書き直す() {
    let path = temp_db_path("unwritable");
    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut h, "書けない追加");
    h.store.local_db().unwrap().set_read_only(true);
    h.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    assert_eq!(h.store.stopped_by, Some(StopReason::VersionMismatch));
    assert!(!h.store.unsent_kept());
    add_to_inbox(&mut h, "止まったあいだの追加");
    assert!(!h.store.unsent_kept());
    // 差分を取るきっかけごとに書き直す（まだ書けない）
    h.store.sync();
    assert!(!h.store.unsent_kept());
    assert_eq!(kept(&path), 0);

    h.store.local_db().unwrap().set_read_only(false);
    h.store.sync();
    assert!(h.store.unsent_kept());
    assert_eq!(kept(&path), 2);
    remove_db(&path);
}

#[test]
fn 控えを開けていなければ_送っていない変更は残せていない() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    add_to_inbox(&mut h, "残せない追加");
    h.fail_last(ApiFailure::UpgradeRequired { min_api_version: 4 });
    assert_eq!(h.store.stopped_by, Some(StopReason::VersionMismatch));
    assert_eq!(h.store.pending_count(), 1);
    assert!(!h.store.unsent_kept());
}

#[test]
fn 控えに読めない変更があれば_その前の変更も送らずに止め_新しい変更は書き足す() {
    let path = temp_db_path("unreadable");
    let (added, mut before) = keep_on_upgrade(&path, "読める追加");
    add_to_inbox(&mut before, "あとで読めなくなる追加");
    let kept_ids = pending_ids(&before);
    drop(before);
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE pending SET json = '{\"id\":\"x\"}' WHERE id = ?1",
            [&kept_ids[1]],
        )
        .unwrap();

    let mut h = harness_with(Some(LocalDb::open(&path).unwrap()));
    assert_eq!(h.store.stopped_by, Some(StopReason::UnreadablePending));
    assert_eq!(h.task(&added).title, "読める追加");
    h.store.sync();
    assert!(h.sent.borrow().syncs.is_empty());
    add_to_inbox(&mut h, "止まっているあいだの追加");
    assert_eq!(h.batch_count(), 0);
    assert_eq!(kept(&path), 3);
    remove_db(&path);
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
        time_zone: None,
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
        time_zone: None,
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
        time_zone: None,
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

#[test]
fn 同期の応答のタイムゾーンで_今日が変わる() {
    let mut h = harness();
    assert_eq!(h.store.today, TODAY);

    let sync_with = |h: &mut Harness, time_zone: Option<&str>| {
        h.store.sync();
        h.store.on_sync_done(Ok(SyncFlow {
            base_cursor: 10,
            rows: vec![],
            cursor: 10,
            time_zone: time_zone.map(str::to_string),
        }));
    };
    // 東京の 12:00 は、Pago Pago（UTC-11）ではまだ前の日の 16:00
    sync_with(&mut h, Some("Pacific/Pago_Pago"));
    assert_eq!(h.store.tz, chrono_tz::Pacific::Pago_Pago);
    assert_eq!(h.store.today, "2026-10-05");

    // 知らない名前と、ゾーンのない応答（古い Worker）では変わらない
    sync_with(&mut h, Some("Mars/Base"));
    sync_with(&mut h, None);
    assert_eq!(h.store.today, "2026-10-05");

    // 大文字と小文字だけが違う名前も読む（Worker の Intl は区別せずに受け付ける）
    sync_with(&mut h, Some("asia/TOKYO"));
    assert_eq!(h.store.tz, APP_TIME_ZONE);
    assert_eq!(h.store.today, TODAY);
    // 変えるのに、差分を取り直さない（Worker は同じゾーンで切り替えてから行を返している）
    assert_eq!(h.sent.borrow().syncs.len(), 4);
}

/// 届いた要求を1つ、本文まで読む。応答はまだ返さないので、送った側は待ったまま
fn accept_request(listener: &TcpListener) -> (TcpStream, String) {
    let (mut stream, _) = listener.accept().unwrap();
    let mut request = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let read = stream.read(&mut buf).unwrap();
        assert!(read > 0, "要求の途中で切れました");
        request.extend_from_slice(&buf[..read]);
        let text = String::from_utf8_lossy(&request).into_owned();
        let Some(head_end) = text.find("\r\n\r\n") else {
            continue;
        };
        let length = text[..head_end]
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .map_or(0, |(_, value)| value.trim().parse().unwrap());
        if request.len() >= head_end + 4 + length {
            return (stream, text);
        }
    }
}

#[test]
fn タイムゾーンを書いているあいだは_日付が変わっても差分を取らず_書けなかったときも終われば取る() {
    let Harness {
        store, sent, clock, ..
    } = harness();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let dir = std::env::temp_dir().join(format!("nagi-time-zone-gate-{}", uuid::Uuid::now_v7()));
    let config = Config::at(&format!("http://{}", listener.local_addr().unwrap()), &dir);
    config.save_session("token-1", None).unwrap();
    // Worker に伝えてあるのは、端末と違うゾーン（端末のゾーンを変えたあと）
    let told = if device_time_zone() == chrono_tz::Pacific::Pago_Pago {
        "Asia/Tokyo"
    } else {
        "Pacific/Pago_Pago"
    };
    config.save_time_zone("token-1", told).unwrap();
    let (events, _events) = channel();
    let mut app = App::new(config, store, crate::auth::Login::default(), events);

    app.sync_now();
    let (mut stream, request) = accept_request(&listener);
    assert!(request.starts_with("POST /api/time-zone "), "{request}");

    // 書いているあいだに東京の午前4時を越え、端末にフォーカスも戻る
    *clock.borrow_mut() = parse_iso("2026-10-06T19:00:00.000Z").unwrap();
    app.tick();
    assert_eq!(app.store.today, "2026-10-07");
    app.on_focus_gained();
    app.tick();
    assert!(sent.borrow().syncs.is_empty());

    let body = r#"{"error":"internal"}"#;
    write!(
        stream,
        "HTTP/1.1 500 Internal Server Error\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
    drop(stream);
    for _ in 0..500 {
        app.tick();
        if !sent.borrow().syncs.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // 待たせていたきっかけは、まとめて1回
    assert_eq!(sent.borrow().syncs, vec![0]);
    assert_eq!(
        app.config.saved_session().unwrap().time_zone.as_deref(),
        Some(told)
    );
    fs::remove_dir_all(dir).unwrap();
}

fn add(title: &str) -> AddTask {
    AddTask {
        title: title.into(),
        memo: String::new(),
        project_id: None,
        to: Destination::Inbox,
    }
}

#[test]
fn 上限ちょうどは送り_超えたら送らずに断る() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    assert!(h.store.add_task(add(&"あ".repeat(500))).is_ok());
    assert_eq!(h.batch_count(), 1);
    // UTF-16 で数える。BMP の外の文字は 2 つに数える
    assert_eq!(
        h.store.add_task(add(&"𠮷".repeat(251))),
        Err(Failure::TooLong(Limit::Title))
    );
    assert_eq!(
        h.store.add_task(add(&"a".repeat(501))),
        Err(Failure::TooLong(Limit::Title))
    );
    let update = |changes: TaskChanges| {
        move |h: &mut Harness| {
            h.store
                .update_task("t1", changes, PerformOptions::default())
        }
    };
    assert_eq!(
        update(TaskChanges {
            memo: Some("a".repeat(20001)),
            ..Default::default()
        })(&mut h),
        Err(Failure::TooLong(Limit::Memo))
    );
    let items = |count: usize, len: usize| {
        (0..count)
            .map(|i| ChecklistItem {
                id: format!("c{i}"),
                title: "a".repeat(len),
                done: false,
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(
        update(TaskChanges {
            checklist: Some(items(201, 1)),
            ..Default::default()
        })(&mut h),
        Err(Failure::TooLong(Limit::ChecklistItems))
    );
    assert_eq!(
        update(TaskChanges {
            checklist: Some(items(1, 501)),
            ..Default::default()
        })(&mut h),
        Err(Failure::TooLong(Limit::ChecklistItem))
    );
    assert!(
        update(TaskChanges {
            checklist: Some(items(200, 500)),
            ..Default::default()
        })(&mut h)
        .is_ok()
    );
    assert_eq!(
        h.store.create_project(&"a".repeat(101), &[]),
        Err(Failure::TooLong(Limit::ProjectName))
    );
    // 断った操作は送っていない（上限ちょうどの 2 件だけ）
    assert_eq!(h.batch_count(), 1);
    assert_eq!(h.store.pending_count(), 2);
}

#[test]
fn 行数の上限で断られたら_上限の知らせを出して表示を戻す() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    let id = h.store.add_task(add("あふれる")).unwrap().ids[0].clone();
    h.fail_last(ApiFailure::Rejected {
        status: 400,
        reason: Some("quota_exceeded".into()),
        mutation_index: Some(0),
    });
    assert!(h.store.replica.task(&id).is_none());
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::SaveFailed {
            reason: SaveFailure::Quota(Quota::Tasks),
            ..
        }]
    ));
}

#[test]
fn 上限の知らせは_断られた操作で決め_あとに続く別の操作では決めない() {
    let mut h = harness();
    h.seed(vec![task("t1", Bucket::Inbox, "a0")]);
    // プロジェクトの追加を送っているあいだに、タスクを足した（まだ送っていない）
    h.store.create_project("新しい", &[]).unwrap();
    h.store.add_task(add("続けて足す")).unwrap();
    h.fail_last(ApiFailure::Rejected {
        status: 400,
        reason: Some("quota_exceeded".into()),
        mutation_index: Some(0),
    });
    assert!(matches!(
        h.store.take_notices().as_slice(),
        [Notice::SaveFailed {
            reason: SaveFailure::Quota(Quota::Projects),
            ..
        }]
    ));
}

fn import_export(projects: usize, tasks: usize, memo: &str) -> super::device::Export {
    super::device::Export {
        projects: (0..projects)
            .map(|i| serde_json::json!({ "id": format!("p{i}"), "name": "project" }))
            .collect(),
        tasks: (0..tasks)
            .map(|i| serde_json::json!({ "id": format!("t{i}"), "title": "task", "memo": memo }))
            .collect(),
    }
}

/// 送る本文から、行の id を順に取り出す（プロジェクト、タスクの順）
fn import_ids(body: &str) -> Vec<String> {
    let document: serde_json::Value = serde_json::from_str(body).unwrap();
    ["projects", "tasks"]
        .iter()
        .flat_map(|key| document[key].as_array().unwrap().iter())
        .map(|row| row["id"].as_str().unwrap().to_string())
        .collect()
}

#[test]
fn 取り込みの本文は_500行ずつに分け_プロジェクトをタスクより先に送る() {
    let export = import_export(3, 1200, "");
    let chunks =
        super::net::split_import(&export, "2026-10-12T00:00:00.000Z", "nagi 0.1.0").unwrap();
    assert_eq!(
        chunks.iter().map(|chunk| chunk.rows()).collect::<Vec<_>>(),
        [500, 500, 203]
    );
    // 最初の本文の頭にプロジェクトが全部あり、あとの本文はタスクだけ
    assert_eq!(chunks[0].projects, 3);
    assert!(chunks[1..].iter().all(|chunk| chunk.projects == 0));
    let sent: Vec<String> = chunks
        .iter()
        .flat_map(|chunk| import_ids(&chunk.body))
        .collect();
    let expected: Vec<String> = (0..3)
        .map(|i| format!("p{i}"))
        .chain((0..1200).map(|i| format!("t{i}")))
        .collect();
    assert_eq!(sent, expected);
    let document: serde_json::Value = serde_json::from_str(&chunks[0].body).unwrap();
    assert_eq!(document["format"], "nagi-export");
    assert_eq!(document["formatVersion"], 1);
    assert_eq!(document["app"], "nagi 0.1.0");
}

#[test]
fn 取り込みの本文は_900kib以下に分ける() {
    // 1 件が約 6 KB のメモ（全角 2000 文字）。行数の上限より先に、大きさの上限に当たる
    let export = import_export(2, 400, &"あ".repeat(2000));
    let chunks =
        super::net::split_import(&export, "2026-10-12T00:00:00.000Z", "nagi 0.1.0").unwrap();
    assert!(chunks.len() > 2);
    for chunk in &chunks {
        assert!(chunk.body.len() <= super::net::MAX_IMPORT_BODY_BYTES);
        assert!(chunk.rows() < super::net::MAX_IMPORT_ROWS);
        serde_json::from_str::<serde_json::Value>(&chunk.body).unwrap();
    }
    let sent: usize = chunks.iter().map(|chunk| chunk.rows()).sum();
    assert_eq!(sent, 402);
    assert_eq!(chunks.iter().map(|chunk| chunk.projects).sum::<usize>(), 2);
}

#[test]
fn 一件で上限を超える行は_黙って捨てずに断る() {
    let export = import_export(0, 1, &"a".repeat(1024 * 1024));
    let error =
        super::net::split_import(&export, "2026-10-12T00:00:00.000Z", "nagi 0.1.0").unwrap_err();
    assert!(error.contains("t0"), "{error}");
    assert!(
        super::net::split_import(&import_export(0, 0, ""), "2026-10-12T00:00:00.000Z", "nagi")
            .unwrap()
            .is_empty()
    );
}

/// 取り込みの要求を `replies.len()` 回受け、要求の頭（要求の行とヘッダー）と本文を順に返す。応答は、1 回ごとに `replies` の文
fn serve_imports(
    listener: TcpListener,
    replies: Vec<(u16, String)>,
) -> thread::JoinHandle<Vec<(String, String)>> {
    thread::spawn(move || {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut stream, request) = accept_request(&listener);
            let (head, text) = request.split_once("\r\n\r\n").unwrap();
            assert!(head.starts_with("POST /api/import"), "{head}");
            requests.push((head.to_string(), text.to_string()));
            write!(
                stream,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        }
        requests
    })
}

fn import_reply(chunk: &super::net::ImportChunk) -> (u16, String) {
    (
        200,
        format!(
            r#"{{"tasks":{{"new":{},"existing":0}},"projects":{{"new":{},"existing":0}},"detachedTasks":0}}"#,
            chunk.tasks, chunk.projects
        ),
    )
}

#[test]
fn 取り込みは_本文を順に送り_進み具合と合計を返す() {
    let export = import_export(2, 700, "");
    let chunks =
        super::net::split_import(&export, "2026-10-12T00:00:00.000Z", "nagi 0.1.0").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = super::net::ApiClient::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        Some("token-1".into()),
    );
    let server = serve_imports(listener, chunks.iter().map(import_reply).collect());

    let mut progress = Vec::new();
    let counts = super::net::run_import(&client, &chunks, false, |done, total| {
        progress.push((done, total));
    })
    .unwrap();

    assert_eq!(progress, [(500, 702), (702, 702)]);
    assert_eq!((counts.projects.new, counts.tasks.new), (2, 700));
    let requests = server.join().unwrap();
    assert_eq!(import_ids(&requests[0].1)[..2], ["p0", "p1"]);
    assert_eq!(import_ids(&requests[1].1).last().unwrap(), "t699");
}

#[test]
fn 取り込みが途中で断られたら_そこまでに移した件数と_やり直せることを伝える() {
    let export = import_export(0, 700, "");
    let chunks =
        super::net::split_import(&export, "2026-10-12T00:00:00.000Z", "nagi 0.1.0").unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let client = super::net::ApiClient::new(
        &format!("http://{}", listener.local_addr().unwrap()),
        Some("token-1".into()),
    );
    let server = serve_imports(
        listener,
        vec![
            import_reply(&chunks[0]),
            (
                400,
                r#"{"error":"invalid_request","reason":"quota_exceeded"}"#.to_string(),
            ),
        ],
    );

    let error = super::net::run_import(&client, &chunks, false, |_, _| {}).unwrap_err();
    server.join().unwrap();
    assert!(error.contains("上限"), "{error}");
    assert!(error.contains("500 件までは移してあります"), "{error}");
}

const IMPORT_COUNTS: &str =
    r#"{"tasks":{"new":1,"existing":0},"projects":{"new":0,"existing":0},"detachedTasks":0}"#;

/// クラウドで開いた画面。保存してあるログインは利用者 A（token-a）で、ストアのログイン（NAGI_TOKEN で開いたときのように）は
/// 利用者 B（token-b）。`local_task` なら、この端末のデータにタスクを 1 件入れておく
fn import_app(
    name: &str,
    server: &str,
    local_task: bool,
) -> (App, Receiver<AppEvent>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("nagi-import-{name}-{}", uuid::Uuid::now_v7()));
    let config = Config::at(server, &dir);
    config.save_session("token-a", Some("user-a")).unwrap();
    if local_task {
        let mut device = DeviceDb::open(&config.device_db_path()).unwrap();
        let task = NewTask {
            id: uuid::Uuid::now_v7().to_string(),
            title: "この端末のタスク".into(),
            memo: String::new(),
            bucket: Bucket::Inbox,
            scheduled_on: None,
            project_id: None,
            rank: "a0".into(),
        };
        let batch = MutationBatch {
            id: uuid::Uuid::now_v7().to_string(),
            mutations: vec![Mutation::TaskCreate { task }],
        };
        device.mutate(&batch, Utc::now()).unwrap();
    }
    let (events, inbox) = channel();
    let account = crate::auth::Login {
        token: Some("token-b".into()),
        user_id: Some("user-b".into()),
    };
    (
        App::new(config, harness().store, account, events),
        inbox,
        dir,
    )
}

/// 取り込みのスレッドからの知らせを 1 つ待って、画面に渡す
fn next_login_event(app: &mut App, inbox: &Receiver<AppEvent>) {
    loop {
        if let AppEvent::Login(_, event) = inbox.recv_timeout(Duration::from_secs(10)).unwrap() {
            app.on_login_event(event);
            return;
        }
    }
}

fn import_step(app: &App) -> &LoginStep {
    &app.login
        .as_ref()
        .expect("取り込みの画面が出ていません")
        .step
}

fn press_enter(app: &mut App) {
    app.handle_login_key(&KeyEvent::from(KeyCode::Enter));
}

#[test]
fn 取り込みはストアと同じログインで確かめて移し_確かめたあとにログインのファイルが替わっても送り先は変わらない()
 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let requests = serve_imports(
        listener,
        vec![(200, IMPORT_COUNTS.into()), (200, IMPORT_COUNTS.into())],
    );
    let (mut app, inbox, dir) = import_app("same-login", &server, true);

    app.check_import(true);
    next_login_event(&mut app, &inbox);
    assert!(matches!(import_step(&app), LoginStep::ImportOffer { .. }));
    // 聞いているあいだに、ほかの nagi が別の利用者でログインし直した
    app.config.save_session("token-c", Some("user-c")).unwrap();
    press_enter(&mut app);
    while let Some(login) = &app.login {
        assert!(!matches!(login.step, LoginStep::ImportFailed { .. }));
        next_login_event(&mut app, &inbox);
    }

    let requests = requests.join().unwrap();
    assert!(requests[0].0.starts_with("POST /api/import?dryRun=1 "));
    assert!(requests[1].0.starts_with("POST /api/import "));
    for (head, _) in &requests {
        assert!(
            head.to_ascii_lowercase()
                .contains("authorization: bearer token-b"),
            "{head}"
        );
    }
    let user_b = app.config.import_offer_key(Some("user-b"));
    assert_eq!(
        app.config
            .load_prefs()
            .import_offered
            .into_iter()
            .collect::<Vec<_>>(),
        [user_b]
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn 確かめたあとにログインが替わったら_移さず_聞いた印も付けない() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let requests = serve_imports(listener, vec![(200, IMPORT_COUNTS.into())]);
    let (mut app, inbox, dir) = import_app("login-changed", &server, true);

    app.check_import(true);
    next_login_event(&mut app, &inbox);
    assert!(matches!(import_step(&app), LoginStep::ImportOffer { .. }));
    app.account = crate::auth::Login {
        token: Some("token-c".into()),
        user_id: Some("user-c".into()),
    };
    press_enter(&mut app);

    assert!(app.login.is_none());
    assert_eq!(requests.join().unwrap().len(), 1);
    assert!(inbox.recv_timeout(Duration::from_millis(200)).is_err());
    assert!(app.config.load_prefs().import_offered.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn この端末に移すデータがなければ_聞いた印を付けない() {
    let (mut app, inbox, dir) = import_app("no-local-data", "http://127.0.0.1:9", false);

    app.check_import(false);
    next_login_event(&mut app, &inbox);

    assert!(app.login.is_none());
    assert!(app.prefs.import_offered.is_empty());
    assert!(app.config.load_prefs().import_offered.is_empty());
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn 確かめに失敗したら_もう一度は確かめ直して数を聞き_まだ移さない() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let server = format!("http://{}", listener.local_addr().unwrap());
    let requests = serve_imports(
        listener,
        vec![
            (401, r#"{"error":"unauthorized"}"#.into()),
            (200, IMPORT_COUNTS.into()),
        ],
    );
    let (mut app, inbox, dir) = import_app("preview-retry", &server, true);

    app.check_import(true);
    next_login_event(&mut app, &inbox);
    assert!(matches!(import_step(&app), LoginStep::ImportCheckFailed(_)));
    press_enter(&mut app);
    next_login_event(&mut app, &inbox);

    let LoginStep::ImportOffer { counts, .. } = import_step(&app) else {
        panic!("移すかを聞いていません");
    };
    assert_eq!(counts.new_rows(), 1);
    let requests = requests.join().unwrap();
    assert!(
        requests
            .iter()
            .all(|(head, _)| head.starts_with("POST /api/import?dryRun=1 "))
    );
    assert!(app.config.load_prefs().import_offered.is_empty());
    fs::remove_dir_all(dir).unwrap();
}
