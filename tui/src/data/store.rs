//! データ層のまとめ役。画面はこのストアのメモリ上のデータだけを読み書きする。
//! - 起動：手元の控え（SQLite）を読んで描ける状態にしてから、差分を取る
//! - 操作：actions.rs の関数から。すぐ表示に重ね、送信の列で1つずつ順に送る
//! - 通信は別のスレッド（net.rs）が行い、結果は on_mutate_done・on_sync_done で受け取る
//! - 知らせ：take_notices() で受け取る（保存の失敗、オフラインで止めた、401、nagi の更新が要る）
//! - 版のずれ（409）では、送っていないまとまりを捨てずに持ち、手元の控えの pending の表に持ち主を添えて書く。
//!   次に同じ持ち主で開いたときに列に戻し、最初の同期のあとに送る

use std::cell::RefCell;
use std::rc::Rc;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::{TZ_VARIANTS, Tz};
use uuid::{NoContext, Timestamp, Uuid};

use super::lists::Lists;
use super::local_db::{LocalDb, PendingOwner};
use super::replica::{OperationKind, PendingBatch, Replica};
use super::undo::{UndoEntry, UndoStack};
use crate::dates::{iso, logical_date};
use crate::i18n::{Msg, fill, t};
use crate::log;
use crate::model::{
    API_VERSION, Bucket, ChecklistItem, MAX_CHECKLIST_ITEM_LENGTH, MAX_CHECKLIST_ITEMS,
    MAX_MEMO_LENGTH, MAX_MUTATIONS_PER_BATCH, MAX_PROJECT_NAME_LENGTH, MAX_PROJECTS_PER_USER,
    MAX_TASKS_PER_USER, MAX_TITLE_LENGTH, Mutation, MutationBatch, SyncRow, TaskChanges,
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
    /// 409 の api_version_unsupported。この nagi が古い。min_api_version は Worker が受ける最も古い版
    UpgradeRequired { min_api_version: u32 },
    /// 409 の api_version_too_new。この nagi のほうが新しく、Worker の deploy がまだ
    ServerBehind,
    /// 400 など、再送しても通らない
    /// mutation_index は Worker が示した、断られた操作の位置（0 始まり）
    Rejected {
        status: u16,
        reason: Option<String>,
        mutation_index: Option<usize>,
    },
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
    /// Worker が日付の切り替えに使ったタイムゾーン（IANA の名前。この端末のデータと、古い Worker では None）
    pub time_zone: Option<String>,
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
    /// この nagi が古い。送っていないまとまりは持ったまま、更新を待つ
    VersionMismatch,
    /// 控えの送っていないまとまりに、この nagi で読めないものがある。順を崩さないよう、その前のまとまりも
    /// 送らずに持ったまま、読める nagi への更新を待つ
    UnreadablePending,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// オフラインなので止めた
    Offline,
    /// ログインが切れたので、もう送れない
    Stopped,
    /// 変えるものがなかった
    Noop,
    /// 空のタイトルなど、受け付けられない内容
    Invalid,
    /// 未完了のタスクが残っているプロジェクトはアーカイブできない
    HasOpenTasks,
    /// 1回の操作の対象が 500（Worker の上限）を超えた
    TooMany,
    /// 文字数か項目数が Worker の上限を超えている（送らずに断る）
    TooLong(Limit),
    /// 元に戻す操作が、ほかの画面の変更とぶつかった
    Conflict,
    NothingToUndo,
}

/// Worker が受け付ける文字数と項目数の上限（src/shared/mutations.ts）のうち、超えたもの
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    Title,
    Memo,
    ChecklistItems,
    ChecklistItem,
    ProjectName,
}

impl Limit {
    pub fn message(self) -> String {
        match self {
            Limit::Title => fill(Msg::LimitTitle, &[&MAX_TITLE_LENGTH]),
            Limit::Memo => fill(Msg::LimitMemo, &[&MAX_MEMO_LENGTH]),
            Limit::ChecklistItems => fill(Msg::LimitChecklistItems, &[&MAX_CHECKLIST_ITEMS]),
            Limit::ChecklistItem => fill(Msg::LimitChecklistItem, &[&MAX_CHECKLIST_ITEM_LENGTH]),
            Limit::ProjectName => fill(Msg::LimitProjectName, &[&MAX_PROJECT_NAME_LENGTH]),
        }
    }
}

/// Worker が 400 の `quota_exceeded` で断った、利用者ごとの行数の上限
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quota {
    Tasks,
    Projects,
}

impl Quota {
    pub fn message(self) -> String {
        match self {
            Quota::Tasks => fill(Msg::QuotaTasks, &[&MAX_TASKS_PER_USER]),
            Quota::Projects => fill(Msg::QuotaProjects, &[&MAX_PROJECTS_PER_USER]),
        }
    }
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
    /// 利用者ごとの行数の上限を超える追加だった
    Quota(Quota),
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
    /// この nagi が古い（409）。同期と送信は止まる。送っていない変更の数と、控えに書けたかは
    /// 止まったあとも変わるので、ここには載せない（unsent_kept と pending_count で読む）
    UpgradeRequired,
}

/// 記録に残す操作の一覧（種類と行の ID だけ。利用者の文字は残さない）
fn summarize<'a>(mutations: impl Iterator<Item = &'a Mutation>) -> String {
    mutations
        .map(Mutation::summary)
        .collect::<Vec<_>>()
        .join(", ")
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
    /// 送れないまとまりの持ち主（いまのログイン）
    pub owner: PendingOwner,
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
    /// この nagi のほうが Worker より新しい（409 の api_version_too_new）。止めずに、送っていないまとまりを
    /// 持ったまま、差分の取得が通るのを待つ（そのあいだ is_online は false）
    pub waiting_for_server: bool,
    /// 今日の論理日付（YYYY-MM-DD）。午前4時に変わる
    pub today: String,
    pub tz: Tz,
    pub(super) clock: Box<dyn Fn() -> DateTime<Utc>>,
    transport: Box<dyn Transport>,
    local: Option<LocalDb>,
    owner: PendingOwner,
    /// 手元（メモリ）に反映済みのカーソル
    cursor: u64,
    /// 送っている途中のまとまりの id
    sending: Option<String>,
    /// pending の表に、列のまとまりを書いてある（確定や破棄のときに、表からも消す）
    kept_in_table: bool,
    /// 持っておくべき列を pending の表に書けていない（書けない・控えがない）。閉じると消えるので知らせ続け、
    /// 差分を取るきっかけごとに書き直す
    keep_failed: bool,
    syncing: bool,
    sync_again: bool,
    /// hold_sync で、差分の取得を待たせている
    sync_held: bool,
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
            owner,
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
            waiting_for_server: false,
            today: logical_date(now, tz),
            tz,
            clock,
            transport,
            local,
            owner,
            cursor: 0,
            sending: None,
            kept_in_table: false,
            keep_failed: false,
            syncing: false,
            sync_again: false,
            sync_held: false,
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
                        log::error(&fill(Msg::LogLocalCopyCleanFailed, &[&error]));
                    }
                }
                // 読めなければ、手元が空のときと同じくカーソル 0 から取る
                Err(error) => log::error(&fill(Msg::LogLocalCopyReadFailed, &[&error])),
            }
            // 前に送れなかった、同じ持ち主のまとまりを列に戻す。送るのは最初の差分の取得が通ったあと。
            // 読めないまとまりがあれば（読めなければ）、それより前のまとまりも送らずに止める
            match local.load_pending(&store.owner) {
                Ok(load) => {
                    store.kept_in_table = !load.batches.is_empty();
                    for batch in load.batches {
                        store.replica.add_pending(batch);
                    }
                    if load.unreadable {
                        log::error(t(Msg::LogUnreadablePending));
                        store.stopped_by = Some(StopReason::UnreadablePending);
                    }
                }
                Err(error) => {
                    log::error(&fill(Msg::LogPendingReadFailed, &[&error]));
                    store.stopped_by = Some(StopReason::UnreadablePending);
                }
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

    /// 送らずに持っている列を、手元の控えに書けているか（書けていなければ、閉じると消える）
    pub fn unsent_kept(&self) -> bool {
        !self.keep_failed
    }

    #[cfg(test)]
    pub(super) fn local_db(&self) -> Option<&LocalDb> {
        self.local.as_ref()
    }

    /// nagi の更新を待って止まっているか（Worker が古い nagi を断った・控えに読めない変更がある）
    pub fn needs_upgrade(&self) -> bool {
        matches!(
            self.stopped_by,
            Some(StopReason::VersionMismatch | StopReason::UnreadablePending)
        )
    }

    /// 差分を取っている途中か
    pub fn is_syncing(&self) -> bool {
        self.syncing
    }

    /// たまった知らせを受け取る
    pub fn take_notices(&mut self) -> Vec<Notice> {
        std::mem::take(&mut self.notices)
    }

    fn is_active(&self) -> bool {
        self.stopped_by.is_none()
    }

    /// 版のずれで、送らずに持っているあいだか（新しい操作も受け付けて、pending の表に書く）
    fn is_holding(&self) -> bool {
        self.needs_upgrade() || self.waiting_for_server
    }

    // --- 差分の取得 ---------------------------------------------------------------------

    /// 送らずに持っている列を控えに書けていなければ、書き直す（書けるまで、きっかけごとに試す）
    pub fn retry_keep(&mut self) {
        if self.keep_failed {
            self.keep_pending();
        }
    }

    /// 差分を取る（取得中か、hold_sync で待たせているなら、あとでもう1回）。
    /// オフラインのあいだも、つながったかを確かめるために取りに行く。
    /// 止まっていても、送らずに持っている列を控えに書けていなければ、このきっかけで書き直す
    pub fn sync(&mut self) {
        self.retry_keep();
        if !self.is_active() {
            return;
        }
        if self.syncing || self.sync_held {
            self.sync_again = true;
            return;
        }
        self.syncing = true;
        self.confirmed_during_flow = Some(Vec::new());
        self.transport.sync(self.cursor);
    }

    /// release_sync まで、どのきっかけ（日付の切り替え・保存のぶつかりなど）の差分の取得も待たせる。
    /// 画面が、端末のタイムゾーンを Worker に書き終えるまで使う（先に取ると、Worker が前のゾーンで日付を切り替える）
    pub fn hold_sync(&mut self) {
        self.sync_held = true;
    }

    /// 待たせていた差分の取得があれば、始める
    pub fn release_sync(&mut self) {
        self.sync_held = false;
        if !self.syncing && std::mem::take(&mut self.sync_again) {
            self.sync();
        }
    }

    /// 差分の取得の流れが終わった。全部そろってから、まとめて確定データに反映し、最後に手元の控えに保存する。
    /// カーソル 0 から取った流れ（初回・reset）は、手元を全件で置き換える（Worker で物理削除された行が残らないように）。
    /// 取り直しのあいだに操作の応答で確定した行は、置き換えのあとに seq で比べて重ね直す
    pub fn on_sync_done(&mut self, result: Result<SyncFlow, ApiFailure>) {
        self.syncing = false;
        let confirmed_during_flow = self.confirmed_during_flow.take().unwrap_or_default();
        // 401 は、nagi の更新を待って止まっていても受ける（ログインし直す相手が同じ利用者とは限らないので、持っている
        // まとまりも捨てる）
        if matches!(result, Err(ApiFailure::Unauthorized))
            && self.stopped_by != Some(StopReason::Unauthorized)
        {
            return self.on_sync_failed(ApiFailure::Unauthorized);
        }
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
                if let Some(name) = flow.time_zone.as_deref() {
                    self.set_time_zone(name);
                }
                self.waiting_for_server = false;
                // 送れるようになったので、閉じる前に控えへ書く必要はもうない
                self.keep_failed = false;
                // 持っていたまとまり（前に送れなかった分、Worker の更新を待っていた分）を送る
                self.kick();
            }
        }
        if self.sync_again && self.is_active() {
            self.sync_again = false;
            self.sync();
        }
    }

    fn on_sync_failed(&mut self, error: ApiFailure) {
        match error {
            ApiFailure::Unauthorized => {
                let discarded = self.discard_pending();
                self.undo.clear();
                self.stop_unauthorized(failed_creates(&discarded));
            }
            ApiFailure::UpgradeRequired { min_api_version } => {
                self.require_upgrade(min_api_version)
            }
            ApiFailure::ServerBehind => self.wait_for_server(),
            ApiFailure::Rejected { .. } => {
                log::error(&fill(Msg::LogSyncFailed, &[&format_args!("{error:?}")]));
            }
            // 次のきっかけで取り直す
            ApiFailure::Network => self.is_online = false,
            ApiFailure::Server(_) => {}
        }
    }

    /// ログインが切れた。nagi の更新を待って止まっていたときも、こちらに置き換える（ログインの画面を出す）
    fn stop_unauthorized(&mut self, failed_creates: Vec<FailedCreate>) {
        self.stopped_by = Some(StopReason::Unauthorized);
        self.notices.push(Notice::Unauthorized { failed_creates });
    }

    /// この nagi が古い。送信と同期を止め、送っていないまとまりは表示に残したまま pending の表に書く
    /// （更新した nagi が、次に開いたときに送る）
    fn require_upgrade(&mut self, min_api_version: u32) {
        log::error(&fill(
            Msg::LogApiVersionRequired,
            &[&min_api_version, &API_VERSION],
        ));
        self.keep_pending();
        if self.stopped_by.is_none() {
            self.stopped_by = Some(StopReason::VersionMismatch);
            self.notices.push(Notice::UpgradeRequired);
        }
    }

    /// この nagi のほうが新しい。止めずに、送っていないまとまりを持ったまま、オフラインと同じ間隔で
    /// 差分を取りに行く。通ったら（Worker が更新されたら）送り直す
    fn wait_for_server(&mut self) {
        self.is_online = false;
        self.waiting_for_server = true;
        self.keep_pending();
    }

    /// 送っていないまとまりを、手元の控えの pending の表に書く。書けなければ keep_failed を立てる
    fn keep_pending(&mut self) {
        self.keep_from(0);
    }

    /// 列の from 番目から後ろを pending の表に書く（前の分を書けていなければ、先頭から書き直す）
    fn keep_from(&mut self, from: usize) {
        let from = if self.keep_failed { 0 } else { from };
        let batches = &self.replica.pending()[from..];
        if batches.is_empty() {
            self.keep_failed = false;
            return;
        }
        let kept = self.persist(|local| local.save_pending(&self.owner, batches));
        self.keep_failed = !kept;
        self.kept_in_table |= kept;
    }

    /// 送っていないまとまりをすべて捨てる（表示はその操作の前に戻る）。pending の表からも消す
    fn discard_pending(&mut self) -> Vec<PendingBatch> {
        let discarded = self.replica.discard_pending();
        self.keep_failed = false;
        let ids: Vec<&str> = discarded.iter().map(|batch| batch.id.as_str()).collect();
        self.unkeep(&ids);
        discarded
    }

    /// 確定した・外したまとまりを pending の表から消す。列が空になったら、表に書いたものはもうない
    fn unkeep(&mut self, ids: &[&str]) {
        if self.kept_in_table {
            self.persist(|local| local.remove_pending(ids));
        }
        if self.replica.pending().is_empty() {
            self.kept_in_table = false;
        }
    }

    // --- 操作 ---------------------------------------------------------------------------

    /// 操作のまとまりを受け付ける。オフラインなら止めて知らせる（Worker の更新を待っているあいだと、
    /// nagi の更新が要るあいだは受け付けて、送らずに pending の表に書く）。
    /// 1回のユーザー操作は1つのまとまり（1リクエスト）で、Worker は全部成功か全部失敗にする。
    /// そのため、500（Worker の上限）を超える操作は分けずに断る。
    /// 受け付けたら、元に戻すための逆向きの操作を今の表示から作り、表示に重ねて、送信の列に積む
    pub(super) fn perform(
        &mut self,
        kind: OperationKind,
        mutations: Vec<Mutation>,
        options: PerformOptions,
    ) -> OpResult {
        if self.stopped_by == Some(StopReason::Unauthorized) {
            return Err(Failure::Stopped);
        }
        if !self.is_online && !self.is_holding() {
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
        if let Some(limit) = mutations.iter().find_map(exceeded_limit) {
            return Err(Failure::TooLong(limit));
        }
        if !mutations.iter().all(is_well_formed) {
            log::error(&fill(
                Msg::LogMalformedMutations,
                &[&summarize(mutations.iter())],
            ));
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
        if self.is_holding() {
            self.keep_from(self.pending_count() - 1);
        }
        self.kick();
        Ok(Done {
            operation_id: id,
            ids,
        })
    }

    /// 列に積んだまとまりを送り始める（送っている途中、止まっている、Worker の更新を待っているなら何もしない）。
    /// 積んだ順に1つずつ送る（操作の順序が入れ替わらない）
    fn kick(&mut self) {
        if self.sending.is_some() || !self.is_active() || self.waiting_for_server {
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
    /// （操作どうしの依存を追わないため）。表示はその操作の前に戻る。版のずれ（409）なら捨てずに持っておく
    pub fn on_mutate_done(&mut self, batch_id: &str, result: Result<Vec<SyncRow>, ApiFailure>) {
        if self.sending.as_deref() == Some(batch_id) {
            self.sending = None;
        }
        // 送っているあいだに捨てられていたら（ほかの失敗など）、次へ
        let is_first = self
            .replica
            .pending()
            .first()
            .is_some_and(|batch| batch.id == batch_id);
        match result {
            // 止まったあとに届いた成功も取り込む（持っているまとまりから外し、更新したあとに送り直さない）
            Ok(rows) if is_first => {
                let (batch, _) = self.replica.confirm_batch(batch_id, &rows);
                self.persist(|local| local.put_rows(&rows, None));
                self.unkeep(&[batch_id]);
                if let Some(confirmed) = &mut self.confirmed_during_flow {
                    confirmed.extend(rows);
                }
                if let Some(batch) = batch {
                    self.undo.confirmed(&batch);
                }
            }
            // 401 は、nagi の更新を待って止まっていても受ける
            Err(ApiFailure::Unauthorized)
                if is_first && self.stopped_by != Some(StopReason::Unauthorized) =>
            {
                self.on_send_failed(ApiFailure::Unauthorized)
            }
            Err(error) if is_first && self.is_active() => self.on_send_failed(error),
            _ => {}
        }
        self.kick();
    }

    fn on_send_failed(&mut self, error: ApiFailure) {
        match error {
            ApiFailure::UpgradeRequired { min_api_version } => {
                return self.require_upgrade(min_api_version);
            }
            ApiFailure::ServerBehind => return self.wait_for_server(),
            _ => {}
        }
        let discarded = self.discard_pending();
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
            ApiFailure::Unauthorized => self.stop_unauthorized(failed_creates.clone()),
            // 上で持っておいた（捨てていない）
            ApiFailure::UpgradeRequired { .. } | ApiFailure::ServerBehind => {}
            ApiFailure::Rejected {
                reason,
                mutation_index,
                ..
            } => {
                let conflict = reason
                    .as_deref()
                    .is_some_and(|reason| CONFLICT_REASONS.contains(&reason));
                if reason.as_deref() == Some(QUOTA_REASON) {
                    save_failed(
                        self,
                        SaveFailure::Quota(exceeded_quota(&discarded, *mutation_index)),
                    );
                } else if conflict {
                    // ほかの画面が先に変えていた。最新を取りに行く（自動で合わせることはしない）
                    save_failed(self, SaveFailure::Conflict);
                    self.sync();
                } else {
                    // 検証エラーはほぼ不具合なので、記録を残す
                    log::error(&fill(
                        Msg::LogMutationRejected,
                        &[
                            &format_args!("{error:?}"),
                            &summarize(discarded.iter().flat_map(|batch| &batch.mutations)),
                        ],
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

    /// 手元の控えに書く。書けたら true（控えがない・書けなかったら false。記録はログに残す）
    fn persist(&self, write: impl FnOnce(&LocalDb) -> rusqlite::Result<()>) -> bool {
        let Some(local) = &self.local else {
            return false;
        };
        match write(local) {
            Ok(()) => true,
            Err(error) => {
                log::error(&fill(Msg::LogLocalSaveFailed, &[&error]));
                false
            }
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

    /// 日付を決めるタイムゾーンを変える（Worker が、利用者のゾーンとして返した名前）。
    /// 今日は refresh_day と同じ決まりで計算し直す。Worker は同じゾーンで切り替えてから行を返しているので、
    /// refresh_day と違って、差分は取り直さない。
    /// chrono_tz は綴りどおりにしか読まないが、Worker の Intl は大文字と小文字を区別せずに受け付けるので、
    /// 読めなければ区別せずに探し直す。それでも読めなければ、前のゾーンのまま（どちらも記録に残す）
    fn set_time_zone(&mut self, name: &str) {
        let tz = name.parse::<Tz>().ok().or_else(|| {
            log::error(&fill(Msg::LogTimeZoneUnreadable, &[&name]));
            TZ_VARIANTS
                .iter()
                .copied()
                .find(|tz| tz.name().eq_ignore_ascii_case(name))
        });
        let Some(tz) = tz else {
            log::error(&fill(Msg::LogTimeZoneUnusable, &[&name, &self.tz.name()]));
            return;
        };
        if tz == self.tz {
            return;
        }
        self.tz = tz;
        *self.lists.borrow_mut() = None;
        let next = logical_date(self.now(), tz);
        if next != self.today {
            self.today = next;
            self.purge_expired();
        }
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

const QUOTA_REASON: &str = "quota_exceeded";

/// Worker が断った操作（送った先頭のまとまりの mutation_index 番目）がタスクの追加ならタスクの上限、
/// そうでなければプロジェクトの上限。あとに続いて捨てたまとまりは送っていないので見ない
fn exceeded_quota(discarded: &[PendingBatch], mutation_index: Option<usize>) -> Quota {
    let rejected = discarded
        .first()
        .zip(mutation_index)
        .and_then(|(batch, index)| batch.mutations.get(index));
    if matches!(rejected, Some(Mutation::TaskCreate { .. })) {
        Quota::Tasks
    } else {
        Quota::Projects
    }
}

/// UTF-16 の単位での長さ（Worker の JavaScript の `length` と同じ数え方）
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn checklist_limit(checklist: &[ChecklistItem]) -> Option<Limit> {
    if checklist.len() > MAX_CHECKLIST_ITEMS {
        return Some(Limit::ChecklistItems);
    }
    checklist
        .iter()
        .any(|item| utf16_len(&item.title) > MAX_CHECKLIST_ITEM_LENGTH)
        .then_some(Limit::ChecklistItem)
}

/// 送る前の上限の確かめ（Worker の検証で必ず落ちる長さを、送らずに止める）
fn exceeded_limit(mutation: &Mutation) -> Option<Limit> {
    let title = |title: &str| (utf16_len(title) > MAX_TITLE_LENGTH).then_some(Limit::Title);
    let memo = |memo: &str| (utf16_len(memo) > MAX_MEMO_LENGTH).then_some(Limit::Memo);
    let name =
        |name: &str| (utf16_len(name) > MAX_PROJECT_NAME_LENGTH).then_some(Limit::ProjectName);
    match mutation {
        Mutation::TaskCreate { task } => title(&task.title).or_else(|| memo(&task.memo)),
        Mutation::TaskUpdate {
            changes,
            base_checklist,
            ..
        } => changes
            .title
            .as_deref()
            .and_then(title)
            .or_else(|| changes.memo.as_deref().and_then(memo))
            .or_else(|| changes.checklist.as_deref().and_then(checklist_limit))
            .or_else(|| base_checklist.as_deref().and_then(checklist_limit)),
        Mutation::ProjectCreate { project } => name(&project.name),
        Mutation::ProjectUpdate { changes, .. } => changes.name.as_deref().and_then(name),
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
