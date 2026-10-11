//! 手元の控え（SQLite）。保存するのは確定データ（タスクとプロジェクト）とカーソル、そして版のずれで
//! 送れないまま持っておく操作のまとまり（pending）。同時に開いたほかの nagi と共有するので、行は seq が
//! 新しいときだけ上書きする（古い側が新しい行を巻き戻さないように）。
//! pending は持ち主（ログイン）ごとに書き、同じ持ち主のときだけ読み戻す

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

use super::replica::PendingBatch;
use crate::model::SyncRow;

/// 保存形式の版。形を変えたら上げる。版が変わると、開いたときに手元のデータ（rows と meta）を捨てて作り直し、
/// カーソル 0 から取り直す。pending は取り直せない利用者の変更なので、ここでは消さない
const FORMAT_VERSION: i64 = 1;

pub struct Snapshot {
    pub rows: Vec<SyncRow>,
    pub cursor: u64,
}

/// 送っていないまとまりの持ち主。読み戻すのは、利用者の ID が両方分かっていて同じときか、トークンが同じとき
/// （利用者の ID が分からないまま書いたまとまりを、別のトークンで送らないように）
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PendingOwner {
    user_id: Option<String>,
    token_key: Option<String>,
}

impl PendingOwner {
    pub fn new(user_id: Option<&str>, token: Option<&str>) -> PendingOwner {
        PendingOwner {
            user_id: user_id.map(str::to_string),
            token_key: token.map(token_key),
        }
    }
}

/// トークンそのものは控えに書かず、見分けるための値（FNV-1a 64 ビット）だけを書く
fn token_key(token: &str) -> String {
    let hash = token.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// 持ち主のまとまりを、書いた順に読んだ結果
#[derive(Debug, Default, PartialEq)]
pub struct PendingLoad {
    /// 最初の読めないまとまりより前のもの
    pub batches: Vec<PendingBatch>,
    /// 読めないまとまりがあった（それと後ろは表に残し、読まない）
    pub unreadable: bool,
}

pub struct LocalDb {
    conn: Connection,
}

fn kind_of(row: &SyncRow) -> (&'static str, &str, u64, Option<&str>) {
    match row {
        SyncRow::Task(task) => ("task", &task.id, task.seq, task.deleted_at.as_deref()),
        SyncRow::Project(project) => (
            "project",
            &project.id,
            project.seq,
            project.deleted_at.as_deref(),
        ),
    }
}

fn to_sql_error(error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(error))
}

impl LocalDb {
    pub fn open(path: &Path) -> rusqlite::Result<LocalDb> {
        Self::prepare(Connection::open(path)?)
    }

    #[cfg(test)]
    pub fn open_in_memory() -> rusqlite::Result<LocalDb> {
        Self::prepare(Connection::open_in_memory()?)
    }

    fn prepare(conn: Connection) -> rusqlite::Result<LocalDb> {
        conn.busy_timeout(Duration::from_secs(5))?;
        let _: String = conn.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != FORMAT_VERSION {
            conn.execute_batch(
                "DROP TABLE IF EXISTS rows;
                 DROP TABLE IF EXISTS meta;
                 CREATE TABLE rows (
                   kind TEXT NOT NULL,
                   id TEXT NOT NULL,
                   seq INTEGER NOT NULL,
                   deleted_at TEXT,
                   json TEXT NOT NULL,
                   PRIMARY KEY (kind, id)
                 );
                 CREATE INDEX rows_deleted_at ON rows (deleted_at) WHERE deleted_at IS NOT NULL;
                 CREATE TABLE meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);",
            )?;
            conn.pragma_update(None, "user_version", FORMAT_VERSION)?;
        }
        // 版の確かめとは別に作る（足しても FORMAT_VERSION は上げないので、控えは取り直しにならない）
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pending (
               position INTEGER PRIMARY KEY AUTOINCREMENT,
               id TEXT NOT NULL UNIQUE,
               owner_user TEXT,
               owner_token TEXT,
               json TEXT NOT NULL
             );",
        )?;
        Ok(LocalDb { conn })
    }

    /// 保存してある確定データとカーソルを、同じ時点の中身として読む
    pub fn load(&self) -> rusqlite::Result<Snapshot> {
        let tx = self.conn.unchecked_transaction()?;
        let rows = {
            let mut statement = tx.prepare("SELECT json FROM rows")?;
            let mut rows = Vec::new();
            for json in statement.query_map([], |row| row.get::<_, String>(0))? {
                // 読めない行は飛ばす（次の全件の取り直しで入れ替わる）
                if let Ok(row) = serde_json::from_str::<SyncRow>(&json?) {
                    rows.push(row);
                }
            }
            rows
        };
        let cursor = Self::cursor(&tx)?;
        Ok(Snapshot { rows, cursor })
    }

    fn cursor(conn: &Connection) -> rusqlite::Result<u64> {
        let saved: Option<i64> = conn
            .query_row("SELECT value FROM meta WHERE key = 'cursor'", [], |row| {
                row.get(0)
            })
            .optional()?;
        Ok(saved.unwrap_or(0).max(0) as u64)
    }

    fn put(conn: &Connection, row: &SyncRow, only_if_newer: bool) -> rusqlite::Result<()> {
        let (kind, id, seq, deleted_at) = kind_of(row);
        let json = serde_json::to_string(row).map_err(to_sql_error)?;
        let sql = if only_if_newer {
            "INSERT INTO rows (kind, id, seq, deleted_at, json) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (kind, id) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at,
               json = excluded.json WHERE excluded.seq > rows.seq"
        } else {
            "INSERT OR REPLACE INTO rows (kind, id, seq, deleted_at, json) VALUES (?1, ?2, ?3, ?4, ?5)"
        };
        conn.execute(sql, params![kind, id, seq as i64, deleted_at, json])?;
        Ok(())
    }

    /// 行を書く。手元より seq が新しい行だけを上書きする。
    /// advance（from, to）を渡したら、行と同じトランザクションでカーソルを進める。
    /// 保存済みのカーソルが from 以上のときだけ（控えに from までの欠けがないときだけ）、to まで進める
    pub fn put_rows(&self, rows: &[SyncRow], advance: Option<(u64, u64)>) -> rusqlite::Result<()> {
        if rows.is_empty() && advance.is_none() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for row in rows {
            Self::put(&tx, row, true)?;
        }
        if let Some((from, to)) = advance {
            let saved = Self::cursor(&tx)?;
            if saved >= from && to > saved {
                Self::set_cursor(&tx, to)?;
            }
        }
        tx.commit()
    }

    fn set_cursor(conn: &Connection, cursor: u64) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?1)",
            params![cursor as i64],
        )?;
        Ok(())
    }

    /// 手元を捨てて、rows と cursor に置き換える（カーソル 0 から全件を取ったとき）
    pub fn replace_all(&self, rows: &[SyncRow], cursor: u64) -> rusqlite::Result<()> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM rows", [])?;
        for row in rows {
            Self::put(&tx, row, false)?;
        }
        Self::set_cursor(&tx, cursor)?;
        tx.commit()
    }

    /// deleted_before（ISO 8601）より前に削除された行を捨てる
    pub fn purge_deleted(&self, deleted_before: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "DELETE FROM rows WHERE deleted_at IS NOT NULL AND deleted_at < ?1",
            params![deleted_before],
        )?;
        Ok(())
    }

    /// 送れないまとまりを、持ち主を添えて列の後ろに書く。書いてあるまとまり（同じ id）には触れない。
    /// まとまりの中身は id ごとに変わらないので、同時に開いたほかの nagi の写しで、位置や持ち主を書き換えない
    pub fn save_pending(
        &self,
        owner: &PendingOwner,
        batches: &[PendingBatch],
    ) -> rusqlite::Result<()> {
        if batches.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for batch in batches {
            let json = serde_json::to_string(batch).map_err(to_sql_error)?;
            tx.execute(
                "INSERT INTO pending (id, owner_user, owner_token, json) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO NOTHING",
                params![batch.id, owner.user_id, owner.token_key, json],
            )?;
        }
        tx.commit()
    }

    /// owner のまとまりを、書いた順に読む。読めないまとまりで止め、それと後ろは表に残す
    /// （前のまとまりを飛ばして後ろを送ると、順と前提が崩れる。読める nagi で送る）
    pub fn load_pending(&self, owner: &PendingOwner) -> rusqlite::Result<PendingLoad> {
        let mut statement = self.conn.prepare(
            "SELECT json FROM pending
             WHERE (owner_user IS NOT NULL AND owner_user = ?1) OR owner_token IS ?2
             ORDER BY position",
        )?;
        let mut load = PendingLoad::default();
        for json in statement.query_map(params![owner.user_id, owner.token_key], |row| {
            row.get::<_, String>(0)
        })? {
            match serde_json::from_str::<PendingBatch>(&json?) {
                Ok(batch) => load.batches.push(batch),
                Err(_) => {
                    load.unreadable = true;
                    break;
                }
            }
        }
        Ok(load)
    }

    /// 確定した・捨てたまとまりを消す
    pub fn remove_pending(&self, ids: &[&str]) -> rusqlite::Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for id in ids {
            tx.execute("DELETE FROM pending WHERE id = ?1", params![id])?;
        }
        tx.commit()
    }

    /// from の控え（Worker ごとの 1 つ）に owner と同じトークンで残したまとまりを、書いた順のまま、この控えの列の
    /// 後ろへ移す。持ち主を聞けなかった起動で残したもので、持ち主が分かった起動では、この控えから読むため。
    /// こちらに書いてから from から消す（あいだで止まっても失わない。もう一度移しても、同じ id は 1 つのまま）
    pub fn take_pending_from(&self, from: &Path, owner: &PendingOwner) -> rusqlite::Result<()> {
        let Some(token_key) = &owner.token_key else {
            return Ok(());
        };
        if !from.exists() {
            return Ok(());
        }
        let mut source = Connection::open(from)?;
        source.busy_timeout(Duration::from_secs(5))?;
        if !has_pending_table(&source)? {
            return Ok(());
        }
        let rows = source
            .prepare(
                "SELECT id, owner_user, json FROM pending WHERE owner_token = ?1 ORDER BY position",
            )?
            .query_map(params![token_key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if rows.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        for (id, owner_user, json) in &rows {
            tx.execute(
                "INSERT INTO pending (id, owner_user, owner_token, json) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (id) DO NOTHING",
                params![
                    id,
                    owner_user.as_deref().or(owner.user_id.as_deref()),
                    token_key,
                    json
                ],
            )?;
        }
        tx.commit()?;
        let tx = source.transaction()?;
        for (id, ..) in &rows {
            tx.execute("DELETE FROM pending WHERE id = ?1", params![id])?;
        }
        tx.commit()
    }

    /// 書き込みを断るようにする（保存に失敗したときのテスト）
    #[cfg(test)]
    pub fn set_read_only(&self, read_only: bool) {
        self.conn
            .pragma_update(None, "query_only", read_only)
            .unwrap();
    }
}

/// path の控えの pending の表にある、送っていないまとまりの数（持ち主を問わない。ログアウトで控えごと消えるもの）。
/// 控えがなければ 0。ログアウトの前に、画面と CLI の両方がこれで確かめる
pub fn unsent_count_at(path: &Path) -> rusqlite::Result<usize> {
    if !path.exists() {
        return Ok(0);
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    if !has_pending_table(&conn)? {
        return Ok(0);
    }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0))?;
    Ok(count as usize)
}

fn has_pending_table(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pending')",
        [],
        |row| row.get(0),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::replica::OperationKind;
    use crate::model::{Bucket, Mutation, NewTask, Project, ProjectChanges, TaskChanges};

    fn project(id: &str, seq: u64, name: &str, deleted_at: Option<&str>) -> SyncRow {
        SyncRow::Project(Project {
            id: id.into(),
            name: name.into(),
            color: None,
            archived_at: None,
            created_at: "2026-10-01T00:00:00.000Z".into(),
            updated_at: "2026-10-01T00:00:00.000Z".into(),
            deleted_at: deleted_at.map(str::to_string),
            seq,
        })
    }

    fn batch(id: &str, mutations: Vec<Mutation>) -> PendingBatch {
        PendingBatch {
            id: id.into(),
            mutations,
            at: "2026-10-06T03:00:00.000Z".into(),
            kind: OperationKind::TaskUpdate,
        }
    }

    fn pending_batches() -> Vec<PendingBatch> {
        vec![
            batch(
                "b1",
                vec![Mutation::TaskCreate {
                    task: NewTask {
                        id: "t1".into(),
                        title: "追加".into(),
                        memo: String::new(),
                        bucket: Bucket::Inbox,
                        scheduled_on: None,
                        project_id: None,
                        rank: "a0".into(),
                    },
                }],
            ),
            // null にする項目（Some(None)）と、送らない項目（None）が、読み戻しても入れ替わらない
            batch(
                "b2",
                vec![Mutation::update_task(
                    "t1",
                    TaskChanges {
                        memo: Some("メモ".into()),
                        scheduled_on: Some(None),
                        ..Default::default()
                    },
                )],
            ),
            batch(
                "b3",
                vec![Mutation::ProjectUpdate {
                    id: "p1".into(),
                    changes: ProjectChanges {
                        color: Some(None),
                        ..Default::default()
                    },
                }],
            ),
        ]
    }

    fn owner(user_id: Option<&str>, token: &str) -> PendingOwner {
        PendingOwner::new(user_id, Some(token))
    }

    fn loaded(db: &LocalDb, owner: &PendingOwner) -> Vec<PendingBatch> {
        db.load_pending(owner).unwrap().batches
    }

    fn row_count(db: &LocalDb) -> i64 {
        db.conn
            .query_row("SELECT COUNT(*) FROM pending", [], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn 送れないまとまりは書いた順に読め_確定したまとまりだけが消える() {
        let db = LocalDb::open_in_memory().unwrap();
        let me = owner(Some("u1"), "t");
        let batches = pending_batches();
        db.save_pending(&me, &batches[..2]).unwrap();
        // 書いてあるまとまりを書き直しても、位置は変わらず、二重にもならない
        db.save_pending(&me, &batches).unwrap();
        assert_eq!(loaded(&db, &me), batches);

        db.remove_pending(&["b1"]).unwrap();
        assert_eq!(loaded(&db, &me), batches[1..].to_vec());
        assert_eq!(row_count(&db), 2);
    }

    #[test]
    fn 送れないまとまりは_同じ利用者か同じトークンのときだけ読み戻す() {
        let db = LocalDb::open_in_memory().unwrap();
        let batches = pending_batches();
        // 利用者の ID が分からないまま（NAGI_TOKEN の確かめが通らなかった）、A のトークンで書いた
        db.save_pending(&owner(None, "token-a"), &batches[..1])
            .unwrap();
        db.save_pending(&owner(Some("u1"), "token-b"), &batches[1..])
            .unwrap();

        // 別のトークンで、利用者の ID も分からないときは、どちらも読まない
        assert!(loaded(&db, &owner(None, "token-c")).is_empty());
        // 利用者の ID が分からなくても、同じトークンなら読む
        assert_eq!(loaded(&db, &owner(None, "token-a")), batches[..1].to_vec());
        // ログインし直して（トークンは別）、同じ利用者だと分かれば読む
        assert_eq!(
            loaded(&db, &owner(Some("u1"), "token-new")),
            batches[1..].to_vec()
        );
        assert!(loaded(&db, &owner(Some("u2"), "token-new")).is_empty());
        // ログインなし（手元の開発サーバー）は、ログインなしで書いたものだけ
        assert!(loaded(&db, &PendingOwner::default()).is_empty());
        assert_eq!(row_count(&db), 3);
    }

    #[test]
    fn 読めないまとまりがあれば_そこで止め_後ろも表に残す() {
        let db = LocalDb::open_in_memory().unwrap();
        let me = owner(None, "t");
        let batches = pending_batches();
        db.save_pending(&me, &batches).unwrap();
        db.conn
            .execute(
                "UPDATE pending SET json = '{\"id\":\"b2\",\"kind\":\"FromNewerNagi\"}' WHERE id = 'b2'",
                [],
            )
            .unwrap();

        let load = db.load_pending(&me).unwrap();
        assert_eq!(load.batches, batches[..1].to_vec());
        assert!(load.unreadable);
        assert_eq!(row_count(&db), 3);
    }

    #[test]
    fn 保存形式の版が変わって控えを作り直しても_送れないまとまりは残る() {
        let path = std::env::temp_dir().join(format!(
            "nagi-local-db-test-{}-{}.db",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        assert_eq!(unsent_count_at(&path).unwrap(), 0);
        let me = PendingOwner::default();
        let batches = pending_batches();
        {
            let db = LocalDb::open(&path).unwrap();
            db.put_rows(&[project("p1", 5, "消える", None)], Some((0, 5)))
                .unwrap();
            db.save_pending(&me, &batches).unwrap();
            db.conn.pragma_update(None, "user_version", 0).unwrap();
        }
        let db = LocalDb::open(&path).unwrap();
        let snapshot = db.load().unwrap();
        assert!(snapshot.rows.is_empty());
        assert_eq!(snapshot.cursor, 0);
        assert_eq!(loaded(&db, &me), batches);
        assert_eq!(unsent_count_at(&path).unwrap(), 3);
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn 行は_seq_が新しいときだけ上書きし_カーソルは欠けがないときだけ進める() {
        let db = LocalDb::open_in_memory().unwrap();
        db.put_rows(&[project("p1", 5, "新しい", None)], Some((0, 5)))
            .unwrap();
        db.put_rows(&[project("p1", 3, "古い", None)], None)
            .unwrap();
        let snapshot = db.load().unwrap();
        assert_eq!(snapshot.cursor, 5);
        assert_eq!(snapshot.rows, vec![project("p1", 5, "新しい", None)]);
        // 控えのカーソル（5）より先から進めようとしても進めない
        db.put_rows(&[], Some((8, 9))).unwrap();
        assert_eq!(db.load().unwrap().cursor, 5);
        db.put_rows(&[], Some((5, 9))).unwrap();
        assert_eq!(db.load().unwrap().cursor, 9);
    }

    #[test]
    fn 置き換えと_古い削除済みの片付け() {
        let db = LocalDb::open_in_memory().unwrap();
        db.put_rows(&[project("p1", 5, "消える", None)], Some((0, 5)))
            .unwrap();
        db.replace_all(
            &[
                project("p2", 2, "残る", Some("2026-10-05T00:00:00.000Z")),
                project("p3", 3, "古い削除", Some("2026-08-01T00:00:00.000Z")),
            ],
            3,
        )
        .unwrap();
        db.purge_deleted("2026-09-06T00:00:00.000Z").unwrap();
        let snapshot = db.load().unwrap();
        assert_eq!(snapshot.cursor, 3);
        assert_eq!(snapshot.rows.len(), 1);
        assert_eq!(snapshot.rows[0].seq(), 2);
    }
}
