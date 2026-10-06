//! ログイン（GitHub のデバイスフロー）。TUI がコードを出し、利用者が別の端末のブラウザで承認する。
//! GitHub とのやり取りは Worker が行い、TUI は Worker の /auth/device/* を呼ぶだけ（GitHub のトークンは持たない）

use serde::Deserialize;
use serde_json::json;

use crate::data::net::ApiClient;

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
    /// ログインできた。セッションのトークン
    Ok(String),
}

#[derive(Deserialize)]
struct PollBody {
    status: String,
    #[serde(default)]
    interval: Option<u64>,
    #[serde(default)]
    token: Option<String>,
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

/// 承認されたかを1回確かめる
pub fn poll(client: &ApiClient, device_code: &str) -> Result<DevicePoll, String> {
    let (status, text) = client
        .post_raw("/auth/device/token", &json!({ "deviceCode": device_code }))
        .map_err(|_| "Worker に接続できませんでした".to_string())?;
    if status != 200 {
        return Err(failure(status, &text));
    }
    let body: PollBody =
        serde_json::from_str(&text).map_err(|_| "ログインの応答が読めません".to_string())?;
    Ok(match body.status.as_str() {
        "pending" => DevicePoll::Pending,
        "slow_down" => DevicePoll::SlowDown(body.interval.unwrap_or(10)),
        "expired" => DevicePoll::Expired,
        "denied" => DevicePoll::Denied,
        "forbidden" => DevicePoll::Forbidden,
        "ok" => DevicePoll::Ok(body.token.ok_or("ログインの応答が読めません")?),
        other => return Err(format!("ログインの応答が読めません（{other}）")),
    })
}

/// ログアウト（Worker のセッションを消す）。失敗しても、手元のトークンは呼んだ側が消す
pub fn logout(client: &ApiClient) {
    let _ = client.post_raw("/auth/logout", &json!({}));
}
