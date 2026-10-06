//! データ層のまとめ役。画面はこのストアのメモリ上のデータだけを読み書きする。
//! - 起動：手元の控え（SQLite）を読んで描ける状態にしてから、差分を取る
//! - 操作：actions.rs の関数から。すぐ表示に重ね、送信の列で1つずつ順に送る
//! - 通信は別のスレッド（net.rs）が行い、結果は on_mutate_done・on_sync_done で受け取る
//! - 知らせ：take_notices() で受け取る（保存の失敗、オフラインで止めた、401、409）

use std::cell::RefCell;
use std::rc::Rc;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use uuid::{NoContext, Timestamp, Uuid};

use super::lists::Lists;
use super::local_db::LocalDb;
use super::replica::{OperationKind, PendingBatch, Replica};
use super::undo::{UndoEntry, UndoStack};
use crate::dates::{iso, logical_date};
use crate::log;
use crate::model::{
    Bucket, MAX_MUTATIONS_PER_BATCH, Mutation, MutationBatch, SyncRow, TaskChanges,
};
use crate::rank::is_valid_rank;

/// 削除（論理削除）からこの日数たった行は、手元からも捨てる（Worker はその時点で物理削除する）
pub const DELETED_ROW_TTL_DAYS: i64 = 30;

/// 通信の失敗の種類。どう扱うか（再送・ログイン・更新）で分ける
#[derive(Clone, Debug, PartialEq)]
pub enum ApiFailure {
    /// 通信エラーかタイムアウト。同じ ID で再送してよい
    Network,
    /// 5xx。同じ ID で再送してよい
    Server(u16),
    /// 401。ログインし直す
    Unauthorized,
    /// 409。この TUI の版が古い
    VersionMismatch,
    /// 400 など、再送しても通らない
    Rejected { status: u16, reason: Option<String> },
}

impl ApiFailure {
    pub fn is_retryable(&self) -> bool {
        matches!(self, ApiFailure::Network | ApiFailure::Server(_))
    }
}

/// 1回の差分の取得の流れ（hasMore がなくなるまで）の結果
#[derive(Clone, Debug)]
pub struct SyncFlow {
    /// その流れの最初の、手元に反映済みのカーソル（reset が来たら 0）
    pub base_cursor: u64,
    pub rows: Vec<SyncRow>,
    pub cursor: u64,
}

/// 通信の出口。結果は Store の on_mutate_done・on_sync_done に届ける
pub trait Transport {
    /// まとまりを送る（通信エラーと 5xx の再送は、送る側で行う）
    fn mutate(&mut self, batch: MutationBatch);
    /// cursor から差分を取る（ページの続きと reset の取り直しは、取る側で行う）
    fn sync(&mut self, cursor: u64);
}

/// 送信と同期を止めた理由
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StopReason {
    Unauthorized,
    VersionMismatch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// オフラインなので止めた
    Offline,
    /// ログインが切れた・版が古いので、もう送れない
    Stopped,
    /// 変えるものがなかった
    Noop,
    /// 空のタイトルなど、受け付けられない内容
    Invalid,
    /// 未完了のタスクが残っているプロジェクトはアーカイブできない
    HasOpenTasks,
    /// 1回の操作の対象が 500（Worker の上限）を超えた
    TooMany,
    /// 元に戻す操作が、ほかの画面の変更とぶつかった
    Conflict,
    NothingToUndo,
}

/// 受け付けた操作。ids は操作の対象になった行（作った行を含む）の id。操作した順
#[derive(Clone, Debug, PartialEq)]
pub struct Done {
    pub operation_id: String,
    pub ids: Vec<String>,
}

pub type OpResult = Result<Done, Failure>;

#[derive(Clone, Copy, Debug, Default)]
pub struct PerformOptions {
    /// 元に戻すの対象にしない
    pub not_undoable: bool,
    /// 入力の自動保存か（オフラインで止めたときの知らせに載せる）
    pub autosave: bool,
}

/// 保存できずに捨てた追加。画面はこれで、文字を追加欄の下書きに戻せる
#[derive(Clone, Debug, PartialEq)]
pub struct FailedCreate {
    pub id: String,
    pub title: String,
    pub bucket: Bucket,
    pub project_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SaveFailure {
    /// 再送しても通信できなかった・5xx
    Network,
    /// 400 など（ほぼ不具合。記録はログに残す）
    Rejected,
    /// ほかの画面が先に変えていた。ストアは最新を取りに行く
    Conflict,
}

#[derive(Clone, Debug)]
pub enum Notice {
    /// オフラインなので、操作を受け付けずに止めた
    OfflineBlocked { autosave: bool },
    /// 保存できなかった。送信中の操作はすべて捨てて、表示は元に戻っている。
    /// undo_conflict：元に戻す操作がほかの画面の変更とぶつかって戻せなかった（送っていない）
    SaveFailed {
        reason: SaveFailure,
        discarded: Vec<PendingBatch>,
        failed_creates: Vec<FailedCreate>,
        undo_conflict: bool,
    },
    /// ログインが切れた（401）。同期と送信は止まる
    Unauthorized { failed_creates: Vec<FailedCreate> },
    /// この TUI の版が古い（409）。同期と送信は止まる
    VersionMismatch { failed_creates: Vec<FailedCreate> },
}

fn failed_creates(batches: &[PendingBatch]) -> Vec<FailedCreate> {
    batches
        .iter()
        .flat_map(|batch| &batch.mutations)
        .filter_map(|mutation| match mutation {
            Mutation::TaskCreate { task } => Some(FailedCreate {
                id: task.id.clone(),
                title: task.title.clone(),
                bucket: task.bucket,
                project_id: task.project_id.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// ほかの画面が先に変えていたので断られた理由（不具合ではない）
const CONFLICT_REASONS: [&str; 3] = [
    "checklist_conflict",
    "project_has_open_tasks",
    "project_archived",
];

pub struct StoreOptions {
    pub transport: Box<dyn Transport>,
    pub local: Option<LocalDb>,
    pub clock: Box<dyn Fn() -> DateTime<Utc>>,
    pub tz: Tz,
}

pub struct Store {
    pub replica: Replica,
    pub undo: UndoStack,
    /// 起動してから、差分の取得を1回終えた
    pub synced: bool,
    /// オンラインか（通信の失敗で false、差分の取得の成功で true）
    pub is_online: bool,
    /// 送信と同期を止めた理由（止まっていなければ None）
    pub stopped_by: Option<StopReason>,
    /// 今日の論理日付（YYYY-MM-DD）。午前4時に変わる
    pub today: String,
    pub tz: Tz,
    pub(super) clock: Box<dyn Fn() -> DateTime<Utc>>,
    transport: Box<dyn Transport>,
    local: Option<LocalDb>,
    /// 手元（メモリ）に反映済みのカーソル
    cursor: u64,
    /// 送っている途中のまとまりの id
    sending: Option<String>,
    syncing: bool,
    sync_again: bool,
    /// 取得の流れのあいだに、操作の応答で確定した行（流れが終わるまで覚えておく）
    confirmed_during_flow: Option<Vec<SyncRow>>,
    notices: Vec<Notice>,
    lists: RefCell<Option<(u64, String, Rc<Lists>)>>,
}

impl Store {
    /// 手元の控えを読んで、描ける状態のストアを作る。差分は sync() で取る
    pub fn new(options: StoreOptions) -> Store {
        let StoreOptions {
            transport,
            local,
            clock,
            tz,
        } = options;
        let now = clock();
        let mut store = Store {
            replica: Replica::default(),
            undo: UndoStack::default(),
            synced: false,
            is_online: true,
            stopped_by: None,
            today: logical_date(now, tz),
            tz,
            clock,
            transport,
            local,
            cursor: 0,
            sending: None,
            syncing: false,
            sync_again: false,
            confirmed_during_flow: None,
            notices: Vec::new(),
            lists: RefCell::new(None),
        };
        let cutoff = store.purge_cutoff();
        if let Some(local) = &store.local {
            match local.load() {
                Ok(snapshot) => {
                    let alive = |deleted_at: &Option<String>| {
                        deleted_at.as_deref().is_none_or(|at| at >= cutoff.as_str())
                    };
                    let rows = snapshot
                        .rows
                        .into_iter()
                        .filter(|row| match row {
                            SyncRow::Task(task) => alive(&task.deleted_at),
                            SyncRow::Project(project) => alive(&project.deleted_at),
                        })
                        .collect();
                    store.replica.replace_confirmed(rows);
                    store.cursor = snapshot.cursor;
                    if let Err(error) = local.purge_deleted(&cutoff) {
                        log::error(&format!("手元の控えを片付けられませんでした: {error}"));
                    }
                }
                // 読めなければ、手元が空のときと同じくカーソル 0 から取る
                Err(error) => log::error(&format!("手元の控えを読めませんでした: {error}")),
            }
        }
        store
    }

    // --- 読む ---------------------------------------------------------------------------

    pub fn now(&self) -> DateTime<Utc> {
        (self.clock)()
    }

    pub fn now_iso(&self) -> String {
        iso(self.now())
    }

    /// UUIDv7（小文字）。タスク・プロジェクト・操作のまとまりの ID を手元で採番する
    pub fn new_id(&self) -> String {
        let now = self.now();
        let timestamp = Timestamp::from_unix(
            NoContext,
            now.timestamp().max(0) as u64,
            now.timestamp_subsec_nanos(),
        );
        Uuid::new_v7(timestamp).hyphenated().to_string()
    }

    /// 各リストの中身と並び（写しか今日の日付が変わったときだけ計算し直す）
    pub fn lists(&self) -> Rc<Lists> {
        let mut cache = self.lists.borrow_mut();
        if let Some((version, today, lists)) = cache.as_ref()
            && *version == self.replica.version()
            && *today == self.today
        {
            return Rc::clone(lists);
        }
        let lists = Rc::new(Lists::compute(&self.replica, &self.today, self.tz));
        *cache = Some((
            self.replica.version(),
            self.today.clone(),
            Rc::clone(&lists),
        ));
        lists
    }

    pub fn can_undo(&self) -> bool {
        self.undo.can_undo()
    }

    /// 送信中のまとまりの数（保存が済んでいないものがあるか）
    pub fn pending_count(&self) -> usize {
        self.replica.pending().len()
    }

    /// たまった知らせを受け取る
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    fn is_active(&self) -> bool {
        self.stopped_by.is_none()
    }

    // --- 差分の取得 ---------------------------------------------------------------------

    /// 差分を取る（取得中なら、終わったあとにもう1回）。オフラインのあいだも、つながったかを確かめるために取りに行く
    pub fn sync(&mut self) {
        if !self.is_active() {
            return;
        }
        if self.syncing {
            self.sync_again = true;
            return;
        }
        self.syncing = true;
        self.confirmed_during_flow = Some(Vec::new());
        self.transport.sync(self.cursor);
    }

    /// 差分の取得の流れが終わった。全部そろってから、まとめて確定データに反映し、最後に手元の控えに保存する。
    /// カーソル 0 から取った流れ（初回・reset）は、手元を全件で置き換える（Worker で物理削除された行が残らないように）。
    /// 取り直しのあいだに操作の応答で確定した行は、置き換えのあとに seq で比べて重ね直す
    pub fn on_sync_done(&mut self, result: Result<SyncFlow, ApiFailure>) {
        self.syncing = false;
        let confirmed_during_flow = self.confirmed_during_flow.take().unwrap_or_default();
        if !self.is_active() {
            return;
        }
        match result {
            Err(error) => self.on_sync_failed(error),
            Ok(flow) => {
                if flow.base_cursor == 0 {
                    self.replica.replace_confirmed(flow.rows.clone());
                    self.replica.merge_confirmed(&confirmed_during_flow);
                    self.cursor = flow.cursor;
                    self.persist(|local| {
                        local.replace_all(&flow.rows, flow.cursor)?;
                        local.put_rows(&confirmed_during_flow, None)
                    });
                } else {
                    self.replica.merge_confirmed(&flow.rows);
                    self.cursor = flow.cursor;
                    self.persist(|local| {
                        local.put_rows(&flow.rows, Some((flow.base_cursor, flow.cursor)))
                    });
                }
                // 起動して最初の同期のあとにも、30 日たった削除済みの行を捨てる（初回の全件取得で届いた分）
                if !self.synced {
                    self.purge_expired();
                }
                self.synced = true;
                self.is_online = true;
            }
        }
        if self.sync_again && self.is_active() {
            self.sync_again = false;
            self.sync();
        }
    }

    fn on_sync_failed(&mut self, error: ApiFailure) {
        match error {
            ApiFailure::Unauthorized | ApiFailure::VersionMismatch => {
                let discarded = self.replica.discard_pending();
                self.undo.clear();
                self.stop(&error, failed_creates(&discarded));
            }
            ApiFailure::Rejected { .. } => {
                log::error(&format!("差分を取得できませんでした: {error:?}"));
            }
            // 次のきっかけで取り直す
            ApiFailure::Network => self.is_online = false,
            ApiFailure::Server(_) => {}
        }
    }

    fn stop(&mut self, error: &ApiFailure, failed_creates: Vec<FailedCreate>) {
        let (reason, notice) = match error {
            ApiFailure::Unauthorized => (
                StopReason::Unauthorized,
                Notice::Unauthorized { failed_creates },
            ),
            _ => (
                StopReason::VersionMismatch,
                Notice::VersionMismatch { failed_creates },
            ),
        };
        self.stopped_by.get_or_insert(reason);
        self.notices.push(notice);
    }

    // --- 操作 ---------------------------------------------------------------------------

    /// 操作のまとまりを受け付ける。オフラインなら止めて知らせる。
    /// 1回のユーザー操作は1つのまとまり（1リクエスト）で、Worker は全部成功か全部失敗にする。
    /// そのため、500（Worker の上限）を超える操作は分けずに断る。
    /// 受け付けたら、元に戻すための逆向きの操作を今の表示から作り、表示に重ねて、送信の列に積む
    pub(super) fn perform(
        &mut self,
        kind: OperationKind,
        mutations: Vec<Mutation>,
        options: PerformOptions,
    ) -> OpResult {
        if !self.is_active() {
            return Err(Failure::Stopped);
        }
        if !self.is_online {
            self.notices.push(Notice::OfflineBlocked {
                autosave: options.autosave,
            });
            return Err(Failure::Offline);
        }
        if mutations.is_empty() {
            return Err(Failure::Noop);
        }
        if mutations.len() > MAX_MUTATIONS_PER_BATCH {
            return Err(Failure::TooMany);
        }
        if !mutations.iter().all(is_well_formed) {
            log::error(&format!("操作の形が正しくありません: {mutations:?}"));
            return Err(Failure::Invalid);
        }

        let id = self.new_id();
        if !options.not_undoable {
            let entry = UndoEntry::build(
                &id,
                &mutations,
                |task_id| self.replica.task(task_id).cloned(),
                |project_id| self.replica.project(project_id).cloned(),
            );
            self.undo.push(entry);
        }
        let mut ids: Vec<String> = Vec::new();
        for mutation in &mutations {
            let (_, target) = mutation.target();
            if !ids.iter().any(|id| id == target) {
                ids.push(target.to_string());
            }
        }
        self.replica.add_pending(PendingBatch {
            id: id.clone(),
            mutations,
            at: self.now_iso(),
            kind,
        });
        self.kick();
        Ok(Done {
            operation_id: id,
            ids,
        })
    }

    /// 列に積んだまとまりを送り始める（送っている途中なら何もしない）。
    /// 積んだ順に1つずつ送る（操作の順序が入れ替わらない）
    fn kick(&mut self) {
        if self.sending.is_some() || !self.is_active() {
            return;
        }
        let Some(batch) = self.replica.pending().first() else {
            return;
        };
        self.sending = Some(batch.id.clone());
        self.transport.mutate(MutationBatch {
            id: batch.id.clone(),
            mutations: batch.mutations.clone(),
        });
    }

    /// まとまりの送信が終わった。失敗したら、そのまとまりと後ろに並ぶまとまりをすべて捨てる
    /// （操作どうしの依存を追わないため）。表示はその操作の前に戻る
    pub fn on_mutate_done(&mut self, batch_id: &str, result: Result<Vec<SyncRow>, ApiFailure>) {
        if self.sending.as_deref() == Some(batch_id) {
            self.sending = None;
        }
        if !self.is_active() {
            return;
        }
        // 送っているあいだに捨てられていたら（ほかの失敗など）、次へ
        if self
            .replica
            .pending()
            .first()
            .is_some_and(|batch| batch.id == batch_id)
        {
            match result {
                Ok(rows) => {
                    let (batch, _) = self.replica.confirm_batch(batch_id, &rows);
                    self.persist(|local| local.put_rows(&rows, None));
                    if let Some(confirmed) = &mut self.confirmed_during_flow {
                        confirmed.extend(rows);
                    }
                    if let Some(batch) = batch {
                        self.undo.confirmed(&batch);
                    }
                }
                Err(error) => {
                    let discarded = self.replica.discard_pending();
                    self.on_send_failed(error, discarded);
                }
            }
        }
        self.kick();
    }

    fn on_send_failed(&mut self, error: ApiFailure, discarded: Vec<PendingBatch>) {
        self.undo.discarded(&discarded, error.is_retryable());
        let failed_creates = failed_creates(&discarded);
        // 捨てたのが「元に戻す」の操作だけなら、戻せなかったことを知らせる（Worker に断られたとき）
        let only_undo = discarded
            .iter()
            .all(|batch| batch.kind == OperationKind::Undo);
        let save_failed = |store: &mut Store, reason| {
            store.notices.push(Notice::SaveFailed {
                reason,
                discarded: discarded.clone(),
                failed_creates: failed_creates.clone(),
                undo_conflict: reason == SaveFailure::Conflict && only_undo,
            });
        };
        match &error {
            ApiFailure::Unauthorized | ApiFailure::VersionMismatch => {
                self.stop(&error, failed_creates.clone());
            }
            ApiFailure::Rejected { reason, .. } => {
                let conflict = reason
                    .as_deref()
                    .is_some_and(|reason| CONFLICT_REASONS.contains(&reason));
                if conflict {
                    // ほかの画面が先に変えていた。最新を取りに行く（自動で合わせることはしない）
                    save_failed(self, SaveFailure::Conflict);
                    self.sync();
                } else {
                    // 検証エラーはほぼ不具合なので、記録を残す
                    log::error(&format!(
                        "保存を受け付けられませんでした: {error:?} {discarded:?}"
                    ));
                    save_failed(self, SaveFailure::Rejected);
                }
            }
            ApiFailure::Network => {
                save_failed(self, SaveFailure::Network);
                // つながっていない。差分の取得が通るまで、操作は受け付けずに止める
                self.is_online = false;
            }
            ApiFailure::Server(_) => save_failed(self, SaveFailure::Network),
        }
    }

    /// 元に戻す操作が、ほかの画面の変更とぶつかって戻せなかった（送っていない。表示もそのまま）。
    /// 保存のぶつかりと同じ知らせにして、最新を取りに行く
    pub(super) fn on_undo_conflict(&mut self) {
        self.notices.push(Notice::SaveFailed {
            reason: SaveFailure::Conflict,
            discarded: Vec::new(),
            failed_creates: Vec::new(),
            undo_conflict: true,
        });
        self.sync();
    }

    fn persist(&self, write: impl FnOnce(&LocalDb) -> rusqlite::Result<()>) {
        if let Some(local) = &self.local
            && let Err(error) = write(local)
        {
            log::error(&format!("手元の控えに保存できませんでした: {error}"));
        }
    }

    // --- 日付の切り替えと、削除済みの行の後始末 -----------------------------------------

    /// 今の時刻で論理日付を確かめ直す。変わっていたら更新し、差分を取り直して true を返す
    pub fn refresh_day(&mut self) -> bool {
        let next = logical_date(self.now(), self.tz);
        if next == self.today {
            return false;
        }
        self.today = next;
        self.purge_expired();
        self.sync();
        true
    }

    fn purge_cutoff(&self) -> String {
        iso(self.now() - Duration::days(DELETED_ROW_TTL_DAYS))
    }

    /// 削除から 30 日たった行を、メモリと手元の控えから捨てる
    fn purge_expired(&mut self) {
        let cutoff = self.purge_cutoff();
        let (task_ids, project_ids) = self.replica.expired_deleted(&cutoff);
        if !task_ids.is_empty() || !project_ids.is_empty() {
            self.replica.drop_confirmed(&task_ids, &project_ids);
        }
        self.persist(|local| local.purge_deleted(&cutoff));
    }
}

/// 送る前の確かめ（Worker の検証で必ず落ちる形を、送らずに止める）
fn is_well_formed(mutation: &Mutation) -> bool {
    let rank_ok = |changes: &TaskChanges| changes.rank.as_deref().is_none_or(is_valid_rank);
    let title_ok = |title: &str| !title.trim().is_empty();
    match mutation {
        Mutation::TaskCreate { task } => title_ok(&task.title) && is_valid_rank(&task.rank),
        Mutation::TaskUpdate { changes, .. } => {
            !changes.is_empty() && rank_ok(changes) && changes.title.as_deref().is_none_or(title_ok)
        }
        Mutation::ProjectCreate { project } => title_ok(&project.name),
        Mutation::ProjectUpdate { changes, .. } => {
            !changes.is_empty() && changes.name.as_deref().is_none_or(title_ok)
        }
    }
}
