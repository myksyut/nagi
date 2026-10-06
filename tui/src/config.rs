//! 設定と置き場。Worker の URL、ログインのトークン、手元の控え、画面の覚え書き（リスト｜ボード・並び方）

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 本番の Worker
pub const DEFAULT_SERVER: &str = "https://nagi.wizard1026miya.workers.dev";

pub struct Config {
    /// Worker の URL（末尾の / なし）
    pub server: String,
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
        let server = server
            .or_else(|| std::env::var("NAGI_SERVER").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| DEFAULT_SERVER.to_string());
        let config = Config {
            server: server.trim_end_matches('/').to_string(),
            config_dir: base_dir("XDG_CONFIG_HOME", ".config"),
            data_dir: base_dir("XDG_DATA_HOME", ".local/share"),
        };
        let _ = fs::create_dir_all(&config.config_dir);
        let _ = fs::create_dir_all(&config.data_dir);
        config
    }

    /// 手元の開発サーバーか（AUTH_DISABLED でログインなしで使える）
    pub fn is_local(&self) -> bool {
        let host = self
            .server
            .trim_start_matches("https://")
            .trim_start_matches("http://");
        ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|local| host == *local || host.starts_with(&format!("{local}:")))
    }

    /// 手元の控え（Worker ごとに分ける）
    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join(format!("{}.db", slug(&self.server)))
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
        let text = fs::read_to_string(self.session_path()).ok()?;
        let session: Session = serde_json::from_str(&text).ok()?;
        Some(session.token).filter(|token| !token.is_empty())
    }

    /// ログインのトークンを、自分だけが読めるファイルに保存する
    pub fn save_token(&self, token: &str) -> std::io::Result<()> {
        let session = Session {
            token: token.to_string(),
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

#[derive(Serialize, Deserialize)]
struct Session {
    token: String,
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
