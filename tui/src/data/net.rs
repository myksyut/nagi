//! Worker との通信。/api/sync と /api/mutate は JSON の POST で、X-Api-Version と（ログインしていれば）
//! Authorization: Bearer を付ける。通信は専用のスレッドで行い、結果は NetEvent として画面のスレッドへ返す

use std::path::Path;
use std::sync::mpsc::{Sender, channel};
use std::thread;
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::device::{DeviceDb, Export};
use super::store::{ApiFailure, SyncFlow, Transport};
use crate::i18n::{Msg, fill, t};
use crate::model::{
    API_VERSION, API_VERSION_HEADER, ApiErrorBody, MAX_PROJECTS_PER_USER, MAX_TASKS_PER_USER,
    MutateResponse, MutationBatch, SyncRequest, SyncResponse, SyncRow,
};

/// 1回の呼び出しを待つ時間。過ぎたら打ち切って、通信エラーと同じに扱う
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// アカウントの削除を待つ時間
const DELETE_TIMEOUT: Duration = Duration::from_secs(30);
/// 書き出しの 1 ページを待つ時間（本文の読み終わりまで）
const EXPORT_PAGE_TIMEOUT: Duration = Duration::from_secs(120);
/// 書き出しの 1 ページの本文の上限。Worker のページは数えて 2 MiB（src/worker/account/export.ts の PAGE_BYTES）までで、
/// JSON にすると制御文字のエスケープで最大 6 倍になる
const EXPORT_PAGE_LIMIT: u64 = 16 * 1024 * 1024;
/// 429 に Retry-After がないときに待つ時間（Worker の回数制限の窓）
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(60);
/// 再送までの待ち時間（1回目、2回目）
const RETRY_DELAYS: [Duration; 2] = [Duration::from_millis(500), Duration::from_millis(2000)];

#[derive(Clone)]
pub struct ApiClient {
    agent: ureq::Agent,
    /// Worker の URL（末尾の / なし）
    base: String,
    token: Option<String>,
}

/// `ApiClient::export_page` の結果
pub enum ExportReply {
    /// ページの本文（JSON）
    Page(String),
    /// 回数制限にかかった。この時間を待ってから、同じページを読み直す
    RetryAfter(Duration),
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

    /// GET。応答の本文と HTTP の状態を返す。待つ時間は呼ぶ側が決める（画面を出す前に呼ぶものは、短くする）
    pub fn get_raw(&self, path: &str, timeout: Duration) -> Result<(u16, String), ApiFailure> {
        let mut request = self
            .agent
            .get(format!("{}{path}", self.base))
            .config()
            .timeout_global(Some(timeout))
            .build();
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request.call().map_err(|_| ApiFailure::Network)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|_| ApiFailure::Network)?;
        Ok((status, text))
    }

    /// 書き出しの 1 ページ（GET /api/export?kind=…&after=…）。本文の JSON（src/shared/export.ts の ExportPage）を
    /// そのまま返す。429（回数制限）なら、待つ時間（Retry-After）を返す。失敗の文言は、利用者に見せるもの
    pub fn export_page(&self, kind: &str, after: Option<&str>) -> Result<ExportReply, String> {
        let mut request = self
            .agent
            .get(format!("{}/api/export", self.base))
            .query("kind", kind)
            .config()
            .timeout_global(Some(EXPORT_PAGE_TIMEOUT))
            .build();
        if let Some(after) = after {
            request = request.query("after", after);
        }
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request
            .call()
            .map_err(|_| t(Msg::WorkerUnreachable).to_string())?;
        match response.status().as_u16() {
            200 => response
                .body_mut()
                .with_config()
                .limit(EXPORT_PAGE_LIMIT)
                .read_to_string()
                .map(ExportReply::Page)
                .map_err(|error| fill(Msg::CliExportReadFailed, &[&error])),
            401 => Err(t(Msg::CliLoginExpiredRelogin).to_string()),
            429 => Ok(ExportReply::RetryAfter(
                response
                    .headers()
                    .get("Retry-After")
                    .and_then(|value| value.to_str().ok()?.trim().parse().ok())
                    .map_or(RATE_LIMIT_WAIT, Duration::from_secs),
            )),
            status => Err(fill(Msg::ExportFailedHttp, &[&status])),
        }
    }

    /// 本文つきの DELETE（アカウントの削除）。応答の本文と HTTP の状態を返す。再送はしない
    pub fn delete_raw(
        &self,
        path: &str,
        body: &impl Serialize,
        timeout: Duration,
    ) -> Result<(u16, String), ApiFailure> {
        let mut request = self
            .agent
            .delete(format!("{}{path}", self.base))
            .config()
            .timeout_global(Some(timeout))
            .build()
            .force_send_body();
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request.send_json(body).map_err(|_| ApiFailure::Network)?;
        let status = response.status().as_u16();
        // 204 に本文はない（本文を持たないのに Content-Encoding が付く経路があり、読むと展開に失敗する）
        if status == 204 {
            return Ok((status, String::new()));
        }
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|_| ApiFailure::Network)?;
        Ok((status, text))
    }

    /// クラウドのアカウントを消す。204 が返ったときだけ Ok（そのあとで手元を消す）。失敗の文言は、利用者に見せるもの
    pub fn delete_account(&self, user_id: &str) -> Result<(), String> {
        match self.delete_raw(
            "/api/account",
            &serde_json::json!({ "confirm": user_id }),
            DELETE_TIMEOUT,
        ) {
            Ok((204, _)) => Ok(()),
            Ok((401, _)) => Err(t(Msg::DeleteLoginExpired).to_string()),
            Ok((400, _)) => Err(t(Msg::DeleteIdMismatch).to_string()),
            Ok((status, _)) => Err(fill(Msg::DeleteFailedHttp, &[&status])),
            Err(_) => Err(t(Msg::DeleteUnreachable).to_string()),
        }
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
            409 => Err(version_failure(&text)),
            // 回数制限。Retry-After は 60 秒だが、同じ ID で再送するだけにして待たない
            429 | 500.. => Err(ApiFailure::Server(status)),
            _ => {
                let body: ApiErrorBody = serde_json::from_str(&text).unwrap_or_default();
                Err(ApiFailure::Rejected {
                    status,
                    reason: body.reason.or(Some(body.error).filter(|e| !e.is_empty())),
                    mutation_index: body.mutation_index,
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
        let mut time_zone = None;
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
                        reason: Some(t(Msg::NetResetRepeated).to_string()),
                        mutation_index: None,
                    });
                }
                reset = true;
                base_cursor = 0;
                cursor = 0;
                rows.clear();
                continue;
            }
            time_zone = page.time_zone.or(time_zone);
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
            time_zone,
        })
    }

    /// この端末のタイムゾーンを、利用者の設定として Worker に書く
    pub fn set_time_zone(&self, time_zone: &str) -> Result<(), ApiFailure> {
        self.post::<serde_json::Value>(
            "/api/time-zone",
            &serde_json::json!({ "timeZone": time_zone }),
        )
        .map(|_| ())
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

    /// 取り込みの 1 回分を送る（`dry_run` なら書かずに数だけ）。同じ本文は何度送っても同じ結果なので、
    /// 通信エラー・タイムアウト・5xx は 2 回まで再送する。断られたら、利用者に見せる文言を返す
    pub fn import(&self, chunk: &ImportChunk, dry_run: bool) -> Result<ImportResponse, String> {
        let path = if dry_run {
            "/api/import?dryRun=1"
        } else {
            "/api/import"
        };
        let mut delays = RETRY_DELAYS.into_iter();
        loop {
            let retry = match self.post_text(path, &chunk.body) {
                Ok((200..=299, text)) => {
                    return serde_json::from_str(&text)
                        .map_err(|_| t(Msg::NetImportBadResponse).to_string());
                }
                Ok((status @ 500.., _)) => ApiFailure::Server(status),
                Ok((status, text)) => return Err(import_rejection(status, &text, chunk)),
                Err(failure) => failure,
            };
            match delays.next() {
                Some(delay) => thread::sleep(delay),
                None => {
                    return Err(match retry {
                        ApiFailure::Server(status) => fill(Msg::NetImportServerError, &[&status]),
                        _ => fill(Msg::CliCannotReach, &[&self.base]),
                    });
                }
            }
        }
    }

    /// JSON の文字列をそのまま POST する（行ごとに作った本文を、作り直さずに送る）
    fn post_text(&self, path: &str, body: &str) -> Result<(u16, String), ApiFailure> {
        let mut request = self
            .agent
            .post(format!("{}{path}", self.base))
            .header(API_VERSION_HEADER, API_VERSION.to_string())
            .header("Content-Type", "application/json");
        if let Some(token) = &self.token {
            request = request.header("Authorization", format!("Bearer {token}"));
        }
        let mut response = request.send(body).map_err(|_| ApiFailure::Network)?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|_| ApiFailure::Network)?;
        Ok((status, text))
    }
}

/// 取り込み（POST /api/import）の 1 回に入れる行数の上限（Worker の MAX_IMPORT_ROWS。プロジェクトとタスクの合計）
pub const MAX_IMPORT_ROWS: usize = 500;
/// 取り込みの 1 回の本文の大きさの上限。Worker が受ける本文の上限（1 MiB）の下に置く
pub const MAX_IMPORT_BODY_BYTES: usize = 900 * 1024;

/// 取り込みの 1 回分。`nagi export` と同じ形の JSON で、プロジェクトがタスクより先に並ぶ
#[derive(Debug, PartialEq, Eq)]
pub struct ImportChunk {
    pub body: String,
    pub projects: usize,
    pub tasks: usize,
    /// この本文の最初のプロジェクト・タスクが、この端末の全体の何番目か（断られた行の位置を伝えるため）
    project_offset: usize,
    task_offset: usize,
}

impl ImportChunk {
    pub fn rows(&self) -> usize {
        self.projects + self.tasks
    }
}

/// 書き出した行を、プロジェクトを先に、タスクをあとに、行数と本文の大きさの上限に収まるように分ける。
/// 1 件だけで上限を超える行があれば、黙って捨てずに Err
pub fn split_import(
    export: &Export,
    exported_at: &str,
    app: &str,
) -> Result<Vec<ImportChunk>, String> {
    let text = |value: &str| serde_json::to_string(value).map_err(|error| error.to_string());
    let head = format!(
        r#"{{"format":"nagi-export","formatVersion":1,"exportedAt":{},"app":{},"projects":["#,
        text(exported_at)?,
        text(app)?
    );
    const MIDDLE: &str = r#"],"tasks":["#;
    const TAIL: &str = "]}";
    let base = head.len() + MIDDLE.len() + TAIL.len();

    struct Open {
        projects: Vec<String>,
        tasks: Vec<String>,
        bytes: usize,
    }
    let mut chunks = Vec::new();
    let mut open = Open {
        projects: Vec::new(),
        tasks: Vec::new(),
        bytes: base,
    };
    let (mut project_offset, mut task_offset) = (0, 0);
    let mut flush = |open: &mut Open| {
        let (projects, tasks) = (open.projects.len(), open.tasks.len());
        if projects + tasks == 0 {
            return;
        }
        chunks.push(ImportChunk {
            body: format!(
                "{head}{}{MIDDLE}{}{TAIL}",
                open.projects.join(","),
                open.tasks.join(",")
            ),
            projects,
            tasks,
            project_offset,
            task_offset,
        });
        project_offset += projects;
        task_offset += tasks;
        *open = Open {
            projects: Vec::new(),
            tasks: Vec::new(),
            bytes: base,
        };
    };
    let rows = export
        .projects
        .iter()
        .map(|row| (true, row))
        .chain(export.tasks.iter().map(|row| (false, row)));
    for (is_project, row) in rows {
        let json = serde_json::to_string(row).map_err(|error| error.to_string())?;
        // 行と行のあいだの「,」を数に入れる
        let size = json.len() + 1;
        if base + size > MAX_IMPORT_BODY_BYTES {
            let id = row["id"].as_str().unwrap_or_default();
            return Err(fill(
                Msg::NetImportRowTooLarge,
                &[&id, &(MAX_IMPORT_BODY_BYTES / 1024)],
            ));
        }
        if open.projects.len() + open.tasks.len() == MAX_IMPORT_ROWS
            || open.bytes + size > MAX_IMPORT_BODY_BYTES
        {
            flush(&mut open);
        }
        open.bytes += size;
        if is_project {
            open.projects.push(json);
        } else {
            open.tasks.push(json);
        }
    }
    flush(&mut open);
    Ok(chunks)
}

/// この端末のデータ（`local.db`。削除済みの行は入れない）を、取り込みの本文に分ける。ファイルがなければ空
pub fn local_import_chunks(path: &Path) -> Result<Vec<ImportChunk>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let export = DeviceDb::open(path)?.export()?;
    split_import(
        &export,
        &crate::dates::iso(chrono::Utc::now()),
        &format!("nagi {}", crate::VERSION),
    )
}

/// 新しく入る行と、クラウドにもうある行の数
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct ImportCounts {
    pub new: usize,
    pub existing: usize,
}

/// POST /api/import の応答（`detached_tasks`：指す先のプロジェクトがなく、プロジェクトなしで入った（入る）タスク）
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub tasks: ImportCounts,
    pub projects: ImportCounts,
    #[serde(default)]
    pub detached_tasks: usize,
}

impl ImportResponse {
    /// プロジェクトとタスクを合わせた、新しく入る行の数
    pub fn new_rows(&self) -> usize {
        self.tasks.new + self.projects.new
    }

    /// プロジェクトとタスクを合わせた、もうある行の数
    pub fn existing_rows(&self) -> usize {
        self.tasks.existing + self.projects.existing
    }

    fn add(&mut self, other: &ImportResponse) {
        self.tasks.new += other.tasks.new;
        self.tasks.existing += other.tasks.existing;
        self.projects.new += other.projects.new;
        self.projects.existing += other.projects.existing;
        self.detached_tasks += other.detached_tasks;
    }
}

/// 本文を順に送る（`dry_run` なら書かずに数だけ）。`progress` には、送り終えた行数と全体の行数を渡す。
/// 途中で断られたら、そこまでに入った行数を添えて Err にする（もう一度動かせば、残りだけが入る）
pub fn run_import(
    client: &ApiClient,
    chunks: &[ImportChunk],
    dry_run: bool,
    mut progress: impl FnMut(usize, usize),
) -> Result<ImportResponse, String> {
    let total: usize = chunks.iter().map(ImportChunk::rows).sum();
    let mut sum = ImportResponse::default();
    let mut done = 0;
    for chunk in chunks {
        let response = client.import(chunk, dry_run).map_err(|message| {
            if dry_run || done == 0 {
                message
            } else {
                fill(Msg::NetImportPartial, &[&message, &done])
            }
        })?;
        sum.add(&response);
        done += chunk.rows();
        progress(done, total);
    }
    Ok(sum)
}

#[derive(Default, Deserialize)]
struct ImportErrorBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(default)]
    issues: Vec<ImportIssue>,
}

#[derive(Deserialize)]
struct ImportIssue {
    path: Vec<serde_json::Value>,
    message: String,
}

/// 取り込みの 4xx を、利用者に見せる文言にする
fn import_rejection(status: u16, text: &str, chunk: &ImportChunk) -> String {
    match status {
        401 => t(Msg::CliLoginExpiredRelogin).to_string(),
        404 => t(Msg::NetImportUnsupported).to_string(),
        409 => match version_failure(text) {
            ApiFailure::ServerBehind => t(Msg::WaitingForWorker).to_string(),
            _ => crate::upgrade::upgrade_hint(),
        },
        413 => t(Msg::NetImportBodyTooLarge).to_string(),
        429 => t(Msg::NetImportRateLimited).to_string(),
        _ => {
            let body: ImportErrorBody = serde_json::from_str(text).unwrap_or_default();
            match body.reason.as_deref() {
                Some("quota_exceeded") => fill(
                    Msg::NetImportQuota,
                    &[&MAX_TASKS_PER_USER, &MAX_PROJECTS_PER_USER],
                ),
                Some("schema") => body
                    .issues
                    .first()
                    .map(|issue| rejected_row(issue, chunk))
                    .unwrap_or_else(|| t(Msg::NetImportSchemaFallback).to_string()),
                _ => fill(Msg::NetImportRejectedStatus, &[&status]),
            }
        }
    }
}

/// 形の誤りで断られた行を、この端末の何件目かで伝える
fn rejected_row(issue: &ImportIssue, chunk: &ImportChunk) -> String {
    let position = |kind: &str| {
        let index = issue.path.get(1).and_then(serde_json::Value::as_u64)? as usize;
        let offset = if kind == "projects" {
            chunk.project_offset
        } else {
            chunk.task_offset
        };
        Some(offset + index + 1)
    };
    let kind = issue.path.first().and_then(serde_json::Value::as_str);
    let field = issue.path.get(2).and_then(serde_json::Value::as_str);
    let place = match (kind, kind.and_then(position)) {
        (Some("projects"), Some(n)) => fill(Msg::NetImportPlaceProject, &[&n]),
        (Some("tasks"), Some(n)) => fill(Msg::NetImportPlaceTask, &[&n]),
        _ => t(Msg::NetImportPlaceData).to_string(),
    };
    match field {
        Some(field) => fill(
            Msg::NetImportRejectedField,
            &[&place, &field, &issue.message],
        ),
        None => fill(Msg::NetImportRejectedRow, &[&place, &issue.message]),
    }
}

/// 409 の本文（Worker が 409 を返すのは、API の版が受ける範囲の外のときだけ）
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionErrorBody {
    #[serde(default)]
    error: String,
    api_version: Option<u32>,
    min_api_version: Option<u32>,
}

/// 409 を、この nagi の更新が要るか、Worker の更新を待つかに分ける。範囲を返す前の Worker は
/// api_version_mismatch と自分の版（apiVersion）だけを返すので、この nagi の版と比べて決める
fn version_failure(text: &str) -> ApiFailure {
    let body: VersionErrorBody = serde_json::from_str(text).unwrap_or_default();
    match (body.error.as_str(), body.api_version) {
        ("api_version_too_new", _) => ApiFailure::ServerBehind,
        ("api_version_mismatch", Some(server)) if server < API_VERSION => ApiFailure::ServerBehind,
        ("api_version_mismatch", Some(server)) => ApiFailure::UpgradeRequired {
            min_api_version: server,
        },
        // api_version_unsupported。読めない本文も、この nagi が古いほうに倒す（止めて変更を持っておけば、何も失わない）
        _ => ApiFailure::UpgradeRequired {
            min_api_version: body.min_api_version.unwrap_or(API_VERSION + 1),
        },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版のずれの409は_本文でこのnagiが古いか新しいかに分ける() {
        assert_eq!(
            version_failure(
                r#"{"error":"api_version_unsupported","minApiVersion":4,"apiVersion":4,"releaseUrl":"https://github.com/myksyut/nagi/releases/latest"}"#
            ),
            ApiFailure::UpgradeRequired { min_api_version: 4 }
        );
        assert_eq!(
            version_failure(r#"{"error":"api_version_too_new","minApiVersion":2,"apiVersion":2}"#),
            ApiFailure::ServerBehind
        );
        // 範囲を返す前の Worker
        assert_eq!(
            version_failure(&format!(
                r#"{{"error":"api_version_mismatch","apiVersion":{}}}"#,
                API_VERSION - 1
            )),
            ApiFailure::ServerBehind
        );
        assert_eq!(
            version_failure(&format!(
                r#"{{"error":"api_version_mismatch","apiVersion":{}}}"#,
                API_VERSION + 1
            )),
            ApiFailure::UpgradeRequired {
                min_api_version: API_VERSION + 1
            }
        );
        assert_eq!(
            version_failure("not json"),
            ApiFailure::UpgradeRequired {
                min_api_version: API_VERSION + 1
            }
        );
    }
}
