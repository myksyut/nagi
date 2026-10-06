//! この端末だけで使うとき（ローカル。ログインなし・Worker なし）のデータの置き場と、その「Worker 役」。
//! Worker（src/worker/sync の mutate.ts・changes.ts・rollover.ts）と同じ決まりで、操作のまとまりを反映し、
//! 差分を返し、日付の切り替えを行う。画面のストアから見ると、通信の代わりにこれが応える（DeviceTransport）。
//!
//! データは SQLite の 1 つのファイル。同時に開いたほかの nagi（画面と CLI）とは、1 回の処理を 1 つの
//! 書き込みのトランザクション（BEGIN IMMEDIATE）にして順番を守る。メモリには何も覚えず、毎回ファイルから読む。
//! 操作の中身の形（ID・日付の書式など）は、操作を作る側（actions.rs）が守る。ここでは、行の今の状態に
//! 照らした検証（Worker の planWrites と同じもの）と、空のタイトル・並び順キーの形だけを確かめる

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::mpsc::{Sender, channel};
use std::thread;
use std::time::Duration as StdDuration;

use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use rusqlite::{Connection, OptionalExtension, Params, Transaction, TransactionBehavior, params};

use super::net::NetEvent;
use super::store::{ApiFailure, DELETED_ROW_TTL_DAYS, SyncFlow, Transport};
use crate::dates::{iso, logical_date};
use crate::log;
use crate::model::{
    Bucket, MAX_MUTATIONS_PER_BATCH, Mutation, MutationBatch, Project, RowKind, SyncRow, Task,
};
use crate::rank::{arrival_ranks, is_valid_rank};

/// 保存形式の版。形を変えるときは、前の版から移す処理を書く（手元の控えと違って、捨てて作り直せない）
const FORMAT_VERSION: i64 = 1;
/// 反映済みのまとまりを覚えておく日数（Worker の APPLIED_MUTATIONS_TTL_DAYS と同じ）
const APPLIED_TTL_DAYS: i64 = 7;

pub struct DeviceDb {
    conn: Connection,
}

/// 処理を止めた理由
enum Stop {
    /// 受け付けられない操作（Worker の 400 と同じ理由の名前）
    Rejected(&'static str),
    /// ファイルの読み書きの失敗
    Broken(String),
}

impl From<rusqlite::Error> for Stop {
    fn from(error: rusqlite::Error) -> Stop {
        Stop::Broken(error.to_string())
    }
}

impl From<serde_json::Error> for Stop {
    fn from(error: serde_json::Error) -> Stop {
        Stop::Broken(error.to_string())
    }
}

impl From<Stop> for ApiFailure {
    fn from(stop: Stop) -> ApiFailure {
        match stop {
            Stop::Rejected(reason) => ApiFailure::Rejected {
                status: 400,
                reason: Some(reason.to_string()),
            },
            Stop::Broken(message) => {
                log::error(&format!(
                    "この端末のデータを読み書きできませんでした: {message}"
                ));
                ApiFailure::Server(500)
            }
        }
    }
}

type Step<T> = Result<T, Stop>;

/// 行を指すもの（タスクかプロジェクトかと、その ID）
type RowKey = (RowKind, String);

/// 書き込む行（最初に触れた順）と、このまとまりで作る行
struct Plan {
    order: Vec<RowKey>,
    created: HashSet<RowKey>,
}

/// 検証に使う、行の今の状態（まとまりの中の操作を重ねていく）
#[derive(Default)]
struct Facts {
    tasks: HashMap<String, Task>,
    projects: HashMap<String, Project>,
}

fn to_seq(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn read_seq(tx: &Transaction) -> rusqlite::Result<u64> {
    let value: i64 = tx.query_row("SELECT value FROM meta WHERE key = 'seq'", [], |row| {
        row.get(0)
    })?;
    Ok(to_seq(value))
}

fn write_seq(tx: &Transaction, seq: u64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'seq'",
        params![seq as i64],
    )?;
    Ok(())
}

fn read_task(tx: &Transaction, id: &str) -> Step<Option<Task>> {
    let json: Option<String> = tx
        .query_row("SELECT json FROM tasks WHERE id = ?1", params![id], |row| {
            row.get(0)
        })
        .optional()?;
    Ok(json.map(|json| serde_json::from_str(&json)).transpose()?)
}

fn read_project(tx: &Transaction, id: &str) -> Step<Option<Project>> {
    let json: Option<String> = tx
        .query_row(
            "SELECT json FROM projects WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()?;
    Ok(json.map(|json| serde_json::from_str(&json)).transpose()?)
}

fn read_tasks(tx: &Transaction, condition: &str, params: impl Params) -> Step<Vec<Task>> {
    let mut statement = tx.prepare(&format!("SELECT json FROM tasks WHERE {condition}"))?;
    let rows = statement.query_map(params, |row| row.get::<_, String>(0))?;
    let mut tasks = Vec::new();
    for json in rows {
        tasks.push(serde_json::from_str(&json?)?);
    }
    Ok(tasks)
}

fn is_open(task: &Task) -> bool {
    task.completed_at.is_none() && task.deleted_at.is_none()
}

fn put_task(tx: &Transaction, task: &Task) -> Step<()> {
    tx.execute(
        "INSERT INTO tasks (id, seq, project_id, open, deleted_at, json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, project_id = excluded.project_id,
           open = excluded.open, deleted_at = excluded.deleted_at, json = excluded.json",
        params![
            task.id,
            task.seq as i64,
            task.project_id,
            is_open(task),
            task.deleted_at,
            serde_json::to_string(task)?,
        ],
    )?;
    Ok(())
}

fn put_project(tx: &Transaction, project: &Project) -> Step<()> {
    tx.execute(
        "INSERT INTO projects (id, seq, deleted_at, json) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at,
           json = excluded.json",
        params![
            project.id,
            project.seq as i64,
            project.deleted_at,
            serde_json::to_string(project)?,
        ],
    )?;
    Ok(())
}

fn seq_of(row: &SyncRow) -> u64 {
    match row {
        SyncRow::Task(task) => task.seq,
        SyncRow::Project(project) => project.seq,
    }
}

/// seq が cursor より新しい行を、seq の順に読む
fn rows_after(tx: &Transaction, cursor: u64) -> Step<Vec<SyncRow>> {
    let mut rows = Vec::new();
    {
        let mut statement = tx.prepare("SELECT json FROM tasks WHERE seq > ?1")?;
        for json in statement.query_map(params![cursor as i64], |row| row.get::<_, String>(0))? {
            rows.push(SyncRow::Task(serde_json::from_str(&json?)?));
        }
    }
    {
        let mut statement = tx.prepare("SELECT json FROM projects WHERE seq > ?1")?;
        for json in statement.query_map(params![cursor as i64], |row| row.get::<_, String>(0))? {
            rows.push(SyncRow::Project(serde_json::from_str(&json?)?));
        }
    }
    rows.sort_by_key(seq_of);
    Ok(rows)
}

/// アーカイブ済み・削除済みでない、あるプロジェクトだけを付けられる
fn assert_attachable(facts: &Facts, project_id: &str) -> Step<()> {
    let Some(project) = facts.projects.get(project_id) else {
        return Err(Stop::Rejected("project_not_found"));
    };
    if project.deleted_at.is_some() {
        return Err(Stop::Rejected("project_deleted"));
    }
    if project.archived_at.is_some() {
        return Err(Stop::Rejected("project_archived"));
    }
    Ok(())
}

fn is_blank(text: &str) -> bool {
    text.trim().is_empty()
}

/// 検証に要る今の行を読む（Worker の loadFacts と同じ）：操作の対象のタスクとプロジェクト、タスクに付けるプロジェクト、
/// アーカイブするプロジェクトの、未完了・未削除のタスク
fn load_facts(tx: &Transaction, batch: &MutationBatch) -> Step<Facts> {
    let mut facts = Facts::default();
    let mut project_ids: Vec<&str> = Vec::new();
    for mutation in &batch.mutations {
        match mutation {
            Mutation::TaskCreate { task } => {
                if let Some(task) = read_task(tx, &task.id)? {
                    facts.tasks.insert(task.id.clone(), task);
                }
                project_ids.extend(task.project_id.as_deref());
            }
            Mutation::TaskUpdate { id, changes, .. } => {
                if let Some(task) = read_task(tx, id)? {
                    facts.tasks.insert(task.id.clone(), task);
                }
                if let Some(Some(project_id)) = &changes.project_id {
                    project_ids.push(project_id);
                }
            }
            Mutation::ProjectCreate { project } => project_ids.push(&project.id),
            Mutation::ProjectUpdate { id, changes } => {
                project_ids.push(id);
                if matches!(changes.archived_at, Some(Some(_))) {
                    for task in read_tasks(tx, "project_id = ?1 AND open = 1", params![id])? {
                        facts.tasks.entry(task.id.clone()).or_insert(task);
                    }
                }
            }
        }
    }
    for id in project_ids {
        if !facts.projects.contains_key(id)
            && let Some(project) = read_project(tx, id)?
        {
            facts.projects.insert(project.id.clone(), project);
        }
    }
    Ok(facts)
}

/// まとまりの操作を順に、読んだ行に重ねながら検証する（Worker の planWrites と同じ）。
/// 同じ行への操作は、1 つの書き込みにまとまる
fn plan(batch: &MutationBatch, facts: &mut Facts) -> Step<Plan> {
    let mut order: Vec<RowKey> = Vec::new();
    let mut created: HashSet<RowKey> = HashSet::new();
    let mut touch = |kind: RowKind, id: &str| {
        if !order.iter().any(|(k, i)| *k == kind && i == id) {
            order.push((kind, id.to_string()));
        }
    };

    for mutation in &batch.mutations {
        match mutation {
            Mutation::TaskCreate { task: new } => {
                if facts.tasks.contains_key(&new.id) {
                    return Err(Stop::Rejected("task_exists"));
                }
                if is_blank(&new.title) || !is_valid_rank(&new.rank) {
                    return Err(Stop::Rejected("schema"));
                }
                let task = Task {
                    id: new.id.clone(),
                    title: new.title.clone(),
                    memo: new.memo.clone(),
                    bucket: new.bucket,
                    scheduled_on: new.scheduled_on.clone(),
                    deadline_on: None,
                    project_id: new.project_id.clone(),
                    rank: new.rank.clone(),
                    arrived_on: None,
                    checklist: Vec::new(),
                    completed_at: None,
                    started_at: None,
                    priority: None,
                    points: None,
                    created_at: String::new(),
                    updated_at: String::new(),
                    deleted_at: None,
                    seq: 0,
                };
                if !task.is_schedule_consistent() {
                    return Err(Stop::Rejected("schedule_mismatch"));
                }
                if let Some(project_id) = &task.project_id {
                    assert_attachable(facts, project_id)?;
                }
                created.insert((RowKind::Task, task.id.clone()));
                touch(RowKind::Task, &task.id);
                facts.tasks.insert(task.id.clone(), task);
            }
            Mutation::TaskUpdate {
                id,
                changes,
                base_checklist,
            } => {
                let Some(current) = facts.tasks.get(id) else {
                    return Err(Stop::Rejected("task_not_found"));
                };
                if changes.is_empty()
                    || changes.title.as_deref().is_some_and(is_blank)
                    || changes
                        .rank
                        .as_deref()
                        .is_some_and(|rank| !is_valid_rank(rank))
                {
                    return Err(Stop::Rejected("schema"));
                }
                // チェックリストは配列をまるごと置き換えるので、ほかの画面が先に変えていたら断る（黙って消さない）
                if let Some(base) = base_checklist
                    && current.checklist != *base
                {
                    return Err(Stop::Rejected("checklist_conflict"));
                }
                let mut next = current.clone();
                changes.apply_to(&mut next);
                if !next.is_schedule_consistent() {
                    return Err(Stop::Rejected("schedule_mismatch"));
                }
                // 進行中のタスクは必ず今日にある
                if !next.is_start_consistent() {
                    return Err(Stop::Rejected("started_outside_today"));
                }
                if let Some(project_id) = &next.project_id
                    && next.project_id != current.project_id
                {
                    assert_attachable(facts, project_id)?;
                }
                touch(RowKind::Task, id);
                facts.tasks.insert(id.clone(), next);
            }
            Mutation::ProjectCreate { project: new } => {
                if facts.projects.contains_key(&new.id) {
                    return Err(Stop::Rejected("project_exists"));
                }
                if is_blank(&new.name) {
                    return Err(Stop::Rejected("schema"));
                }
                created.insert((RowKind::Project, new.id.clone()));
                touch(RowKind::Project, &new.id);
                facts.projects.insert(
                    new.id.clone(),
                    Project {
                        id: new.id.clone(),
                        name: new.name.clone(),
                        color: None,
                        archived_at: None,
                        created_at: String::new(),
                        updated_at: String::new(),
                        deleted_at: None,
                        seq: 0,
                    },
                );
            }
            Mutation::ProjectUpdate { id, changes } => {
                let Some(current) = facts.projects.get(id) else {
                    return Err(Stop::Rejected("project_not_found"));
                };
                if changes.is_empty() || changes.name.as_deref().is_some_and(is_blank) {
                    return Err(Stop::Rejected("schema"));
                }
                // アーカイブするプロジェクトに、未完了のタスクが残っていてはいけない（このまとまりでの変更も含めて）
                if matches!(changes.archived_at, Some(Some(_)))
                    && facts
                        .tasks
                        .values()
                        .any(|task| task.project_id.as_deref() == Some(id) && is_open(task))
                {
                    return Err(Stop::Rejected("project_has_open_tasks"));
                }
                let mut next = current.clone();
                changes.apply_to(&mut next);
                touch(RowKind::Project, id);
                facts.projects.insert(id.clone(), next);
            }
        }
    }
    Ok(Plan { order, created })
}

impl DeviceDb {
    /// この端末のデータのファイルを開く（なければ作る）。開けなければ、理由の文言を返す
    /// （手元の控えと違って、保存できないまま動かさない）
    pub fn open(path: &Path) -> Result<DeviceDb, String> {
        let failed = |error: rusqlite::Error| {
            format!(
                "この端末のデータ（{}）を開けませんでした：{error}",
                path.display()
            )
        };
        let conn = Connection::open(path).map_err(failed)?;
        let version = Self::prepare(&conn).map_err(failed)?;
        if version != FORMAT_VERSION {
            // 新しい版の nagi が作ったデータ。古い版で書き換えて壊さない
            return Err(format!(
                "この端末のデータ（{}）は、新しい版の nagi のものです。nagi を更新してください",
                path.display()
            ));
        }
        Ok(DeviceDb { conn })
    }

    #[cfg(test)]
    pub fn open_in_memory() -> DeviceDb {
        let conn = Connection::open_in_memory().unwrap();
        Self::prepare(&conn).unwrap();
        DeviceDb { conn }
    }

    /// 表がなければ作る。保存形式の版を返す
    fn prepare(conn: &Connection) -> rusqlite::Result<i64> {
        conn.busy_timeout(StdDuration::from_secs(5))?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version == 0 {
            // open は、タスクが未完了・未削除か（プロジェクトのアーカイブの検証と、日付の切り替えで引く）
            conn.execute_batch(
                "BEGIN IMMEDIATE;
                 CREATE TABLE IF NOT EXISTS tasks (
                   id TEXT PRIMARY KEY,
                   seq INTEGER NOT NULL UNIQUE,
                   project_id TEXT,
                   open INTEGER NOT NULL,
                   deleted_at TEXT,
                   json TEXT NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS tasks_open ON tasks (open, project_id);
                 CREATE TABLE IF NOT EXISTS projects (
                   id TEXT PRIMARY KEY,
                   seq INTEGER NOT NULL UNIQUE,
                   deleted_at TEXT,
                   json TEXT NOT NULL
                 );
                 CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value NOT NULL);
                 INSERT OR IGNORE INTO meta (key, value) VALUES ('seq', 0), ('last_rollover_on', '');
                 CREATE TABLE IF NOT EXISTS applied (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
                 PRAGMA user_version = 1;
                 COMMIT;",
            )?;
        }
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
    }

    /// 操作のまとまりを反映する（Worker の applyMutationBatch と同じ）。全部成功か全部失敗。
    /// 同じ id のまとまりが再び来たら、書き込まずに、対象の行の今の内容を返す
    pub fn mutate(
        &mut self,
        batch: &MutationBatch,
        now: DateTime<Utc>,
    ) -> Result<Vec<SyncRow>, ApiFailure> {
        Ok(self.try_mutate(batch, now)?)
    }

    fn try_mutate(&mut self, batch: &MutationBatch, now: DateTime<Utc>) -> Step<Vec<SyncRow>> {
        if batch.mutations.is_empty() || batch.mutations.len() > MAX_MUTATIONS_PER_BATCH {
            return Err(Stop::Rejected("schema"));
        }
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;

        let applied: Option<String> = tx
            .query_row(
                "SELECT id FROM applied WHERE id = ?1",
                params![batch.id],
                |row| row.get(0),
            )
            .optional()?;
        if applied.is_some() {
            let mut rows = Vec::new();
            let mut seen = HashSet::new();
            for mutation in &batch.mutations {
                let (kind, id) = mutation.target();
                if !seen.insert((kind, id)) {
                    continue;
                }
                match kind {
                    RowKind::Task => rows.extend(read_task(&tx, id)?.map(SyncRow::Task)),
                    RowKind::Project => rows.extend(read_project(&tx, id)?.map(SyncRow::Project)),
                }
            }
            rows.sort_by_key(seq_of);
            return Ok(rows);
        }

        let mut facts = load_facts(&tx, batch)?;
        let Plan { order, created } = plan(batch, &mut facts)?;

        let timestamp = iso(now);
        let base = read_seq(&tx)?;
        let mut rows = Vec::with_capacity(order.len());
        for (i, key) in order.iter().enumerate() {
            let seq = base + i as u64 + 1;
            let (kind, id) = key;
            match kind {
                RowKind::Task => {
                    let task = facts
                        .tasks
                        .get_mut(id)
                        .ok_or_else(|| Stop::Broken(format!("書き込む行がありません: {id}")))?;
                    task.seq = seq;
                    task.updated_at.clone_from(&timestamp);
                    if created.contains(key) {
                        task.created_at.clone_from(&timestamp);
                    }
                    put_task(&tx, task)?;
                    rows.push(SyncRow::Task(task.clone()));
                }
                RowKind::Project => {
                    let project = facts
                        .projects
                        .get_mut(id)
                        .ok_or_else(|| Stop::Broken(format!("書き込む行がありません: {id}")))?;
                    project.seq = seq;
                    project.updated_at.clone_from(&timestamp);
                    if created.contains(key) {
                        project.created_at.clone_from(&timestamp);
                    }
                    put_project(&tx, project)?;
                    rows.push(SyncRow::Project(project.clone()));
                }
            }
        }
        write_seq(&tx, base + order.len() as u64)?;
        tx.execute(
            "INSERT INTO applied (id, applied_at) VALUES (?1, ?2)",
            params![batch.id, timestamp],
        )?;
        tx.commit()?;
        Ok(rows)
    }

    /// cursor より新しい行を返す（Worker の /api/sync と同じ）。その前に、必要なら日付の切り替えを行う。
    /// cursor がここの seq より先（データのファイルを入れ替えたとき）なら、全件を返して取り直させる
    pub fn sync(
        &mut self,
        cursor: u64,
        now: DateTime<Utc>,
        tz: Tz,
    ) -> Result<SyncFlow, ApiFailure> {
        Ok(self.try_sync(cursor, now, tz)?)
    }

    fn try_sync(&mut self, cursor: u64, now: DateTime<Utc>, tz: Tz) -> Step<SyncFlow> {
        let tx = self
            .conn
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        rollover_if_due(&tx, now, &logical_date(now, tz))?;
        let seq = read_seq(&tx)?;
        let base_cursor = if cursor > seq { 0 } else { cursor };
        let rows = rows_after(&tx, base_cursor)?;
        tx.commit()?;
        Ok(SyncFlow {
            base_cursor,
            rows,
            cursor: seq,
        })
    }

    /// 未削除のタスクとプロジェクトの数（ログインしたときに、この端末に残っている行があるかを知らせるのに使う）
    pub fn count(&self) -> rusqlite::Result<usize> {
        let count: i64 = self.conn.query_row(
            "SELECT (SELECT COUNT(*) FROM tasks WHERE deleted_at IS NULL)
                  + (SELECT COUNT(*) FROM projects WHERE deleted_at IS NULL)",
            [],
            |row| row.get(0),
        )?;
        Ok(usize::try_from(count).unwrap_or(0))
    }
}

/// 今日に入るきっかけになった日付（予定の日付と締切のうち、今日以前で早いほう）
fn arrival_date<'a>(task: &'a Task, today: &str) -> Option<&'a str> {
    [task.scheduled_on.as_deref(), task.deadline_on.as_deref()]
        .into_iter()
        .flatten()
        .filter(|date| *date <= today)
        .min()
}

/// 日付の切り替え（午前4時。Worker の rolloverIfDue と同じ）。last_rollover_on が今日より前なら行う。
/// 1. 未完了・未削除で、今日の置き場になく、予定の日付か締切が今日以前のタスクを、今日の
///    「今日来たタスクの後ろ、それ以外の前」へ移す（日付の早い順、同じなら作成順。arrivedOn に今日を入れ、scheduledOn は空にする）
/// 2. 削除から 30 日たった行を物理削除し、7 日たった反映済みのまとまりを消す
/// 3. last_rollover_on を今日にする
fn rollover_if_due(tx: &Transaction, now: DateTime<Utc>, today: &str) -> Step<()> {
    let last: String = tx.query_row(
        "SELECT value FROM meta WHERE key = 'last_rollover_on'",
        [],
        |row| row.get(0),
    )?;
    if last.as_str() >= today {
        return Ok(());
    }

    let open = read_tasks(tx, "open = 1", [])?;
    let mut moving: Vec<&Task> = open
        .iter()
        .filter(|task| task.bucket != Bucket::Today && arrival_date(task, today).is_some())
        .collect();
    moving.sort_by(|a, b| {
        arrival_date(a, today)
            .cmp(&arrival_date(b, today))
            .then_with(|| a.created_at.cmp(&b.created_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    let today_tasks: Vec<(&str, &str, Option<&str>)> = open
        .iter()
        .filter(|task| task.bucket == Bucket::Today)
        .map(|task| {
            (
                task.id.as_str(),
                task.rank.as_str(),
                task.arrived_on.as_deref(),
            )
        })
        .collect();
    let ranks = arrival_ranks(&today_tasks, today, moving.len());

    let timestamp = iso(now);
    let base = read_seq(tx)?;
    for (i, (task, rank)) in moving.iter().zip(ranks).enumerate() {
        let mut task = (*task).clone();
        task.bucket = Bucket::Today;
        task.rank = rank;
        task.arrived_on = Some(today.to_string());
        task.scheduled_on = None;
        task.updated_at.clone_from(&timestamp);
        task.seq = base + i as u64 + 1;
        put_task(tx, &task)?;
    }
    write_seq(tx, base + moving.len() as u64)?;

    let purge_before = iso(now - Duration::days(DELETED_ROW_TTL_DAYS));
    let applied_before = iso(now - Duration::days(APPLIED_TTL_DAYS));
    tx.execute(
        "DELETE FROM tasks WHERE deleted_at < ?1",
        params![purge_before],
    )?;
    tx.execute(
        "DELETE FROM projects WHERE deleted_at < ?1",
        params![purge_before],
    )?;
    tx.execute(
        "DELETE FROM applied WHERE applied_at < ?1",
        params![applied_before],
    )?;
    tx.execute(
        "UPDATE meta SET value = ?1 WHERE key = 'last_rollover_on'",
        params![today],
    )?;
    Ok(())
}

enum Request {
    Mutate(MutationBatch),
    Sync(u64),
}

/// 通信の代わりに、この端末のデータ（DeviceDb）が応える出口。処理は専用のスレッドで 1 つずつ順に行い、
/// 結果は通信と同じ形（NetEvent）で notify に渡す
pub struct DeviceTransport {
    requests: Sender<Request>,
}

impl DeviceTransport {
    /// DeviceTransport を捨てると、スレッドは今の処理を終えたあとに止まる
    pub fn spawn(
        mut db: DeviceDb,
        tz: Tz,
        notify: impl Fn(NetEvent) + Send + 'static,
    ) -> DeviceTransport {
        let (requests, inbox) = channel::<Request>();
        thread::spawn(move || {
            for request in inbox {
                match request {
                    Request::Mutate(batch) => {
                        let result = db.mutate(&batch, Utc::now());
                        notify(NetEvent::MutateDone {
                            batch_id: batch.id,
                            result,
                        });
                    }
                    Request::Sync(cursor) => {
                        notify(NetEvent::SyncDone(db.sync(cursor, Utc::now(), tz)));
                    }
                }
            }
        });
        DeviceTransport { requests }
    }
}

impl Transport for DeviceTransport {
    fn mutate(&mut self, batch: MutationBatch) {
        let _ = self.requests.send(Request::Mutate(batch));
    }

    fn sync(&mut self, cursor: u64) {
        let _ = self.requests.send(Request::Sync(cursor));
    }
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::VecDeque;
    use std::rc::Rc;

    use super::*;
    use crate::data::actions::{AddTask, Destination};
    use crate::data::store::{Store, StoreOptions};
    use crate::dates::{APP_TIME_ZONE, parse_iso};
    use crate::model::{ChecklistItem, NewProject, NewTask, ProjectChanges, TaskChanges};

    /// 東京の 2026-10-06 12:00
    const NOW: &str = "2026-10-06T03:00:00.000Z";
    const TODAY: &str = "2026-10-06";

    fn at(time: &str) -> DateTime<Utc> {
        parse_iso(time).unwrap()
    }

    fn id(n: u32) -> String {
        format!("00000000-0000-7000-8000-{n:012}")
    }

    fn batch(n: u32, mutations: Vec<Mutation>) -> MutationBatch {
        MutationBatch {
            id: id(900_000 + n),
            mutations,
        }
    }

    fn create(n: u32, bucket: Bucket, rank: &str) -> Mutation {
        Mutation::TaskCreate {
            task: NewTask {
                id: id(n),
                title: format!("タスク {n}"),
                memo: String::new(),
                bucket,
                scheduled_on: None,
                project_id: None,
                rank: rank.to_string(),
            },
        }
    }

    fn create_with(
        n: u32,
        bucket: Bucket,
        rank: &str,
        edit: impl FnOnce(&mut NewTask),
    ) -> Mutation {
        let Mutation::TaskCreate { mut task } = create(n, bucket, rank) else {
            unreachable!()
        };
        edit(&mut task);
        Mutation::TaskCreate { task }
    }

    fn scheduled(n: u32, on: &str, rank: &str) -> Mutation {
        create_with(n, Bucket::Scheduled, rank, |task| {
            task.scheduled_on = Some(on.to_string());
        })
    }

    fn update(n: u32, changes: TaskChanges) -> Mutation {
        Mutation::update_task(&id(n), changes)
    }

    fn project(n: u32) -> Mutation {
        Mutation::ProjectCreate {
            project: NewProject {
                id: id(n),
                name: format!("プロジェクト {n}"),
            },
        }
    }

    fn update_project(n: u32, changes: ProjectChanges) -> Mutation {
        Mutation::ProjectUpdate { id: id(n), changes }
    }

    fn task_of(row: &SyncRow) -> &Task {
        match row {
            SyncRow::Task(task) => task,
            SyncRow::Project(_) => panic!("タスクの行ではありません"),
        }
    }

    fn reason(result: Result<Vec<SyncRow>, ApiFailure>) -> String {
        match result {
            Err(ApiFailure::Rejected {
                status: 400,
                reason: Some(reason),
            }) => reason,
            other => panic!("断られるはずが: {other:?}"),
        }
    }

    fn seq(db: &DeviceDb) -> i64 {
        db.conn
            .query_row("SELECT value FROM meta WHERE key = 'seq'", [], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn all(db: &mut DeviceDb) -> Vec<SyncRow> {
        db.sync(0, at(NOW), APP_TIME_ZONE).unwrap().rows
    }

    #[test]
    fn 作成と更新は_書いた順に通し番号を振り_時刻を入れる() {
        let mut db = DeviceDb::open_in_memory();
        let rows = db
            .mutate(
                &batch(
                    1,
                    vec![
                        project(10),
                        create_with(1, Bucket::Inbox, "a0", |task| {
                            task.project_id = Some(id(10));
                            task.memo = "メモ".to_string();
                        }),
                        scheduled(2, "2026-10-10", "a1"),
                    ],
                ),
                at(NOW),
            )
            .unwrap();

        assert_eq!(rows.iter().map(seq_of).collect::<Vec<_>>(), vec![1, 2, 3]);
        let SyncRow::Project(created_project) = &rows[0] else {
            panic!("プロジェクトの行ではありません")
        };
        assert_eq!(created_project.name, "プロジェクト 10");
        assert_eq!(created_project.color, None);
        assert_eq!(created_project.created_at, NOW);
        let first = task_of(&rows[1]);
        assert_eq!(
            (first.title.as_str(), first.memo.as_str(), first.bucket),
            ("タスク 1", "メモ", Bucket::Inbox)
        );
        assert_eq!(first.project_id, Some(id(10)));
        assert_eq!(
            (first.created_at.as_str(), first.updated_at.as_str()),
            (NOW, NOW)
        );
        // 省いた項目は空
        assert!(first.checklist.is_empty());
        assert_eq!(
            (
                &first.deadline_on,
                &first.completed_at,
                &first.started_at,
                &first.deleted_at
            ),
            (&None, &None, &None, &None)
        );
        assert_eq!((first.priority, first.points), (None, None));
        assert_eq!(
            task_of(&rows[2]).scheduled_on.as_deref(),
            Some("2026-10-10")
        );

        // 更新：updatedAt と seq だけが進み、createdAt はそのまま
        let later = "2026-10-06T04:00:00.000Z";
        let updated = db
            .mutate(
                &batch(
                    2,
                    vec![update(
                        1,
                        TaskChanges {
                            title: Some("書き換え".to_string()),
                            priority: Some(Some(crate::model::Priority::High)),
                            ..Default::default()
                        },
                    )],
                ),
                at(later),
            )
            .unwrap();
        let task = task_of(&updated[0]);
        assert_eq!((task.seq, task.title.as_str()), (4, "書き換え"));
        assert_eq!(
            (task.created_at.as_str(), task.updated_at.as_str()),
            (NOW, later)
        );
        assert_eq!(task.memo, "メモ");

        // 差分：cursor より新しい行だけを、seq の順に
        let flow = db.sync(0, at(later), APP_TIME_ZONE).unwrap();
        assert_eq!((flow.base_cursor, flow.cursor), (0, 4));
        assert_eq!(
            flow.rows.iter().map(seq_of).collect::<Vec<_>>(),
            vec![1, 3, 4]
        );
        let flow = db.sync(3, at(later), APP_TIME_ZONE).unwrap();
        assert_eq!((flow.base_cursor, flow.cursor), (3, 4));
        assert_eq!(flow.rows.iter().map(seq_of).collect::<Vec<_>>(), vec![4]);
        let flow = db.sync(4, at(later), APP_TIME_ZONE).unwrap();
        assert!(flow.rows.is_empty());
    }

    #[test]
    fn 同じ行への操作は_1つの書き込みにまとまる() {
        let mut db = DeviceDb::open_in_memory();
        let rows = db
            .mutate(
                &batch(
                    1,
                    vec![
                        create(1, Bucket::Inbox, "a0"),
                        update(
                            1,
                            TaskChanges {
                                title: Some("あとから".to_string()),
                                ..Default::default()
                            },
                        ),
                        create(2, Bucket::Inbox, "a1"),
                        update(
                            1,
                            TaskChanges {
                                memo: Some("メモ".to_string()),
                                ..Default::default()
                            },
                        ),
                    ],
                ),
                at(NOW),
            )
            .unwrap();

        // 最初に触れた順に 1 行ずつ
        assert_eq!(rows.len(), 2);
        let first = task_of(&rows[0]);
        assert_eq!(
            (
                first.id.clone(),
                first.seq,
                first.title.as_str(),
                first.memo.as_str()
            ),
            (id(1), 1, "あとから", "メモ")
        );
        assert_eq!(
            (task_of(&rows[1]).id.clone(), task_of(&rows[1]).seq),
            (id(2), 2)
        );
        assert_eq!(seq(&db), 2);
    }

    #[test]
    fn 受け付けられない操作は_理由を返して_何も書かない() {
        let mut db = DeviceDb::open_in_memory();
        let item = |n: u32, done: bool| ChecklistItem {
            id: id(n),
            title: "項目".to_string(),
            done,
        };
        db.mutate(
            &batch(
                1,
                vec![
                    project(10), // ふつうのプロジェクト（未完了のタスク 1 がある）
                    project(11), // アーカイブ済み
                    project(12), // 削除済み
                    create_with(1, Bucket::Inbox, "a0", |task| {
                        task.project_id = Some(id(10))
                    }),
                    create(2, Bucket::Today, "a0"),
                    update(
                        2,
                        TaskChanges {
                            started_at: Some(Some(NOW.to_string())),
                            checklist: Some(vec![item(50, false)]),
                            ..Default::default()
                        },
                    ),
                    update_project(
                        11,
                        ProjectChanges {
                            archived_at: Some(Some(NOW.to_string())),
                            ..Default::default()
                        },
                    ),
                    update_project(
                        12,
                        ProjectChanges {
                            deleted_at: Some(Some(NOW.to_string())),
                            ..Default::default()
                        },
                    ),
                ],
            ),
            at(NOW),
        )
        .unwrap();
        let before = (seq(&db), all(&mut db));

        let to = |bucket| TaskChanges {
            bucket: Some(bucket),
            ..Default::default()
        };
        let attach = |project: u32| TaskChanges {
            project_id: Some(Some(id(project))),
            ..Default::default()
        };
        let archive = ProjectChanges {
            archived_at: Some(Some(NOW.to_string())),
            ..Default::default()
        };
        let cases: Vec<(&str, Vec<Mutation>)> = vec![
            ("task_exists", vec![create(1, Bucket::Inbox, "a5")]),
            (
                "task_exists",
                vec![
                    create(3, Bucket::Inbox, "a5"),
                    create(3, Bucket::Inbox, "a6"),
                ],
            ),
            ("task_not_found", vec![update(99, to(Bucket::Later))]),
            (
                "schedule_mismatch",
                vec![create(3, Bucket::Scheduled, "a5")],
            ),
            (
                "schedule_mismatch",
                vec![create_with(3, Bucket::Inbox, "a5", |task| {
                    task.scheduled_on = Some("2026-10-10".to_string());
                })],
            ),
            ("schedule_mismatch", vec![update(1, to(Bucket::Scheduled))]),
            (
                "schedule_mismatch",
                vec![update(
                    1,
                    TaskChanges {
                        scheduled_on: Some(Some("2026-10-10".to_string())),
                        ..Default::default()
                    },
                )],
            ),
            (
                "started_outside_today",
                vec![update(
                    1,
                    TaskChanges {
                        started_at: Some(Some(NOW.to_string())),
                        ..Default::default()
                    },
                )],
            ),
            ("started_outside_today", vec![update(2, to(Bucket::Later))]),
            (
                "project_not_found",
                vec![create_with(3, Bucket::Inbox, "a5", |task| {
                    task.project_id = Some(id(99))
                })],
            ),
            ("project_not_found", vec![update(2, attach(99))]),
            ("project_archived", vec![update(2, attach(11))]),
            ("project_deleted", vec![update(2, attach(12))]),
            ("project_exists", vec![project(10)]),
            (
                "project_not_found",
                vec![update_project(
                    99,
                    ProjectChanges {
                        name: Some("名前".to_string()),
                        ..Default::default()
                    },
                )],
            ),
            (
                "project_has_open_tasks",
                vec![update_project(10, archive.clone())],
            ),
            (
                // このまとまりで作る未完了のタスクも数える
                "project_has_open_tasks",
                vec![
                    project(13),
                    create_with(3, Bucket::Inbox, "a5", |task| {
                        task.project_id = Some(id(13))
                    }),
                    update_project(13, archive.clone()),
                ],
            ),
            (
                "checklist_conflict",
                vec![Mutation::TaskUpdate {
                    id: id(2),
                    changes: TaskChanges {
                        checklist: Some(vec![item(50, true)]),
                        ..Default::default()
                    },
                    base_checklist: Some(vec![item(51, false)]),
                }],
            ),
            (
                "schema",
                vec![create_with(3, Bucket::Inbox, "a5", |task| {
                    task.title = "  ".to_string()
                })],
            ),
            ("schema", vec![create(3, Bucket::Inbox, "not a rank")]),
            ("schema", vec![update(1, TaskChanges::default())]),
            (
                "schema",
                vec![update(
                    1,
                    TaskChanges {
                        title: Some(String::new()),
                        ..Default::default()
                    },
                )],
            ),
            ("schema", vec![]),
            (
                // 通る操作のあとで断られたら、まとまりごと書かない
                "task_not_found",
                vec![
                    create(3, Bucket::Inbox, "a5"),
                    update(99, to(Bucket::Later)),
                ],
            ),
        ];
        for (i, (expected, mutations)) in cases.into_iter().enumerate() {
            let result = db.mutate(&batch(100 + i as u32, mutations), at(NOW));
            assert_eq!(reason(result), expected, "{i} 番目");
            assert_eq!(
                (seq(&db), all(&mut db)),
                before,
                "{i} 番目：何も書かれていないこと"
            );
        }
    }

    #[test]
    fn 検証は_まとまりの中の前の操作を踏まえる() {
        let mut db = DeviceDb::open_in_memory();
        db.mutate(
            &batch(
                1,
                vec![
                    project(10),
                    create_with(1, Bucket::Inbox, "a0", |task| {
                        task.project_id = Some(id(10))
                    }),
                ],
            ),
            at(NOW),
        )
        .unwrap();

        // 未完了のタスクを同じまとまりで完了にすれば、アーカイブできる
        let rows = db
            .mutate(
                &batch(
                    2,
                    vec![
                        update(
                            1,
                            TaskChanges {
                                completed_at: Some(Some(NOW.to_string())),
                                ..Default::default()
                            },
                        ),
                        update_project(
                            10,
                            ProjectChanges {
                                archived_at: Some(Some(NOW.to_string())),
                                ..Default::default()
                            },
                        ),
                    ],
                ),
                at(NOW),
            )
            .unwrap();
        assert_eq!(rows.len(), 2);

        // アーカイブ済みのプロジェクトが付いたままのタスクも、ほかの項目は変えられる（付け直すときだけ確かめる）
        let rows = db
            .mutate(
                &batch(
                    3,
                    vec![update(
                        1,
                        TaskChanges {
                            memo: Some("あとから".to_string()),
                            project_id: Some(Some(id(10))),
                            ..Default::default()
                        },
                    )],
                ),
                at(NOW),
            )
            .unwrap();
        assert_eq!(task_of(&rows[0]).memo, "あとから");

        // チェックリストは、変える前の配列が今と同じなら通る
        let item = ChecklistItem {
            id: id(50),
            title: "項目".to_string(),
            done: false,
        };
        let rows = db
            .mutate(
                &batch(
                    4,
                    vec![Mutation::TaskUpdate {
                        id: id(1),
                        changes: TaskChanges {
                            checklist: Some(vec![item.clone()]),
                            ..Default::default()
                        },
                        base_checklist: Some(Vec::new()),
                    }],
                ),
                at(NOW),
            )
            .unwrap();
        assert_eq!(task_of(&rows[0]).checklist, vec![item]);
    }

    #[test]
    fn 同じまとまりが再び来たら_書き込まずに今の行を返す() {
        let mut db = DeviceDb::open_in_memory();
        let first = batch(1, vec![project(10), create(1, Bucket::Inbox, "a0")]);
        let rows = db.mutate(&first, at(NOW)).unwrap();

        assert_eq!(db.mutate(&first, at(NOW)).unwrap(), rows);
        assert_eq!(seq(&db), 2);

        // そのあとで行が変わっていたら、変わったあとの行を返す
        db.mutate(
            &batch(
                2,
                vec![update(
                    1,
                    TaskChanges {
                        title: Some("変更".to_string()),
                        ..Default::default()
                    },
                )],
            ),
            at(NOW),
        )
        .unwrap();
        let again = db.mutate(&first, at(NOW)).unwrap();
        assert_eq!(again.iter().map(seq_of).collect::<Vec<_>>(), vec![1, 3]);
        assert_eq!(task_of(&again[1]).title, "変更");
        assert_eq!(seq(&db), 3);
    }

    #[test]
    fn カーソルがデータより先なら_全件を返して取り直させる() {
        let mut db = DeviceDb::open_in_memory();
        db.mutate(&batch(1, vec![create(1, Bucket::Inbox, "a0")]), at(NOW))
            .unwrap();

        let flow = db.sync(999, at(NOW), APP_TIME_ZONE).unwrap();

        assert_eq!((flow.base_cursor, flow.cursor, flow.rows.len()), (0, 1, 1));
    }

    #[test]
    fn 日付の切り替えで_期限の来たタスクを今日へ移す() {
        let mut db = DeviceDb::open_in_memory();
        // 前の日（東京の 2026-10-05 12:00）に、切り替えを済ませてから仕込む
        let yesterday = "2026-10-05T03:00:00.000Z";
        db.sync(0, at(yesterday), APP_TIME_ZONE).unwrap();
        let deadline = |on: &str| TaskChanges {
            deadline_on: Some(Some(on.to_string())),
            ..Default::default()
        };
        db.mutate(
            &batch(
                1,
                vec![
                    scheduled(1, TODAY, "a0"),        // 今日の予定 → 移る
                    scheduled(2, "2026-10-04", "a1"), // 過ぎた予定 → 先に移る
                    create(3, Bucket::Inbox, "a0"),   // 締切が今日 → 移る
                    update(3, deadline(TODAY)),
                    create(4, Bucket::Later, "a0"), // 締切が先 → 残る
                    update(4, deadline("2026-10-20")),
                    scheduled(5, "2026-10-07", "a2"), // 明日の予定 → 残る
                    scheduled(6, TODAY, "a3"),        // 完了済み → 残る
                    update(
                        6,
                        TaskChanges {
                            completed_at: Some(Some(yesterday.to_string())),
                            ..Default::default()
                        },
                    ),
                    scheduled(7, TODAY, "a4"), // 削除済み → 残る
                    update(
                        7,
                        TaskChanges {
                            deleted_at: Some(Some(yesterday.to_string())),
                            ..Default::default()
                        },
                    ),
                    create(8, Bucket::Today, "a5"), // もう今日にある → そのまま
                    update(8, deadline("2026-10-01")),
                ],
            ),
            at(yesterday),
        )
        .unwrap();
        assert_eq!(seq(&db), 8);

        let flow = db.sync(8, at(NOW), APP_TIME_ZONE).unwrap();

        // 移ったのは 3 件。日付の早い順、同じなら作成順（ここでは書いた順）に seq が付く
        let moved: Vec<&Task> = flow.rows.iter().map(task_of).collect();
        assert_eq!(
            moved
                .iter()
                .map(|task| (task.id.clone(), task.seq))
                .collect::<Vec<_>>(),
            vec![(id(2), 9), (id(1), 10), (id(3), 11)]
        );
        for task in &moved {
            assert_eq!(task.bucket, Bucket::Today);
            assert_eq!(task.arrived_on.as_deref(), Some(TODAY));
            assert_eq!(task.scheduled_on, None);
            assert_eq!(task.updated_at, NOW);
            assert_eq!(task.created_at, yesterday);
        }
        // 締切は残る。並び順は、移った順で、もとから今日にあったタスク（a5）より前
        assert_eq!(moved[2].deadline_on.as_deref(), Some(TODAY));
        assert!(moved[0].rank < moved[1].rank && moved[1].rank < moved[2].rank);
        assert!(moved[2].rank.as_str() < "a5");
        assert_eq!(flow.cursor, 11);

        // 同じ日には、もう動かない
        let again = db
            .sync(11, at("2026-10-06T10:00:00.000Z"), APP_TIME_ZONE)
            .unwrap();
        assert!(again.rows.is_empty());
        assert_eq!(again.cursor, 11);

        // 次の日に来たタスクは、その日に来たものがないので一番上へ
        db.mutate(&batch(2, vec![scheduled(9, "2026-10-07", "a6")]), at(NOW))
            .unwrap();
        let next = db
            .sync(12, at("2026-10-07T03:00:00.000Z"), APP_TIME_ZONE)
            .unwrap();
        let arrived: Vec<&Task> = next.rows.iter().map(task_of).collect();
        assert_eq!(
            arrived
                .iter()
                .map(|task| task.id.clone())
                .collect::<Vec<_>>(),
            vec![id(5), id(9)]
        );
        assert!(arrived[1].rank < moved[0].rank);
    }

    #[test]
    fn 午前4時までは_前の日のまま() {
        let mut db = DeviceDb::open_in_memory();
        db.sync(0, at("2026-10-05T03:00:00.000Z"), APP_TIME_ZONE)
            .unwrap();
        db.mutate(
            &batch(1, vec![scheduled(1, TODAY, "a0")]),
            at("2026-10-05T03:00:00.000Z"),
        )
        .unwrap();

        // 東京の 2026-10-06 03:59
        let before = db
            .sync(1, at("2026-10-05T18:59:00.000Z"), APP_TIME_ZONE)
            .unwrap();
        assert!(before.rows.is_empty());
        // 東京の 2026-10-06 04:00
        let after = db
            .sync(1, at("2026-10-05T19:00:00.000Z"), APP_TIME_ZONE)
            .unwrap();
        assert_eq!(after.rows.len(), 1);
        assert_eq!(task_of(&after.rows[0]).bucket, Bucket::Today);
    }

    #[test]
    fn 日付の切り替えで_古い削除済みの行と反映済みの覚えを消す() {
        let mut db = DeviceDb::open_in_memory();
        let days_ago = |days: i64| iso(at(NOW) - Duration::days(days));
        let deleted = |at: String| TaskChanges {
            deleted_at: Some(Some(at)),
            ..Default::default()
        };
        // 反映済みの覚えは、まとまりを反映した時刻で古さが決まる
        db.mutate(
            &batch(
                1,
                vec![
                    project(10),
                    update_project(
                        10,
                        ProjectChanges {
                            deleted_at: Some(Some(days_ago(31))),
                            ..Default::default()
                        },
                    ),
                    create(1, Bucket::Inbox, "a0"),
                    update(1, deleted(days_ago(31))),
                ],
            ),
            at(NOW) - Duration::days(8),
        )
        .unwrap();
        db.mutate(
            &batch(
                2,
                vec![
                    create(2, Bucket::Inbox, "a1"),
                    update(2, deleted(days_ago(29))),
                ],
            ),
            at(NOW) - Duration::days(6),
        )
        .unwrap();

        let rows = all(&mut db);

        assert_eq!(
            rows.iter()
                .map(|row| task_of(row).id.clone())
                .collect::<Vec<_>>(),
            vec![id(2)]
        );
        let applied: Vec<String> = db
            .conn
            .prepare("SELECT id FROM applied")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(applied, vec![id(900_002)]);
        assert_eq!(db.count().unwrap(), 0);
    }

    #[test]
    fn 画面とcliが同じファイルを開いても_通し番号は重ならず_互いの行が見える() {
        let path = std::env::temp_dir().join(format!(
            "nagi-device-test-{}-{}.db",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        let mut screen = DeviceDb::open(&path).unwrap();
        let mut cli = DeviceDb::open(&path).unwrap();

        screen
            .mutate(&batch(1, vec![create(1, Bucket::Inbox, "a0")]), at(NOW))
            .unwrap();
        let from_cli = cli
            .mutate(&batch(2, vec![create(2, Bucket::Inbox, "a1")]), at(NOW))
            .unwrap();
        assert_eq!(seq_of(&from_cli[0]), 2);

        // 画面は、次の差分で CLI の行を受け取る
        let flow = screen.sync(1, at(NOW), APP_TIME_ZONE).unwrap();
        assert_eq!(
            flow.rows
                .iter()
                .map(|row| task_of(row).id.clone())
                .collect::<Vec<_>>(),
            vec![id(2)]
        );
        // 相手が作った行は、もうあるものとして検証される
        assert_eq!(
            reason(cli.mutate(&batch(3, vec![create(1, Bucket::Inbox, "a2")]), at(NOW))),
            "task_exists"
        );
        // 同じまとまりを、もう片方から送り直しても二重に書かない
        screen
            .mutate(&batch(2, vec![create(2, Bucket::Inbox, "a1")]), at(NOW))
            .unwrap();
        assert_eq!(seq(&screen), 2);
        assert_eq!(screen.count().unwrap(), 2);

        drop(screen);
        drop(cli);
        // 開き直しても残っている
        let mut reopened = DeviceDb::open(&path).unwrap();
        assert_eq!(all(&mut reopened).len(), 2);
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    #[test]
    fn 新しい版の保存形式は_開かずに断る() {
        let path = std::env::temp_dir().join(format!(
            "nagi-device-test-{}-{}.db",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        drop(DeviceDb::open(&path).unwrap());
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "user_version", FORMAT_VERSION + 1)
            .unwrap();
        drop(conn);

        let error = DeviceDb::open(&path).err().unwrap();

        assert!(error.contains("新しい版の nagi"), "{error}");
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
    }

    // --- ストアとつないで動かす -----------------------------------------------------------

    /// 通信の代わりに、その場で DeviceDb に応えさせる出口（結果は列にためて、テストがストアへ届ける）
    struct Inline {
        db: Rc<RefCell<DeviceDb>>,
        events: Rc<RefCell<VecDeque<NetEvent>>>,
    }

    impl Transport for Inline {
        fn mutate(&mut self, batch: MutationBatch) {
            let result = self.db.borrow_mut().mutate(&batch, at(NOW));
            self.events.borrow_mut().push_back(NetEvent::MutateDone {
                batch_id: batch.id,
                result,
            });
        }

        fn sync(&mut self, cursor: u64) {
            let result = self.db.borrow_mut().sync(cursor, at(NOW), APP_TIME_ZONE);
            self.events
                .borrow_mut()
                .push_back(NetEvent::SyncDone(result));
        }
    }

    struct Screen {
        store: Store,
        events: Rc<RefCell<VecDeque<NetEvent>>>,
    }

    impl Screen {
        /// 画面や CLI を開いたときと同じく、控えなしのストアを作って、最初の差分を取る
        fn open(db: &Rc<RefCell<DeviceDb>>) -> Screen {
            let events = Rc::new(RefCell::new(VecDeque::new()));
            let store = Store::new(StoreOptions {
                transport: Box::new(Inline {
                    db: Rc::clone(db),
                    events: Rc::clone(&events),
                }),
                local: None,
                clock: Box::new(|| at(NOW)),
                tz: APP_TIME_ZONE,
            });
            let mut screen = Screen { store, events };
            screen.store.sync();
            screen.settle();
            screen
        }

        /// たまった結果を、すべてストアへ届ける
        fn settle(&mut self) {
            loop {
                let Some(event) = self.events.borrow_mut().pop_front() else {
                    break;
                };
                match event {
                    NetEvent::MutateDone { batch_id, result } => {
                        self.store.on_mutate_done(&batch_id, result);
                    }
                    NetEvent::SyncDone(result) => self.store.on_sync_done(result),
                }
            }
        }

        fn titles(&self, ids: &[String]) -> Vec<String> {
            ids.iter()
                .map(|id| self.store.replica.task(id).unwrap().title.clone())
                .collect()
        }
    }

    #[test]
    fn ストアの操作が_この端末のデータに保存され_開き直しても残る() {
        let db = Rc::new(RefCell::new(DeviceDb::open_in_memory()));
        let mut screen = Screen::open(&db);
        assert!(screen.store.synced && screen.store.is_online);

        let add = |screen: &mut Screen, title: &str, to: Destination| {
            screen
                .store
                .add_task(AddTask {
                    title: title.to_string(),
                    memo: String::new(),
                    project_id: None,
                    to,
                })
                .unwrap();
            screen.settle();
        };
        add(&mut screen, "受信箱の 1", Destination::Inbox);
        add(&mut screen, "今日の 1", Destination::Today);
        add(&mut screen, "今日の 2", Destination::Today);
        add(
            &mut screen,
            "予定",
            Destination::Scheduled("2026-10-10".to_string()),
        );
        assert_eq!(screen.store.pending_count(), 0);
        assert!(screen.store.take_notices().is_empty());

        let lists = screen.store.lists();
        assert_eq!(screen.titles(&lists.inbox), vec!["受信箱の 1"]);
        assert_eq!(screen.titles(&lists.today), vec!["今日の 1", "今日の 2"]);
        assert_eq!(screen.titles(&lists.scheduled), vec!["予定"]);

        // プロジェクトを作って付け、完了にし、元に戻す
        let today_1 = lists.today[0].clone();
        let inbox_1 = lists.inbox[0].clone();
        screen
            .store
            .create_project("仕事", std::slice::from_ref(&inbox_1))
            .unwrap();
        screen.settle();
        screen
            .store
            .complete_tasks(std::slice::from_ref(&today_1))
            .unwrap();
        screen.settle();
        screen
            .store
            .delete_tasks(std::slice::from_ref(&inbox_1))
            .unwrap();
        screen.settle();
        screen.store.undo().unwrap();
        screen.settle();
        assert_eq!(screen.store.pending_count(), 0);
        assert!(screen.store.take_notices().is_empty());

        // 開き直す（控えは持たないので、全件をこの端末のデータから読む）
        let reopened = Screen::open(&db);
        let lists = reopened.store.lists();
        assert_eq!(reopened.titles(&lists.inbox), vec!["受信箱の 1"]);
        assert_eq!(reopened.titles(&lists.today), vec!["今日の 2"]);
        assert_eq!(reopened.titles(&lists.completed_today), vec!["今日の 1"]);
        assert_eq!(lists.projects.len(), 1);
        let task = reopened.store.replica.task(&inbox_1).unwrap();
        assert_eq!(task.project_id.as_ref(), lists.projects.first());
        assert_eq!(task.deleted_at, None);
        // どの行にも、この端末のデータが振った seq が付いている
        assert!(task.seq > 0);
    }

    #[test]
    fn もう1つの画面の変更は_次の差分で届く() {
        let db = Rc::new(RefCell::new(DeviceDb::open_in_memory()));
        let mut first = Screen::open(&db);
        let mut second = Screen::open(&db);

        first
            .store
            .add_task(AddTask {
                title: "1 つめの画面から".to_string(),
                memo: String::new(),
                project_id: None,
                to: Destination::Inbox,
            })
            .unwrap();
        first.settle();
        assert!(second.store.lists().inbox.is_empty());

        second.store.sync();
        second.settle();

        let lists = second.store.lists();
        assert_eq!(second.titles(&lists.inbox), vec!["1 つめの画面から"]);
    }
}
