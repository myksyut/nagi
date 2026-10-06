//! 手元の控え（SQLite）。保存するのは確定データ（タスクとプロジェクト）とカーソルだけで、
//! 送信中の操作は保存しない。同時に開いたほかの nagi と共有するので、行は seq が新しいときだけ上書きする
//! （古い側が新しい行を巻き戻さないように）

use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OptionalExtension, params};

use crate::model::SyncRow;

/// 保存形式の版。形を変えたら上げる。版が変わると、開いたときに手元のデータを捨てて作り直し、
/// カーソル 0 から取り直す
const FORMAT_VERSION: i64 = 1;

pub struct Snapshot {
    pub rows: Vec<SyncRow>,
    pub cursor: u64,
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Project;

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
