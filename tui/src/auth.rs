//! ログイン（GitHub のデバイスフロー）。TUI がコードを出し、利用者が別の端末のブラウザで承認する。
//! GitHub とのやり取りは Worker が行い、TUI は Worker の /auth/device/* を呼ぶだけ（GitHub のトークンは持たない）

use std::time::Duration;

use serde::Deserialize;
use serde_json::json;

use crate::config::Config;
use crate::data::net::ApiClient;
use crate::dates::device_time_zone;

/// ログインの持ち主を Worker に聞くときに待つ時間（画面を出す前に聞くので、短くする）
const WHOAMI_TIMEOUT: Duration = Duration::from_secs(3);

/// POST /auth/device/start の応答
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub device_code: String,
    /// 利用者がブラウザで入力するコード
    pub user_code: String,
    /// 利用者が開く URL
    pub verification_uri: String,
    /// コードの有効期限（秒）
    pub expires_in: u64,
    /// 確かめに行く間隔（秒）
    pub interval: u64,
}

/// POST /auth/device/token の応答（1回ぶんの確かめ）
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DevicePoll {
    /// まだ承認されていない
    Pending,
    /// 確かめる間隔を、この秒数に広げる
    SlowDown(u64),
    /// コードの期限が切れた
    Expired,
    /// 利用者が断った
    Denied,
    /// 承認されたが、許可していない GitHub ユーザー
    Forbidden,
    /// ログインできた。セッションのトークンと、利用者の ID（利用者の ID を返さない古い Worker では None）
    Ok {
        token: String,
        user_id: Option<String>,
    },
}

#[derive(Deserialize)]
struct PollBody {
    status: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    token: Option<String>,
    #[serde(default, rename = "userId")]
    user_id: Option<String>,
}

fn failure(status: u16, text: &str) -> String {
    let error = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|body| body.get("error")?.as_str().map(str::to_string));
    match error.as_deref() {
        Some("config") => "Worker のログインの設定が足りません".to_string(),
        Some("github") => {
            "GitHub とやり取りできませんでした（OAuth App でデバイスフローが有効か確かめてください）"
                .to_string()
        }
        _ if status == 429 => "試行が多すぎます。1 分待ってください".to_string(),
        _ => format!("ログインを始められませんでした（HTTP {status}）"),
    }
}

/// デバイスコードを発行してもらう
pub fn start(client: &ApiClient) -> Result<DeviceStart, String> {
    let (status, text) = client
        .post_raw("/auth/device/start", &json!({}))
        .map_err(|_| "Worker に接続できませんでした".to_string())?;
    if status != 200 {
        return Err(failure(status, &text));
    }
    serde_json::from_str(&text).map_err(|_| "ログインの応答が読めません".to_string())
}

/// 承認されたかを1回確かめる。この端末のタイムゾーンを添える（ログインできたときだけ、Worker が利用者に書く）
pub fn poll(client: &ApiClient, device_code: &str) -> Result<DevicePoll, String> {
    let (status, text) = client
        .post_raw(
            "/auth/device/token",
            &json!({ "deviceCode": device_code, "timeZone": device_time_zone().name() }),
        )
        .map_err(|_| "Worker に接続できませんでした".to_string())?;
    if status != 200 {
        return Err(failure(status, &text));
    }
    parse_poll(&text)
}

fn parse_poll(text: &str) -> Result<DevicePoll, String> {
    let body: PollBody =
        serde_json::from_str(text).map_err(|_| "ログインの応答が読めません".to_string())?;
    Ok(match body.status.as_str() {
        "pending" => DevicePoll::Pending,
        "slow_down" => DevicePoll::SlowDown(body.interval.unwrap_or(10)),
        "expired" => DevicePoll::Expired,
        "denied" => DevicePoll::Denied,
        "forbidden" => DevicePoll::Forbidden,
        "ok" => DevicePoll::Ok {
            token: body.token.ok_or("ログインの応答が読めません")?,
            user_id: body.user_id.filter(|id| !id.is_empty()),
        },
        other => return Err(format!("ログインの応答が読めません（{other}）")),
    })
}

/// ログアウト（Worker のセッションを消す）。失敗しても、手元のトークンは呼んだ側が消す
pub fn logout(client: &ApiClient) {
    let _ = client.post_raw("/auth/logout", &json!({}));
}

#[derive(Deserialize)]
struct SessionBody {
    #[serde(default, rename = "userId")]
    user_id: Option<String>,
}

/// GET /api/session の応答から、利用者の ID を読む
fn parse_whoami(status: u16, text: &str) -> Option<String> {
    if status != 200 {
        return None;
    }
    let body: SessionBody = serde_json::from_str(text).ok()?;
    body.user_id.filter(|id| !id.is_empty())
}

/// ログインの持ち主（利用者の ID）を Worker に聞く。分からなければ None
/// （つながらない・ログインが切れている・利用者の ID を返さない古い Worker）
fn whoami(client: &ApiClient) -> Option<String> {
    let (status, text) = client.get_raw("/api/session", WHOAMI_TIMEOUT).ok()?;
    parse_whoami(status, &text)
}

/// いまのログイン（トークンと、その持ち主の利用者の ID）。両方を、1 回だけ読んだログインから決める
/// （別々に読むと、あいだに `nagi login` が入れ替えたとき、前のトークンで次の利用者の控えを送ってしまう）。
/// 利用者の ID は、手元の控えを利用者ごとに分けるのに使う（Config::db_path）。
/// - トークンは、環境変数 NAGI_TOKEN があればそれ（手元にログインを置けない、自動の実行のため）、なければ保存してあるもの
/// - 保存してあるログインに ID があれば、それ（通信しない）
/// - ID のないログイン（利用者の ID を返さないころにログインしたもの）は、Worker に聞く。分かったら、ログインに書き足し、
///   それまでの控え（Worker ごとの 1 つ）を、その利用者のものにする（その控えは、このログインで作ったものなので）
/// - 環境変数 NAGI_TOKEN のログインは、毎回 Worker に聞く（保存しない。それまでの控えも引き継がない）
/// - 分からなければ None（ログインしていない・つながらない・古い Worker）。控えは、Worker ごとの 1 つを使う
pub fn current_login(config: &Config) -> Login {
    let saved = config.saved_session();
    let env_token = std::env::var("NAGI_TOKEN").ok().filter(|t| !t.is_empty());
    login_with(config, saved, env_token, |token| {
        whoami(&ApiClient::new(&config.server, Some(token.to_string())))
    })
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Login {
    pub token: Option<String>,
    pub user_id: Option<String>,
}

fn login_with(
    config: &Config,
    saved: Option<crate::config::Session>,
    env_token: Option<String>,
    whoami: impl Fn(&str) -> Option<String>,
) -> Login {
    if let Some(token) = env_token {
        // 保存してあるログインと同じトークンなら、聞かずに済む
        let user_id = match saved {
            Some(session) if session.token == token && session.user_id.is_some() => session.user_id,
            _ => whoami(&token),
        };
        return Login {
            token: Some(token),
            user_id,
        };
    }
    let Some(session) = saved else {
        return Login::default();
    };
    let user_id = session.user_id.or_else(|| {
        let user_id = whoami(&session.token)?;
        if let Err(error) = config.save_session(&session.token, Some(&user_id)) {
            crate::log::error(&format!("ログインを保存できませんでした: {error}"));
        }
        config.adopt_shared_db(&user_id);
        Some(user_id)
    });
    Login {
        token: Some(session.token),
        user_id,
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;

    use super::*;
    use crate::config::Session;
    use crate::data::local_db::{LocalDb, PendingOwner};
    use crate::data::replica::{OperationKind, PendingBatch};
    use crate::model::{Mutation, TaskChanges};

    #[test]
    fn 回数制限の429は_待つように伝える() {
        let text = r#"{"error":"rate_limited"}"#;
        assert_eq!(failure(429, text), "試行が多すぎます。1 分待ってください");
    }

    fn temp_config(name: &str) -> Config {
        let dir: PathBuf = std::env::temp_dir().join(format!(
            "nagi-auth-test-{}-{name}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&dir).unwrap();
        Config::at("https://nagi.example.com", &dir)
    }

    fn session(token: &str, user_id: Option<&str>) -> Option<Session> {
        Some(Session {
            token: token.to_string(),
            user_id: user_id.map(str::to_string),
            time_zone: None,
        })
    }

    #[test]
    fn ログインの応答から_トークンと利用者のidを読む() {
        assert_eq!(
            parse_poll(
                r#"{"status":"ok","token":"t","expiresAt":"2027-01-01T00:00:00.000Z","userId":"u1"}"#
            ),
            Ok(DevicePoll::Ok {
                token: "t".to_string(),
                user_id: Some("u1".to_string()),
            })
        );
        // 利用者の ID を返さない古い Worker
        assert_eq!(
            parse_poll(r#"{"status":"ok","token":"t","expiresAt":"2027-01-01T00:00:00.000Z"}"#),
            Ok(DevicePoll::Ok {
                token: "t".to_string(),
                user_id: None,
            })
        );
        assert_eq!(
            parse_poll(r#"{"status":"pending"}"#),
            Ok(DevicePoll::Pending)
        );
        assert_eq!(
            parse_poll(r#"{"status":"slow_down","interval":15}"#),
            Ok(DevicePoll::SlowDown(15))
        );
        assert_eq!(
            parse_poll(r#"{"status":"forbidden"}"#),
            Ok(DevicePoll::Forbidden)
        );
        assert!(parse_poll(r#"{"status":"ok"}"#).is_err());
        assert!(parse_poll("not json").is_err());
    }

    #[test]
    fn セッションの応答から_利用者のidを読む() {
        assert_eq!(
            parse_whoami(200, r#"{"authenticated":true,"userId":"owner"}"#),
            Some("owner".to_string())
        );
        // 古い Worker・ログイン切れ・読めない応答は、分からない扱い
        assert_eq!(parse_whoami(200, r#"{"authenticated":true}"#), None);
        assert_eq!(
            parse_whoami(200, r#"{"authenticated":true,"userId":""}"#),
            None
        );
        assert_eq!(
            parse_whoami(401, r#"{"error":"unauthorized","userId":"x"}"#),
            None
        );
        assert_eq!(parse_whoami(500, r#"{"error":"config"}"#), None);
        assert_eq!(parse_whoami(200, "<html>"), None);
    }

    #[test]
    fn idのあるログインは_workerに聞かない() {
        let config = temp_config("known");
        let asked = Cell::new(0);
        let user = login_with(&config, session("t", Some("u1")), None, |_| {
            asked.set(asked.get() + 1);
            Some("other".to_string())
        })
        .user_id;
        assert_eq!(user.as_deref(), Some("u1"));
        assert_eq!(asked.get(), 0);
    }

    #[test]
    fn idのないログインは_workerに聞いて書き足し_それまでの控えを引き継ぐ() {
        let config = temp_config("legacy");
        config.save_session("t", None).unwrap();
        let shared = config.db_path(None);
        fs::write(&shared, b"db").unwrap();

        let login = login_with(&config, config.saved_session(), None, |token| {
            assert_eq!(token, "t");
            Some("owner".to_string())
        });

        assert_eq!(
            login,
            Login {
                token: Some("t".to_string()),
                user_id: Some("owner".to_string()),
            }
        );
        assert_eq!(config.saved_session(), session("t", Some("owner")));
        // それまでの控えを、そのまま使う（作り直さない）
        assert_eq!(config.db_path(Some("owner")), shared);
    }

    #[test]
    fn idのないログインで_workerに聞けなければ_分からないまま何も変えない() {
        let config = temp_config("offline");
        config.save_session("t", None).unwrap();
        fs::write(config.db_path(None), b"db").unwrap();

        let login = login_with(&config, config.saved_session(), None, |_| None);

        assert_eq!(login.token.as_deref(), Some("t"));
        assert_eq!(login.user_id, None);
        assert_eq!(config.saved_session(), session("t", None));
        // 次に分かったときに引き継げるよう、印は付けない
        assert_ne!(config.db_path(Some("owner")), config.db_path(None));
    }

    #[test]
    fn 環境変数のトークンは_毎回workerに聞き_保存も引き継ぎもしない() {
        let config = temp_config("env");
        config.save_session("saved", Some("owner")).unwrap();
        let shared = config.db_path(None);
        fs::write(&shared, b"db").unwrap();

        let login = login_with(
            &config,
            config.saved_session(),
            Some("env-token".to_string()),
            |token| {
                assert_eq!(token, "env-token");
                Some("robot".to_string())
            },
        );

        assert_eq!(
            login,
            Login {
                token: Some("env-token".to_string()),
                user_id: Some("robot".to_string()),
            }
        );
        assert_eq!(config.saved_session(), session("saved", Some("owner")));
        // 別の利用者なので、別の控えを使う
        assert_ne!(config.db_path(Some("robot")), shared);
        assert_ne!(config.db_path(Some("robot")), config.db_path(Some("owner")));

        // 保存してあるログインと同じトークンなら、聞かない
        let same = login_with(
            &config,
            config.saved_session(),
            Some("saved".to_string()),
            |_| panic!("聞かないはず"),
        );
        assert_eq!(same.user_id.as_deref(), Some("owner"));
    }

    #[test]
    fn ログインしていなければ_分からない() {
        let config = temp_config("none");
        assert_eq!(
            login_with(&config, None, None, |_| panic!("聞かないはず")),
            Login::default()
        );
    }

    #[test]
    fn ログインを読んだあとに別の利用者でログインし直されても_前のトークンで次の利用者の変更を送らない()
     {
        let config = temp_config("relogin");
        // A と B の控えに、それぞれが送れずに残した変更がある
        for (user, token, id) in [
            ("user-a", "token-a", "kept-a"),
            ("user-b", "token-b", "kept-b"),
        ] {
            LocalDb::open(&config.db_path(Some(user)))
                .unwrap()
                .save_pending(
                    &PendingOwner::new(Some(user), Some(token)),
                    &[PendingBatch {
                        id: id.to_string(),
                        mutations: vec![Mutation::update_task(
                            "t1",
                            TaskChanges {
                                memo: Some(format!("{user} のメモ")),
                                ..Default::default()
                            },
                        )],
                        at: "2026-10-06T03:00:00.000Z".to_string(),
                        kind: OperationKind::TaskUpdate,
                    }],
                )
                .unwrap();
        }
        config.save_session("token-a", Some("user-a")).unwrap();

        let login = login_with(&config, config.saved_session(), None, |_| {
            panic!("聞かないはず")
        });
        // ログインを読んだあと、ストアを開く前に、別の端末で B としてログインし直した
        config.save_session("token-b", Some("user-b")).unwrap();
        assert_eq!(login.token.as_deref(), Some("token-a"));
        let store = crate::data::open_store(&config, login.token, login.user_id.as_deref(), |_| {})
            .unwrap();

        // A のトークンで送る列には、A の変更だけが入る
        let queued: Vec<&str> = store
            .replica
            .pending()
            .iter()
            .map(|batch| batch.id.as_str())
            .collect();
        assert_eq!(queued, ["kept-a"]);
    }
}
