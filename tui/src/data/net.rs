//! Worker との通信。/api/sync と /api/mutate は JSON の POST で、X-Api-Version と（ログインしていれば）
//! Authorization: Bearer を付ける。通信は専用のスレッドで行い、結果は NetEvent として画面のスレッドへ返す

use std::sync::mpsc::{Sender, channel};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::store::{ApiFailure, SyncFlow, Transport};
use crate::model::{
    API_VERSION, API_VERSION_HEADER, ApiErrorBody, MutateResponse, MutationBatch, SyncRequest,
    SyncResponse, SyncRow,
};

/// 1回の呼び出しを待つ時間。過ぎたら打ち切って、通信エラーと同じに扱う
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// 再送までの待ち時間（1回目、2回目）
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(2000)];

#[derive(Clone)]
pub struct ApiClient {
    agent: ureq::Agent,
    /// Worker の URL（末尾の / なし）
    base: String,
    token: Option<String>,
}

impl ApiClient {
    pub fn new(base: &str, token: Option<String>) -> ApiClient {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            // 4xx・5xx も応答として受け取り、自分で分ける
            .http_status_as_error(false)
            .build();
        ApiClient {
            agent: config.into(),
            base: base.trim_end_matches('/').to_string(),
            token,
        }
    }

    /// JSON の POST。応答の本文と HTTP の状態を返す（通信エラーは Network）
    pub fn post_raw(&self, path: &str, body: &impl Serialize) -> Result<(u16, String), ApiFailure> {
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header(API_VERSION_HEADER, API_VERSION.to_string());
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request.send_json(body).map_err(|_| ApiFailure::Network)?;
        let status = response.status().as_u16();
        // 途中で切れた本文は、届いたかどうか分からないので、通信エラーと同じ（再送できる）扱いにする
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|_| ApiFailure::Network)?;
        Ok((status, text))
    }

    fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
    ) -> Result<T, ApiFailure> {
        let (status, text) = self.post_raw(path, body)?;
        match status {
            200..=299 => serde_json::from_str(&text).map_err(|_| ApiFailure::Server(status)),
            401 => Err(ApiFailure::Unauthorized),
            // Worker が 409 を返すのは API の版が違うときだけ
            409 => Err(ApiFailure::VersionMismatch),
            500.. => Err(ApiFailure::Server(status)),
            _ => {
                let body: ApiErrorBody = serde_json::from_str(&text).unwrap_or_default();
                Err(ApiFailure::Rejected {
                    status,
                    reason: body.reason.or(Some(body.error).filter(|e| !e.is_empty())),
                })
            }
        }
    }

    /// 1回の差分の取得の流れ（hasMore がなくなるまで）。base_cursor は、その流れの最初の、手元に反映済みの
    /// カーソルで、すべてのページにそのまま付ける。reset が来たら、それまでのページを捨てて 0 から取り直す
    pub fn sync_flow(&self, cursor: u64) -> Result<SyncFlow, ApiFailure> {
        let mut base_cursor = cursor;
        let mut cursor = cursor;
        let mut reset = false;
        let mut rows = Vec::new();
        loop {
            let page: SyncResponse = self.post(
                "/api/sync",
                &SyncRequest {
                    cursor,
                    base_cursor,
                },
            )?;
            if page.reset {
                // base_cursor が 0 なら reset は来ない。続いたら Worker の不具合なので、あきらめて次のきっかけを待つ
                if reset {
                    return Err(ApiFailure::Rejected {
                        status: 200,
                        reason: Some("reset が続きました".to_string()),
                    });
                }
                reset = true;
                base_cursor = 0;
                cursor = 0;
                rows.clear();
                continue;
            }
            rows.extend(page.rows);
            cursor = page.next_cursor;
            if !page.has_more {
                break;
            }
        }
        Ok(SyncFlow {
            base_cursor,
            rows,
            cursor,
        })
    }

    /// まとまりを送る。通信エラー・タイムアウト・5xx は、同じ ID のまま 2 回まで再送する。
    /// Worker は同じ ID の再送を見分けて、対象の行の今の内容を返すので、成功と同じに扱える
    pub fn mutate(&self, batch: &MutationBatch) -> Result<Vec<SyncRow>, ApiFailure> {
        let send = || {
            self.post::<MutateResponse>("/api/mutate", batch)
                .map(|response| response.rows)
        };
        let mut result = send();
        for delay in RETRY_DELAYS {
            match &result {
                Err(error) if error.is_retryable() => {}
                _ => break,
            }
            thread::sleep(delay);
            result = send();
        }
        result
    }
}

/// 通信の結果
pub enum NetEvent {
    MutateDone {
        batch_id: String,
        result: Result<Vec<SyncRow>, ApiFailure>,
    },
    SyncDone(Result<SyncFlow, ApiFailure>),
}

/// 通信のスレッドへの入口。送信と差分の取得は別のスレッドで、それぞれ1つずつ順に行う
pub struct NetTransport {
    mutate_tx: Sender<MutationBatch>,
    sync_tx: Sender<u64>,
}

impl NetTransport {
    /// 通信のスレッドを起こす。結果は notify に渡す（画面のスレッドへ送る）。
    /// NetTransport を捨てると、スレッドは今の通信を終えたあとに止まる
    pub fn spawn(
        client: ApiClient,
        notify: impl Fn(NetEvent) + Send + Clone + 'static,
    ) -> NetTransport {
        let (mutate_tx, mutate_rx) = channel::<MutationBatch>();
        let (sync_tx, sync_rx) = channel::<u64>();
        {
            let client = client.clone();
            let notify = notify.clone();
            thread::spawn(move || {
                for batch in mutate_rx {
                    let result = client.mutate(&batch);
                    notify(NetEvent::MutateDone {
                        batch_id: batch.id,
                        result,
                    });
                }
            });
        }
        thread::spawn(move || {
            for cursor in sync_rx {
                notify(NetEvent::SyncDone(client.sync_flow(cursor)));
            }
        });
        NetTransport { mutate_tx, sync_tx }
    }
}

impl Transport for NetTransport {
    fn mutate(&mut self, batch: MutationBatch) {
        let _ = self.mutate_tx.send(batch);
    }

    fn sync(&mut self, cursor: u64) {
        let _ = self.sync_tx.send(cursor);
    }
}
