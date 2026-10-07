//! 設定と置き場。Worker の URL、ログイン（トークンと利用者の ID）、手元の控え、画面の覚え書き（リスト｜ボード・並び方）

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 本番の Worker
pub const DEFAULT_SERVER: &str = "https://nagi.wizard1026miya.workers.dev";

pub struct Config {
    /// Worker の URL（末尾の / なし）
    pub server: String,
    /// Worker を、`--server` か NAGI_SERVER で名指ししたか
    explicit_server: bool,
    config_dir: PathBuf,
    data_dir: PathBuf,
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("."), PathBuf::from)
}

fn base_dir(variable: &str, fallback: &str) -> PathBuf {
    std::env::var_os(variable)
        .filter(|value| !value.is_empty())
        .map_or_else(|| home().join(fallback), PathBuf::from)
        .join("nagi")
}

/// ファイル名に使える形にする（URL のホストとポート）
fn slug(server: &str) -> String {
    server
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

impl Config {
    /// server は `--server`、なければ環境変数 NAGI_SERVER、なければ本番
    pub fn new(server: Option<String>) -> Config {
        let explicit =
            server.or_else(|| std::env::var("NAGI_SERVER").ok().filter(|s| !s.is_empty()));
        let explicit_server = explicit.is_some();
        let server = explicit.unwrap_or_else(|| DEFAULT_SERVER.to_string());
        let config = Config {
            server: server.trim_end_matches('/').to_string(),
            explicit_server,
            config_dir: base_dir("XDG_CONFIG_HOME", ".config"),
            data_dir: base_dir("XDG_DATA_HOME", ".local/share"),
        };
        let _ = fs::create_dir_all(&config.config_dir);
        let _ = fs::create_dir_all(&config.data_dir);
        config
    }

    /// Worker（クラウド）と同期して使うか。false なら、この端末だけで使う（ローカル。ログインなし・Worker なし）。
    /// クラウドになるのは、ログインしてあるとき（保存してあるログインか NAGI_TOKEN）と、Worker を名指ししたとき
    /// （`--server`・NAGI_SERVER。手元の開発サーバーや、自分で立てた Worker）
    pub fn is_cloud(&self) -> bool {
        self.explicit_server
            || std::env::var("NAGI_TOKEN").is_ok_and(|token| !token.is_empty())
            || self.saved_session().is_some()
    }

    /// この端末だけで使うときのデータ（Worker とは同期しない）
    pub fn device_db_path(&self) -> PathBuf {
        self.data_dir.join("local.db")
    }

    /// 手元の開発サーバーか（AUTH_DISABLED でログインなしで使える）
    pub fn is_dev_server(&self) -> bool {
        let host = self
            .server
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|local| host == *local || host.starts_with(&format!("{local}:")))
    }

    /// 手元の控え。Worker と利用者ごとに分ける（別の利用者でログインし直しても、前の利用者の行が混ざらないように）。
    /// user_id は、いまのログインの持ち主（Worker の利用者の ID）。分からないとき（利用者の ID を返さない古い Worker・
    /// まだ確かめられていない・手元の開発サーバー）は None で、Worker ごとの 1 つを使う。
    /// 利用者を分ける前からある控え（Worker ごとの 1 つ）は、持ち主の印（adopt_shared_db）があれば、その利用者のものとして使う
    pub fn db_path(&self, user_id: Option<&str>) -> PathBuf {
        let shared = self.shared_db_path();
        let Some(user_id) = user_id else {
            return shared;
        };
        if self.shared_db_owner().as_deref() == Some(user_id) {
            return shared;
        }
        self.data_dir
            .join(format!("{}--{}.db", slug(&self.server), slug(user_id)))
    }

    /// Worker ごとに 1 つの控え（利用者を分ける前の置き場）
    fn shared_db_path(&self) -> PathBuf {
        self.data_dir.join(format!("{}.db", slug(&self.server)))
    }

    /// Worker ごとに 1 つの控えが、だれのものかの印（控えの隣に置く）
    fn shared_db_owner_path(&self) -> PathBuf {
        self.data_dir
            .join(format!("{}.db.owner", slug(&self.server)))
    }

    fn shared_db_owner(&self) -> Option<String> {
        let text = fs::read_to_string(self.shared_db_owner_path()).ok()?;
        Some(text.trim().to_string()).filter(|id| !id.is_empty())
    }

    /// Worker ごとに 1 つの控えを、この利用者のものにする（ファイルは動かさず、印を付けるだけ）。
    /// 利用者を分ける前からのログインの持ち主が分かったときに呼ぶ。控えがない・もう印があるなら、何もしない
    pub fn adopt_shared_db(&self, user_id: &str) {
        if self.shared_db_path().exists() && self.shared_db_owner().is_none() {
            let _ = fs::write(self.shared_db_owner_path(), user_id);
        }
    }

    /// 利用者の控えを消す（ログアウト）。Worker ごとに 1 つの控えを使っていたなら、その印も消す
    pub fn remove_db(&self, user_id: Option<&str>) {
        let path = self.db_path(user_id);
        if path == self.shared_db_path() {
            let _ = fs::remove_file(self.shared_db_owner_path());
        }
        // SQLite の WAL のファイルも残さない
        for suffix in ["", "-wal", "-shm"] {
            let mut name = path.clone().into_os_string();
            name.push(suffix);
            let _ = fs::remove_file(name);
        }
    }

    pub fn log_path(&self) -> PathBuf {
        self.data_dir.join("nagi.log")
    }

    fn session_path(&self) -> PathBuf {
        self.config_dir
            .join(format!("session-{}.json", slug(&self.server)))
    }

    fn prefs_path(&self) -> PathBuf {
        self.config_dir.join("prefs.json")
    }

    /// ログインのトークン。環境変数 NAGI_TOKEN があればそれ（手元にログインを置けない、自動の実行のため）、
    /// なければ保存してあるもの
    pub fn load_token(&self) -> Option<String> {
        if let Some(token) = std::env::var("NAGI_TOKEN").ok().filter(|t| !t.is_empty()) {
            return Some(token);
        }
        self.saved_token()
    }

    /// 保存してあるログインのトークン（環境変数は見ない。ログアウトで消す対象）
    pub fn saved_token(&self) -> Option<String> {
        self.saved_session().map(|session| session.token)
    }

    /// 保存してあるログイン（トークンと、分かっていれば利用者の ID）
    pub fn saved_session(&self) -> Option<Session> {
        let text = fs::read_to_string(self.session_path()).ok()?;
        let session: Session = serde_json::from_str(&text).ok()?;
        Some(session).filter(|session| !session.token.is_empty())
    }

    /// ログイン（トークンと、Worker が返した利用者の ID）を、自分だけが読めるファイルに保存する
    pub fn save_session(&self, token: &str, user_id: Option<&str>) -> std::io::Result<()> {
        let session = Session {
            token: token.to_string(),
            user_id: user_id.map(str::to_string),
        };
        write_private(&self.session_path(), &serde_json::to_string(&session)?)
    }

    pub fn clear_token(&self) {
        let _ = fs::remove_file(self.session_path());
    }

    pub fn load_prefs(&self) -> Prefs {
        fs::read_to_string(self.prefs_path())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    pub fn save_prefs(&self, prefs: &Prefs) {
        if let Ok(text) = serde_json::to_string_pretty(prefs) {
            let _ = fs::write(self.prefs_path(), text);
        }
    }
}

/// 保存してあるログイン
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    /// トークンの持ち主（Worker の利用者の ID）。利用者の ID を返さないころにログインしたものには、ない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
}

#[cfg(unix)]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(text.as_bytes())
}

#[cfg(not(unix))]
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    fs::write(path, text)
}

/// 画面の覚え書き。どの画面をボードで見ていたか、画面ごとの並び方
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Prefs {
    /// ボードで見ている画面の名前（`today`・`project:<id>`）
    #[serde(default)]
    pub board: BTreeSet<String>,
    /// 画面ごとの並び方（`today`・`later`・`project:<id>` → 並び方の名前。手動は入れない）
    #[serde(default)]
    pub sort: BTreeMap<String, String>,
    /// サイドバーを畳んでいるか（印だけの細い帯）
    #[serde(default)]
    pub sidebar_rail: bool,
}

#[cfg(test)]
impl Config {
    /// テスト用：置き場を指定して作る（環境変数を見ない）
    pub fn at(server: &str, dir: &Path) -> Config {
        let config = Config {
            server: server.to_string(),
            explicit_server: false,
            config_dir: dir.join("config"),
            data_dir: dir.join("data"),
        };
        fs::create_dir_all(&config.config_dir).unwrap();
        fs::create_dir_all(&config.data_dir).unwrap();
        config
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://nagi.example.com";

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nagi-config-test-{}-{name}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_name(path: &Path) -> String {
        path.file_name().unwrap().to_string_lossy().into_owned()
    }

    #[test]
    fn 控えは利用者ごとに分かれ_分からないときはworkerごとの1つ() {
        let config = Config::at(SERVER, &temp_dir("paths"));
        assert_eq!(file_name(&config.db_path(None)), "nagi.example.com.db");
        assert_eq!(
            file_name(&config.db_path(Some("owner"))),
            "nagi.example.com--owner.db"
        );
        let uuid = "0199c1a0-7d4e-7b1a-9d2e-3f4a5b6c7d8e";
        assert_eq!(
            file_name(&config.db_path(Some(uuid))),
            format!("nagi.example.com--{uuid}.db")
        );
        assert_ne!(config.db_path(Some("a")), config.db_path(Some("b")));
        // ファイル名に使えない文字は置き換える（置き場の外へ出ない）
        assert_eq!(
            file_name(&config.db_path(Some("../x/y"))),
            "nagi.example.com--.._x_y.db"
        );
        assert_eq!(
            config.db_path(Some("../x/y")).parent(),
            config.db_path(None).parent()
        );
    }

    #[test]
    fn 利用者を分ける前の控えは_印を付けた利用者のものとして使う() {
        let config = Config::at(SERVER, &temp_dir("adopt"));
        let shared = config.db_path(None);

        // 控えがなければ、印は付かない
        config.adopt_shared_db("owner");
        assert_ne!(config.db_path(Some("owner")), shared);

        fs::write(&shared, b"db").unwrap();
        config.adopt_shared_db("owner");
        assert_eq!(config.db_path(Some("owner")), shared);
        // ほかの利用者は、自分の控えを使う。印は、あとから付け替わらない
        assert_ne!(config.db_path(Some("other")), shared);
        config.adopt_shared_db("other");
        assert_eq!(config.db_path(Some("owner")), shared);
        assert_ne!(config.db_path(Some("other")), shared);
    }

    #[test]
    fn 控えを消すと_walのファイルと印も消える_ほかの利用者の控えは残る() {
        let config = Config::at(SERVER, &temp_dir("remove"));
        let shared = config.db_path(None);
        let other = config.db_path(Some("other"));
        let with = |path: &Path, suffix: &str| {
            let mut name = path.to_path_buf().into_os_string();
            name.push(suffix);
            PathBuf::from(name)
        };
        for path in [&shared, &other] {
            for suffix in ["", "-wal", "-shm"] {
                fs::write(with(path, suffix), b"x").unwrap();
            }
        }
        config.adopt_shared_db("owner");

        config.remove_db(Some("owner"));

        for suffix in ["", "-wal", "-shm"] {
            assert!(!with(&shared, suffix).exists());
            assert!(with(&other, suffix).exists());
        }
        // 印も消えたので、次に同じ場所にできる控えは、だれのものでもない
        fs::write(&shared, b"db").unwrap();
        assert_ne!(config.db_path(Some("owner")), shared);

        config.remove_db(Some("other"));
        assert!(!other.exists());
        assert!(shared.exists());
    }

    #[test]
    fn ログインは_トークンと利用者のidを保存する_古い形のファイルも読める() {
        let config = Config::at(SERVER, &temp_dir("session"));
        assert_eq!(config.saved_session(), None);

        config.save_session("token-1", Some("user-1")).unwrap();
        assert_eq!(
            config.saved_session(),
            Some(Session {
                token: "token-1".to_string(),
                user_id: Some("user-1".to_string()),
            })
        );
        assert_eq!(config.saved_token().as_deref(), Some("token-1"));

        // 利用者の ID を返さないころのファイル（token だけ）
        fs::write(config.session_path(), r#"{"token":"old-token"}"#).unwrap();
        assert_eq!(
            config.saved_session(),
            Some(Session {
                token: "old-token".to_string(),
                user_id: None,
            })
        );
        // ID が分からないログインは、ID の項目を書かない（古い版の nagi も読める形のまま）
        config.save_session("token-2", None).unwrap();
        assert_eq!(
            fs::read_to_string(config.session_path()).unwrap(),
            r#"{"token":"token-2"}"#
        );

        config.clear_token();
        assert_eq!(config.saved_session(), None);
    }
}
