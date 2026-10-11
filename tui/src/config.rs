//! 設定と置き場。Worker の URL、ログイン（トークンと利用者の ID）、手元の控え、画面の覚え書き（リスト｜ボード・並び方）

use crate::i18n::{Msg, fill};
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 本番の Worker（独自ドメイン）
pub const DEFAULT_SERVER: &str = "https://api.usenagi.dev";

/// 独自ドメインに移る前の本番の Worker。いまも動いていて、更新していない nagi がここを見る
const LEGACY_DEFAULT_SERVER: &str = "https://nagi.wizard1026miya.workers.dev";

const PREFS_FILE: &str = "prefs.json";

pub struct Config {
    /// Worker の URL（末尾の / なし）
    pub server: String,
    /// Worker を、`--server` か NAGI_SERVER で名指ししたか
    explicit_server: bool,
    config_dir: PathBuf,
    data_dir: PathBuf,
}

/// 設定とデータの置き場（どちらも `nagi` のフォルダ）
#[derive(Debug, PartialEq, Eq)]
pub struct Dirs {
    pub config: PathBuf,
    pub data: PathBuf,
}

/// 置き場を決める。環境変数は引数で引く（テストと、あとから足す OS ごとの決め方のため）。
/// XDG_CONFIG_HOME・XDG_DATA_HOME が空でなければそれを使い、なければ HOME から決める。
/// HOME もなければ、今いるフォルダに書かず、断る
pub fn resolve_dirs(env: impl Fn(&str) -> Option<OsString>) -> Result<Dirs, String> {
    let non_empty = |name: &str| env(name).filter(|value| !value.is_empty());
    let base = |variable: &str, fallback: &str| -> Result<PathBuf, String> {
        let root = match non_empty(variable) {
            Some(dir) => PathBuf::from(dir),
            None => non_empty("HOME")
                .map(|home| PathBuf::from(home).join(fallback))
                .ok_or_else(|| fill(Msg::ConfigHomeMissing, &[&variable]))?,
        };
        Ok(root.join("nagi"))
    };
    Ok(Dirs {
        config: base("XDG_CONFIG_HOME", ".config")?,
        data: base("XDG_DATA_HOME", ".local/share")?,
    })
}

#[cfg(unix)]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent)?;
    }
    match fs::DirBuilder::new().mode(0o700).create(dir) {
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && dir.is_dir() => Ok(()),
        result => result,
    }
}

#[cfg(not(unix))]
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dir)
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
    pub fn new(server: Option<String>) -> Result<Config, String> {
        let explicit =
            server.or_else(|| std::env::var("NAGI_SERVER").ok().filter(|s| !s.is_empty()));
        let explicit_server = explicit.is_some();
        let server = explicit.unwrap_or_else(|| DEFAULT_SERVER.to_string());
        let dirs = resolve_dirs(|name| std::env::var_os(name))?;
        Ok(Config {
            server: server.trim_end_matches('/').to_string(),
            explicit_server,
            config_dir: dirs.config,
            data_dir: dirs.data,
        })
    }

    /// 置き場のフォルダを作る（unix では 0700。自分だけが入れる）。作る必要があるコマンドだけが呼ぶ
    /// （`--help` や、まだデータがないときの `nagi export` は、何も作らない）。
    /// 作れなかったとき、ローカルは置き場がなければ動けないので Err。クラウドは手元の控えなしで動けるので、
    /// 理由を Ok(Some(..)) で返し、続けさせる
    pub fn prepare_dirs(&self) -> Result<Option<String>, String> {
        let created = [&self.config_dir, &self.data_dir]
            .into_iter()
            .try_for_each(|dir| {
                create_private_dir(dir)
                    .map_err(|error| fill(Msg::ConfigCreateDirFailed, &[&dir.display(), &error]))
            });
        match created {
            Ok(()) => Ok(None),
            Err(reason) if self.is_cloud() => Ok(Some(reason)),
            Err(reason) => Err(reason),
        }
    }

    /// 独自ドメインに移る前の置き場（`slug(LEGACY_DEFAULT_SERVER)`）のセッションと控えと、
    /// 覚え書きの「聞いた印」（`import_offered`）の接続先を、新しい名前に移す。
    /// 移すのは、接続先を名指ししていないときで、同じ種類の新しいファイルがないときだけ。
    /// 写さず `fs::rename` で動かすのは、ログアウトで新しい方を消したあとに、古い方から黙ってログインし直さないため
    /// （開いたままの古い nagi はトークンをメモリに持つので、名前が変わっても動き続ける）
    pub fn migrate_legacy_files(&self) {
        if self.explicit_server {
            return;
        }
        let old = slug(LEGACY_DEFAULT_SERVER);
        let new = slug(DEFAULT_SERVER);
        let rename = |from: &Path, to: &Path| -> bool {
            if !from.exists() || to.exists() {
                return false;
            }
            match fs::rename(from, to) {
                Ok(()) => true,
                Err(error) => {
                    crate::log::error(&fill(
                        Msg::ConfigMoveToFailed,
                        &[&from.display(), &to.display(), &error],
                    ));
                    false
                }
            }
        };
        rename(
            &self.config_dir.join(format!("session-{old}.json")),
            &self.session_path(),
        );
        if self.migrate_db(
            &self.data_dir.join(format!("{old}.db")),
            &self.shared_db_path(),
        ) {
            rename(
                &self.data_dir.join(format!("{old}.db.owner")),
                &self.shared_db_owner_path(),
            );
        }
        self.migrate_import_offered();
        let Ok(entries) = fs::read_dir(&self.data_dir) else {
            return;
        };
        let per_user_prefix = format!("{old}--");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(user) = name
                .strip_prefix(&per_user_prefix)
                .and_then(|rest| rest.strip_suffix(".db"))
            {
                self.migrate_db(
                    &entry.path(),
                    &self.data_dir.join(format!("{new}--{user}.db")),
                );
            }
        }
    }

    /// 聞いた印は接続先ごとなので、古い接続先の印を新しい接続先の印に書き換える
    /// （移したあとの控えで、「この端末のデータをクラウドへ移しますか」を聞き直さない）
    fn migrate_import_offered(&self) {
        let old = format!("{LEGACY_DEFAULT_SERVER}|");
        let mut prefs = self.load_prefs();
        if !prefs.import_offered.iter().any(|key| key.starts_with(&old)) {
            return;
        }
        prefs.import_offered = prefs
            .import_offered
            .into_iter()
            .map(|key| match key.strip_prefix(&old) {
                Some(user) => format!("{DEFAULT_SERVER}|{user}"),
                None => key,
            })
            .collect();
        self.save_prefs(&prefs);
    }

    /// 控えの `.db` を、`-wal` と `-shm` も一緒に移す。移す前に WAL を本体に畳む。
    /// 移せないときは、移さずに記録に残す（控えはカーソル 0 から取り直せるので、データは失われない）
    fn migrate_db(&self, from: &Path, to: &Path) -> bool {
        if !from.exists() || to.exists() {
            return false;
        }
        let checkpoint = rusqlite::Connection::open_with_flags(
            from,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE,
        )
        .and_then(|db| db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)"));
        if let Err(error) = checkpoint {
            crate::log::error(&fill(
                Msg::ConfigCheckpointFailed,
                &[&from.display(), &error],
            ));
            return false;
        }
        if let Err(error) = fs::rename(from, to) {
            crate::log::error(&fill(Msg::ConfigMoveFailed, &[&from.display(), &error]));
            return false;
        }
        // 本体に畳んだあとの -wal は空。残っていれば、本体と一緒に動かす
        for suffix in ["-wal", "-shm"] {
            let (mut source, mut target) = (from.as_os_str().to_owned(), to.as_os_str().to_owned());
            source.push(suffix);
            target.push(suffix);
            let _ = fs::rename(source, target);
        }
        true
    }

    /// Worker（クラウド）と同期して使うか。false なら、この端末だけで使う（ローカル。ログインなし・Worker なし）。
    /// クラウドになるのは、ログインしてあるとき（保存してあるログインか NAGI_TOKEN）と、Worker を名指ししたとき
    /// （`--server`・NAGI_SERVER。手元の開発サーバーや、自分で立てた Worker）
    pub fn is_cloud(&self) -> bool {
        self.explicit_server || Self::has_env_token() || self.saved_session().is_some()
    }

    /// 環境変数 NAGI_TOKEN（自動の実行のログイン）があるか
    pub fn has_env_token() -> bool {
        std::env::var("NAGI_TOKEN").is_ok_and(|token| !token.is_empty())
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

    /// `nagi --help` の最後に出す、データ・ログイン・記録の置き場
    pub fn locations(&self) -> String {
        fill(
            Msg::ConfigLocations,
            &[
                &self.device_db_path().display(),
                &self.session_path().display(),
                &self.log_path().display(),
            ],
        )
    }

    fn session_path(&self) -> PathBuf {
        self.config_dir
            .join(format!("session-{}.json", slug(&self.server)))
    }

    fn prefs_path(&self) -> PathBuf {
        self.config_dir.join(PREFS_FILE)
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

    /// ログイン（トークンと、Worker が返した利用者の ID）を、自分だけが読めるファイルに保存する。
    /// 同じトークンの上書き（利用者の ID の書き足し）では、Worker に伝えてあるタイムゾーンを残す。
    /// 新しいトークンは未送信として始め、起動のときに端末のタイムゾーンを送る（App::report_time_zone）
    pub fn save_session(&self, token: &str, user_id: Option<&str>) -> std::io::Result<()> {
        let time_zone = self
            .saved_session()
            .filter(|saved| saved.token == token)
            .and_then(|saved| saved.time_zone);
        self.write_session(&Session {
            token: token.to_string(),
            user_id: user_id.map(str::to_string),
            time_zone,
        })
    }

    /// Worker に伝えたタイムゾーンを、保存してあるログインに書く（トークンが同じときだけ）
    pub fn save_time_zone(&self, token: &str, time_zone: &str) -> std::io::Result<()> {
        match self.saved_session() {
            Some(mut session) if session.token == token => {
                session.time_zone = Some(time_zone.to_string());
                self.write_session(&session)
            }
            _ => Ok(()),
        }
    }

    fn write_session(&self, session: &Session) -> std::io::Result<()> {
        write_private(&self.session_path(), &serde_json::to_string(session)?)
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
            let _ = write_private(&self.prefs_path(), &text);
        }
    }

    /// `Prefs::import_offered` に入れる、この Worker とこの利用者の印
    pub fn import_offer_key(&self, user_id: Option<&str>) -> String {
        format!("{}|{}", self.server, user_id.unwrap_or_default())
    }
}

/// 保存してあるログイン
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Session {
    pub token: String,
    /// トークンの持ち主（Worker の利用者の ID）。利用者の ID を返さないころにログインしたものには、ない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    /// Worker に伝えた、この端末のタイムゾーン（IANA の名前）。古いログインには、ない
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_zone: Option<String>,
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
    /// 画面の言語（`ja`）。`--lang` の次、環境変数より前に見る
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lang: Option<String>,
    /// 「この端末のデータをクラウドへ移しますか」を聞いた印（`import_offer_key`）。聞いたら、答えにかかわらず二度と聞かない
    #[serde(default)]
    pub import_offered: BTreeSet<String>,
}

/// 覚え書きの言語。言語は引数を読む前に決めるので、置き場が決まらなくても、読めなくても、ないものとして扱う
pub fn saved_lang(env: impl Fn(&str) -> Option<OsString>) -> Option<String> {
    let dirs = resolve_dirs(env).ok()?;
    let text = fs::read_to_string(dirs.config.join(PREFS_FILE)).ok()?;
    serde_json::from_str::<Prefs>(&text).ok()?.lang
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
                time_zone: None,
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
                time_zone: None,
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

    #[test]
    fn タイムゾーンを保存できる_同じトークンの上書きでは残り_新しいトークンでは消える() {
        let config = Config::at(SERVER, &temp_dir("session-zone"));
        config.save_session("token-1", None).unwrap();
        config.save_time_zone("token-1", "Europe/Berlin").unwrap();
        assert_eq!(
            fs::read_to_string(config.session_path()).unwrap(),
            r#"{"token":"token-1","time_zone":"Europe/Berlin"}"#
        );

        config.save_session("token-1", Some("user-1")).unwrap();
        let saved = config.saved_session().unwrap();
        assert_eq!(saved.user_id.as_deref(), Some("user-1"));
        assert_eq!(saved.time_zone.as_deref(), Some("Europe/Berlin"));

        // 別のトークンの控えには書かない
        config.save_time_zone("other-token", "Asia/Tokyo").unwrap();
        assert_eq!(
            config.saved_session().unwrap().time_zone.as_deref(),
            Some("Europe/Berlin")
        );

        config.save_session("token-2", Some("user-1")).unwrap();
        assert_eq!(config.saved_session().unwrap().time_zone, None);
    }

    #[test]
    fn time_zone_のない古いセッションのファイルが読める() {
        let config = Config::at(SERVER, &temp_dir("session-old"));
        fs::write(
            config.session_path(),
            r#"{"token":"old-token","user_id":"owner"}"#,
        )
        .unwrap();
        let saved = config.saved_session().unwrap();
        assert_eq!(saved.token, "old-token");
        assert_eq!(saved.user_id.as_deref(), Some("owner"));
        assert_eq!(saved.time_zone, None);
    }

    fn env_of<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    #[test]
    fn 置き場は_xdgがあればそれ_なければhomeから決める() {
        let from_home = resolve_dirs(env_of(&[("HOME", "/home/a")])).unwrap();
        assert_eq!(from_home.config, PathBuf::from("/home/a/.config/nagi"));
        assert_eq!(from_home.data, PathBuf::from("/home/a/.local/share/nagi"));

        let xdg = resolve_dirs(env_of(&[
            ("HOME", "/home/a"),
            ("XDG_CONFIG_HOME", "/c"),
            ("XDG_DATA_HOME", "/d"),
        ]))
        .unwrap();
        assert_eq!(xdg.config, PathBuf::from("/c/nagi"));
        assert_eq!(xdg.data, PathBuf::from("/d/nagi"));

        // 空の XDG_DATA_HOME は、ないものとして扱う
        let empty = resolve_dirs(env_of(&[("HOME", "/home/a"), ("XDG_DATA_HOME", "")])).unwrap();
        assert_eq!(empty.data, PathBuf::from("/home/a/.local/share/nagi"));
    }

    #[test]
    fn homeがなければ_今のフォルダに落とさずに断る() {
        assert!(resolve_dirs(env_of(&[])).is_err());
        assert!(resolve_dirs(env_of(&[("HOME", "")])).is_err());
        // 片方だけ XDG があっても、もう片方を決められなければ断る
        assert!(resolve_dirs(env_of(&[("XDG_DATA_HOME", "/d")])).is_err());
        // どちらも XDG で決まるなら、HOME は要らない
        assert!(
            resolve_dirs(env_of(&[
                ("XDG_CONFIG_HOME", "/c"),
                ("XDG_DATA_HOME", "/d")
            ]))
            .is_ok()
        );
    }

    #[test]
    fn import_offeredのない古いprefsも読め_印は保存して読み戻せる() {
        let config = Config::at(SERVER, &temp_dir("prefs-old"));
        fs::write(
            config.prefs_path(),
            r#"{"board":["today"],"sort":{"today":"title"},"sidebar_rail":true}"#,
        )
        .unwrap();
        let mut prefs = config.load_prefs();
        assert!(prefs.sidebar_rail);
        assert!(prefs.board.contains("today"));
        assert!(prefs.import_offered.is_empty());

        prefs
            .import_offered
            .insert(config.import_offer_key(Some("u1")));
        config.save_prefs(&prefs);
        let read_back = config.load_prefs();
        assert!(
            read_back
                .import_offered
                .contains(&config.import_offer_key(Some("u1")))
        );
        assert!(
            !read_back
                .import_offered
                .contains(&config.import_offer_key(Some("u2")))
        );
        assert!(read_back.sidebar_rail);
    }

    fn legacy_name(suffix: &str) -> String {
        format!("{}{suffix}", slug(LEGACY_DEFAULT_SERVER))
    }

    fn new_name(suffix: &str) -> String {
        format!("{}{suffix}", slug(DEFAULT_SERVER))
    }

    /// WAL モードの控え。返す接続を持っているあいだ、変更は -wal に残る
    fn wal_db(path: &Path, note: &str) -> rusqlite::Connection {
        let db = rusqlite::Connection::open(path).unwrap();
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE notes (text TEXT)")
            .unwrap();
        db.execute("INSERT INTO notes VALUES (?1)", [note]).unwrap();
        db
    }

    fn note(path: &Path) -> String {
        rusqlite::Connection::open(path)
            .unwrap()
            .query_row("SELECT text FROM notes", [], |row| row.get(0))
            .unwrap()
    }

    fn legacy_home(name: &str) -> Config {
        let config = Config::at(DEFAULT_SERVER, &temp_dir(name));
        write_private(
            &config
                .config_dir
                .join(format!("session-{}.json", slug(LEGACY_DEFAULT_SERVER))),
            r#"{"token":"old-token","user_id":"user-1"}"#,
        )
        .unwrap();
        config
    }

    #[test]
    fn 古い接続先のセッションと控えは_新しい接続先の名前に移る() {
        let config = legacy_home("migrate");
        let _open = wal_db(
            &config.data_dir.join(legacy_name("--user-1.db")),
            "per-user",
        );

        config.migrate_legacy_files();

        assert_eq!(
            config.saved_session(),
            Some(Session {
                token: "old-token".to_string(),
                user_id: Some("user-1".to_string()),
                time_zone: None,
            })
        );
        let moved = config.db_path(Some("user-1"));
        assert_eq!(file_name(&moved), new_name("--user-1.db"));
        // -wal に残っていた変更も、移した控えに入っている
        assert_eq!(note(&moved), "per-user");
        let left: Vec<_> = [&config.config_dir, &config.data_dir]
            .iter()
            .flat_map(|dir| fs::read_dir(dir).unwrap().flatten())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("workers.dev"))
            .collect();
        assert!(left.is_empty(), "{left:?}");

        // ログアウトのあとに起動しても、古い方から黙ってログインし直さない
        config.clear_token();
        config.remove_db(Some("user-1"));
        config.migrate_legacy_files();
        assert_eq!(config.saved_session(), None);
        assert!(!config.db_path(Some("user-1")).exists());
    }

    #[cfg(unix)]
    #[test]
    fn 置き場のフォルダとprefsは_自分だけが入れる権限で作る() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_dir("private");
        let config = Config {
            server: SERVER.to_string(),
            explicit_server: false,
            config_dir: root.join("a/config/nagi"),
            data_dir: root.join("a/data/nagi"),
        };
        config.prepare_dirs().unwrap();
        config.prepare_dirs().unwrap();
        config.save_prefs(&Prefs::default());
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&config.config_dir), 0o700);
        assert_eq!(mode(&config.data_dir), 0o700);
        assert_eq!(mode(&config.prefs_path()), 0o600);
    }

    #[cfg(unix)]
    #[test]
    fn 移したセッションは_自分だけが読める() {
        use std::os::unix::fs::PermissionsExt;
        let config = legacy_home("mode");
        config.migrate_legacy_files();
        let mode = fs::metadata(config.session_path())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn 利用者を分ける前の控えは_持ち主の印と一緒に移る() {
        let config = legacy_home("owner");
        let _open = wal_db(&config.data_dir.join(legacy_name(".db")), "shared");
        fs::write(config.data_dir.join(legacy_name(".db.owner")), "owner").unwrap();

        config.migrate_legacy_files();

        let moved = config.db_path(Some("owner"));
        assert_eq!(file_name(&moved), new_name(".db"));
        assert_eq!(moved, config.db_path(None));
        assert_eq!(note(&moved), "shared");
        assert_ne!(config.db_path(Some("other")), moved);
    }

    #[test]
    fn 古い接続先の聞いた印は_新しい接続先の印に書き換わる() {
        let config = legacy_home("offered");
        let mut prefs = Prefs::default();
        prefs
            .import_offered
            .insert(format!("{LEGACY_DEFAULT_SERVER}|user-1"));
        prefs
            .import_offered
            .insert("https://other.example|u".into());
        prefs.sidebar_rail = true;
        config.save_prefs(&prefs);

        config.migrate_legacy_files();

        let moved = config.load_prefs();
        assert!(
            moved
                .import_offered
                .contains(&config.import_offer_key(Some("user-1")))
        );
        assert!(moved.import_offered.contains("https://other.example|u"));
        assert_eq!(moved.import_offered.len(), 2);
        assert!(moved.sidebar_rail);
    }

    #[test]
    fn 新しい接続先のファイルがすでにあれば_どちらも書き換えない() {
        let config = legacy_home("both");
        let old_session = config
            .config_dir
            .join(format!("session-{}.json", slug(LEGACY_DEFAULT_SERVER)));
        config.save_session("new-token", Some("user-2")).unwrap();
        let old_db = config.data_dir.join(legacy_name("--user-1.db"));
        drop(wal_db(&old_db, "old"));
        drop(wal_db(&config.db_path(Some("user-1")), "new"));
        let old_bytes = fs::read(&old_db).unwrap();

        config.migrate_legacy_files();

        assert_eq!(config.saved_token().as_deref(), Some("new-token"));
        assert_eq!(
            fs::read_to_string(old_session).unwrap(),
            r#"{"token":"old-token","user_id":"user-1"}"#
        );
        assert_eq!(note(&config.db_path(Some("user-1"))), "new");
        assert_eq!(fs::read(&old_db).unwrap(), old_bytes);
    }

    #[test]
    fn 接続先を名指ししたときは_何も移さない() {
        let mut config = legacy_home("explicit");
        drop(wal_db(
            &config.data_dir.join(legacy_name("--user-1.db")),
            "old",
        ));
        config.explicit_server = true;

        config.migrate_legacy_files();

        assert_eq!(config.saved_session(), None);
        assert!(!config.db_path(Some("user-1")).exists());
        assert!(config.data_dir.join(legacy_name("--user-1.db")).exists());
    }

    #[test]
    fn 畳めない控えは_移さずに残す() {
        let config = legacy_home("broken");
        let old_db = config.data_dir.join(legacy_name("--user-1.db"));
        fs::write(&old_db, b"not a database").unwrap();

        config.migrate_legacy_files();

        assert!(old_db.exists());
        assert!(!config.db_path(Some("user-1")).exists());
        assert!(config.saved_session().is_some());
    }
}

#[cfg(unix)]
#[cfg(test)]
mod prepare_tests {
    use super::*;

    /// 置き場の途中が通常のファイルで、フォルダを作れない設定
    fn blocked(explicit_server: bool) -> Config {
        let root = std::env::temp_dir().join(format!(
            "nagi-config-blocked-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("file");
        fs::write(&file, "").unwrap();
        Config {
            server: "https://nagi.example.com".to_string(),
            explicit_server,
            config_dir: file.join("config"),
            data_dir: file.join("data"),
        }
    }

    #[test]
    fn 置き場を作れなくても_クラウドは手元の控えなしで続ける() {
        let reason = blocked(true).prepare_dirs().unwrap();
        assert!(reason.is_some());
    }

    #[test]
    fn 置き場を作れなければ_ローカルは理由つきで止まる() {
        if Config::has_env_token() {
            return;
        }
        assert!(blocked(false).prepare_dirs().is_err());
    }
}
