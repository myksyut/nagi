//! 画面なしの使い方（CLI）。エージェントや定期の実行から、タスクを追加したり一覧を読んだりする。
//! データの決まり（置き場・並び順キー・締切で今日へ移すなど）は、画面と同じデータ層（Store）に任せる

use std::io::Write;
use std::process::ExitCode;
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::auth::{self, DevicePoll};
use crate::config::Config;
use crate::data::device::DeviceDb;
use crate::data::net::{ApiClient, NetEvent};
use crate::data::{
    AddTask, Destination, Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason,
    Store, open_store,
};
use crate::dates::{
    add_days, deadline_status, format_day_heading, format_short_date_with_weekday, parse_date_input,
};
use crate::model::{Bucket, ChecklistItem, POINTS, Priority, Task, TaskChanges};
use crate::ui::text::fold;

/// Worker の応答を待つ時間
const WAIT: Duration = Duration::from_secs(60);
/// 完了の一覧に出す日数（今日を含む）の既定
const DEFAULT_COMPLETED_DAYS: i64 = 14;

pub const HELP: &str = "\
nagi — ターミナルで使う TODO アプリ

ログインしなければ、データはこの端末だけに置く（ローカル）。ログインすると、クラウドと同期して使う。

使い方：
  nagi                       画面（TUI）を開く
  nagi add <タイトル> [...]  タスクを追加する（既定は受信箱）
  nagi list [リスト] [...]   タスクの一覧を出す
  nagi show <ID>             タスクを1件、詳しく出す
  nagi update <ID> [...]     既存のタスクに足す・属性を付ける
  nagi done <ID>             タスクを完了にする
  nagi projects              プロジェクトの一覧を出す
  nagi login                 ログインして、クラウドと同期する（GitHub のデバイスフロー。いまは招待した人だけ）
  nagi logout                ログアウトして、この端末のデータに戻る

add の指定：
  --memo <文字>              メモ
  --memo-file <ファイル>     メモをファイルから読む（外から拾った文章は、引数に入れずにこちらで渡す）
  --to <行き先>              inbox（既定）・today・later か、日付（予定へ。今日以前の日付なら今日へ）
  --project <名前>           プロジェクト（名前で指す。なければ失敗する）
  --deadline <日付>          締切
  --priority <high|medium|low>
  --points <1|2|3|5|8|13>
  --add-check <項目>         チェックリストの項目（何度でも書ける）

list の指定：
  リスト                     inbox・today・upcoming・later・completed・all（省くと未完了のすべて）
  --days <N>                 completed・all に出す完了の日数（今日を含む。既定は 14）

update の指定（足すものと属性だけ。タイトルの書き換え・メモの置き換え・チェックを外す・削除はできない）：
  --append-memo <文字>       メモの後ろに足す（同じ文字がすでにあれば足さない）
  --append-memo-file <ファイル>
                             足す文字をファイルから読む
  --add-check <項目>         チェックリストに項目を足す（同じ名前があれば足さない。何度でも書ける）
  --check <項目>             項目にチェックを付ける（名前か id。何度でも書ける）
  --to・--project・--deadline・--priority・--points
                             add と同じ。--project・--deadline・--priority・--points は none で外す
  --keep-existing            すでに値がある締切・優先度・工数・プロジェクトは変えない
  --if-unchanged-since <updatedAt>
                             読んだときの updatedAt と今が違えば、何も変えずに失敗する（done でも使える）

共通：
  --json                     結果を JSON で出す（add・list・show・update・done・projects）
  --server <URL>             接続する Worker（省くと環境変数 NAGI_SERVER。どちらもなければ、ログインしていれば本番、
                             していなければこの端末のデータ）
  -h, --help                 この説明（nagi help、nagi add --help でも同じ）
  -V, --version              版

日付は「2026-10-09」「明日」「金曜」「来週月曜」「3日後」「10/3」などで書ける。
ログインのトークンは、環境変数 NAGI_TOKEN でも渡せる。
画面のキーの一覧は、起動してから ? で見られる";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct AddArgs {
    pub title: String,
    pub memo: String,
    /// メモをファイルから読む（外から拾った文章を、シェルの引数に入れずに渡すため）
    pub memo_file: Option<String>,
    pub to: Option<String>,
    pub project: Option<String>,
    pub deadline: Option<String>,
    pub priority: Option<String>,
    pub points: Option<String>,
    /// 一緒に作るチェックリストの項目
    pub add_checks: Vec<String>,
    pub json: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListName {
    /// 未完了のすべて（受信箱・今日・予定・あとで）
    Open,
    Inbox,
    Today,
    Upcoming,
    Later,
    Completed,
    /// 未完了のすべてと、直近に完了したもの
    All,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ListArgs {
    pub list: ListName,
    pub days: i64,
    pub json: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ShowArgs {
    pub id: String,
    pub json: bool,
}

/// 既存のタスクへの変更。足すもの（メモの追記・チェックリストの項目）と、属性の設定だけ
/// （タイトルの書き換え・メモの置き換え・チェックを外す・削除は、ここからはできない）
#[derive(Debug, Default, PartialEq, Eq)]
pub struct UpdateArgs {
    pub id: String,
    pub append_memo: Option<String>,
    /// 追記する文字をファイルから読む
    pub append_memo_file: Option<String>,
    pub add_checks: Vec<String>,
    /// チェックを付ける項目（名前か id）
    pub checks: Vec<String>,
    pub to: Option<String>,
    pub project: Option<String>,
    pub deadline: Option<String>,
    pub priority: Option<String>,
    pub points: Option<String>,
    /// すでに値がある属性（締切・優先度・工数・プロジェクト）は変えない
    pub keep_existing: bool,
    /// 読んだときの updatedAt。今の値と違えば（ほかで変更されていたら）、何も変えない
    pub if_unchanged_since: Option<String>,
    pub json: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct DoneArgs {
    pub id: String,
    pub if_unchanged_since: Option<String>,
    pub json: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Tui,
    Help,
    Version,
    Add(AddArgs),
    List(ListArgs),
    Show(ShowArgs),
    Update(UpdateArgs),
    Done(DoneArgs),
    Projects { json: bool },
    Login,
    Logout,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub server: Option<String>,
    pub command: Command,
}

/// 値を取る指定
const VALUE_FLAGS: [&str; 14] = [
    "server",
    "memo",
    "to",
    "project",
    "deadline",
    "priority",
    "points",
    "days",
    "append-memo",
    "memo-file",
    "append-memo-file",
    "add-check",
    "check",
    "if-unchanged-since",
];
/// 値を取らない指定
const SWITCHES: [&str; 4] = ["json", "help", "version", "keep-existing"];

/// 指定の値を1つ取り出す（同じ指定が重なっていたら、最後のものを使う）
fn take(values: &mut Vec<(&str, String)>, name: &str) -> Option<String> {
    take_all(values, name).pop()
}

/// 指定の値をすべて取り出す（渡した順。何度も書ける指定のため）
fn take_all(values: &mut Vec<(&str, String)>, name: &str) -> Vec<String> {
    let mut taken = Vec::new();
    values.retain(|(flag, value)| {
        if *flag == name {
            taken.push(value.clone());
        }
        *flag != name
    });
    taken
}

/// タスクの id を1つだけ受け取る
fn single_id(command: &str, ids: &[&str]) -> Result<String, String> {
    match ids {
        [id] if !id.trim().is_empty() => Ok(id.trim().to_string()),
        _ => Err(format!("{command} には、タスクの id を1つ渡します")),
    }
}

/// 引数を読む。読めなければ、利用者に見せる文言を返す
pub fn parse(args: &[String]) -> Result<Invocation, String> {
    let mut positionals: Vec<&str> = Vec::new();
    let mut values: Vec<(&str, String)> = Vec::new();
    let mut switches: Vec<&str> = Vec::new();
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--" {
            // ここから先は、- で始まっていても指定として読まない（- で始まるタイトルなど）
            positionals.extend(rest.by_ref().map(String::as_str));
        } else if arg == "-h" {
            switches.push("help");
        } else if arg == "-V" {
            switches.push("version");
        } else if let Some(flag) = arg.strip_prefix("--") {
            let (name, inline) = match flag.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (flag, None),
            };
            if VALUE_FLAGS.contains(&name) {
                let value = match inline {
                    Some(value) => value,
                    None => rest
                        .next()
                        .cloned()
                        .ok_or(format!("--{name} には値が要ります"))?,
                };
                values.push((name, value));
            } else if SWITCHES.contains(&name) && inline.is_none() {
                switches.push(name);
            } else {
                return Err(format!("知らない指定です：{arg}"));
            }
        } else {
            positionals.push(arg);
        }
    }
    if switches.contains(&"help") {
        return Ok(Invocation {
            server: None,
            command: Command::Help,
        });
    }
    if switches.contains(&"version") {
        return Ok(Invocation {
            server: None,
            command: Command::Version,
        });
    }

    let values = &mut values;
    let server = take(values, "server");
    let json = switches.contains(&"json");
    let keep_existing = switches.contains(&"keep-existing");
    let command = match positionals.split_first() {
        None => Command::Tui,
        Some((&"help", _)) => Command::Help,
        Some((&"add", titles)) => {
            let [title] = titles else {
                return Err(
                    "add には、タイトルを1つ渡します（空白を含むときは引用符で囲む）".to_string(),
                );
            };
            if title.trim().is_empty() {
                return Err("タイトルが空です".to_string());
            }
            Command::Add(AddArgs {
                title: title.trim().to_string(),
                memo: take(values, "memo").unwrap_or_default(),
                memo_file: take(values, "memo-file"),
                to: take(values, "to"),
                project: take(values, "project"),
                deadline: take(values, "deadline"),
                priority: take(values, "priority"),
                points: take(values, "points"),
                add_checks: take_all(values, "add-check"),
                json,
            })
        }
        Some((&"list", names)) => {
            let list = match names {
                [] => ListName::Open,
                [name] => list_name(name).ok_or(format!(
                    "知らないリストです：{name}（inbox・today・upcoming・later・completed・all）"
                ))?,
                _ => return Err("list に渡せるリストは1つです".to_string()),
            };
            let days = match take(values, "days") {
                None => DEFAULT_COMPLETED_DAYS,
                Some(text) => text
                    .parse::<i64>()
                    .ok()
                    .filter(|days| (1..=3660).contains(days))
                    .ok_or(format!("--days は 1 以上の数で渡します：{text}"))?,
            };
            Command::List(ListArgs { list, days, json })
        }
        Some((&"show", ids)) => Command::Show(ShowArgs {
            id: single_id("show", ids)?,
            json,
        }),
        Some((&"update", ids)) => Command::Update(UpdateArgs {
            id: single_id("update", ids)?,
            append_memo: take(values, "append-memo"),
            append_memo_file: take(values, "append-memo-file"),
            add_checks: take_all(values, "add-check"),
            checks: take_all(values, "check"),
            to: take(values, "to"),
            project: take(values, "project"),
            deadline: take(values, "deadline"),
            priority: take(values, "priority"),
            points: take(values, "points"),
            keep_existing,
            if_unchanged_since: take(values, "if-unchanged-since"),
            json,
        }),
        Some((&"done", ids)) => Command::Done(DoneArgs {
            id: single_id("done", ids)?,
            if_unchanged_since: take(values, "if-unchanged-since"),
            json,
        }),
        Some((&"projects", [])) => Command::Projects { json },
        Some((&"login", [])) => Command::Login,
        Some((&"logout", [])) => Command::Logout,
        Some((&("projects" | "login" | "logout"), _)) => {
            return Err("projects・login・logout には、ほかの引数を渡せません".to_string());
        }
        Some((other, _)) => return Err(format!("知らないコマンドです：{other}")),
    };
    // そのコマンドで使わない指定が残っていたら、黙って捨てずに断る
    if let Some((name, _)) = values.first() {
        return Err(format!("ここでは使えない指定です：--{name}"));
    }
    if json && matches!(command, Command::Tui | Command::Login | Command::Logout) {
        return Err("--json は、ここでは使えません".to_string());
    }
    if keep_existing && !matches!(command, Command::Update(_)) {
        return Err("--keep-existing は update で使えます".to_string());
    }
    Ok(Invocation { server, command })
}

fn list_name(name: &str) -> Option<ListName> {
    Some(match name {
        "inbox" | "受信箱" => ListName::Inbox,
        "today" | "今日" => ListName::Today,
        "upcoming" | "予定" => ListName::Upcoming,
        "later" | "あとで" => ListName::Later,
        "completed" | "完了" => ListName::Completed,
        "open" => ListName::Open,
        "all" | "すべて" => ListName::All,
        _ => return None,
    })
}

/// 標準出力へ1行書く。パイプの先が先に閉じたとき（`| head` など）は、黙って終わる
/// （println! は、そのとき異常終了してしまう）
pub fn emit(text: &str) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{text}").is_err() {
        std::process::exit(0);
    }
}

macro_rules! emit {
    ($($arg:tt)*) => {
        emit(&format!($($arg)*))
    };
}

// --- Worker とのやり取り ----------------------------------------------------------------

/// ストアと、通信の結果を受け取る口。CLI は、結果が届くまでその場で待つ
struct Session {
    store: Store,
    events: Receiver<NetEvent>,
    server: String,
}

impl Session {
    fn open(config: &Config) -> Result<Session, String> {
        let token = config.load_token();
        // Worker を名指ししたのにログインがない（この端末だけで使うときは、ログインは要らない）
        if config.is_cloud() && token.is_none() && !config.is_dev_server() {
            return Err("ログインしていません。先に `nagi login` を実行してください".to_string());
        }
        let user_id = auth::current_user_id(config);
        let (sender, events) = channel();
        let store = open_store(config, token, user_id.as_deref(), move |event| {
            let _ = sender.send(event);
        })?;
        Ok(Session {
            store,
            events,
            server: if config.is_cloud() {
                config.server.clone()
            } else {
                "この端末のデータ".to_string()
            },
        })
    }

    /// 止まった理由や保存の失敗があれば、その文言を返す
    fn check(&mut self) -> Result<(), String> {
        match self.store.stopped_by {
            Some(StopReason::Unauthorized) => {
                return Err(
                    "ログインが切れています。`nagi login` でログインし直してください".to_string(),
                );
            }
            Some(StopReason::VersionMismatch) => {
                return Err(
                    "この nagi は古くて、Worker とやり取りできません。新しい版に更新してください"
                        .to_string(),
                );
            }
            None => {}
        }
        for notice in self.store.take_notices() {
            match notice {
                Notice::SaveFailed { reason, .. } => {
                    return Err(match reason {
                        SaveFailure::Network => {
                            format!("保存できませんでした（{} に接続できません）", self.server)
                        }
                        SaveFailure::Conflict => {
                            "ほかの画面で先に変更されていたため、保存できませんでした".to_string()
                        }
                        SaveFailure::Rejected => {
                            "保存できませんでした（Worker に受け付けられませんでした）".to_string()
                        }
                    });
                }
                Notice::OfflineBlocked { .. } => {
                    return Err(format!("{} に接続できません", self.server));
                }
                Notice::Unauthorized { .. } | Notice::VersionMismatch { .. } => {}
            }
        }
        Ok(())
    }

    /// done になるまで、通信の結果を受け取ってストアへ届ける
    fn pump(&mut self, done: impl Fn(&Store) -> bool) -> Result<(), String> {
        while !done(&self.store) {
            match self.events.recv_timeout(WAIT) {
                Ok(NetEvent::MutateDone { batch_id, result }) => {
                    self.store.on_mutate_done(&batch_id, result);
                }
                Ok(NetEvent::SyncDone(result)) => self.store.on_sync_done(result),
                Err(_) => return Err(format!("{} からの応答がありません", self.server)),
            }
            self.check()?;
        }
        Ok(())
    }

    /// 差分を取って、手元を最新にする
    fn sync(&mut self) -> Result<(), String> {
        self.store.sync();
        self.pump(|store| !store.is_syncing())?;
        if !self.store.synced {
            return Err(format!("{} に接続できませんでした", self.server));
        }
        Ok(())
    }

    /// 送信中の操作が、すべて保存されるまで待つ
    fn flush(&mut self) -> Result<(), String> {
        self.pump(|store| store.pending_count() == 0)
    }
}

/// 受け付けられなかった操作の文言。変えるものがなかったときは、失敗にしない
fn accepted(result: OpResult) -> Result<(), String> {
    match result {
        Ok(_) | Err(Failure::Noop) => Ok(()),
        Err(Failure::Offline) => Err("Worker に接続できません".to_string()),
        Err(Failure::Stopped) => {
            Err("ログインが切れているか、nagi の版が古くて送れません".to_string())
        }
        Err(_) => Err("受け付けられない内容です".to_string()),
    }
}

fn parse_date(text: &str, today: &str, what: &str) -> Result<String, String> {
    parse_date_input(text, today).ok_or(format!("{what}を日付として読めません：{text}"))
}

fn parse_destination(text: &str, today: &str) -> Result<Destination, String> {
    Ok(match text {
        "inbox" | "受信箱" => Destination::Inbox,
        "today" | "今日" => Destination::Today,
        "later" | "あとで" => Destination::Later,
        date => Destination::Scheduled(parse_date(date, today, "行き先")?),
    })
}

fn parse_priority(text: &str) -> Result<Priority, String> {
    Ok(match text {
        "high" | "高" => Priority::High,
        "medium" | "中" => Priority::Medium,
        "low" | "低" => Priority::Low,
        _ => return Err(format!("優先度は high・medium・low で渡します：{text}")),
    })
}

fn parse_points(text: &str) -> Result<u8, String> {
    text.parse::<u8>()
        .ok()
        .filter(|points| POINTS.contains(points))
        .ok_or(format!(
            "工数は 1・2・3・5・8・13 のどれかで渡します：{text}"
        ))
}

/// 名前でプロジェクトを探す（全角・半角と大文字・小文字の違いは吸収する。アーカイブ済みは対象にしない）
fn find_project(store: &Store, name: &str) -> Result<String, String> {
    let lists = store.lists();
    let names: Vec<(&String, &str)> = lists
        .projects
        .iter()
        .filter_map(|id| Some((id, store.replica.project(id)?.name.as_str())))
        .collect();
    match names
        .iter()
        .find(|(_, other)| fold(other) == fold(name.trim()))
    {
        Some((id, _)) => Ok((*id).clone()),
        None => Err(format!(
            "プロジェクト「{name}」がありません（今あるもの：{}）",
            if names.is_empty() {
                "なし".to_string()
            } else {
                names
                    .iter()
                    .map(|(_, name)| *name)
                    .collect::<Vec<_>>()
                    .join("・")
            }
        )),
    }
}

/// タスクが今あるリストの名前（JSON 用、表示用）
fn list_of(task: &Task) -> (&'static str, &'static str) {
    if task.is_completed() {
        return ("completed", "完了");
    }
    match task.bucket {
        Bucket::Inbox => ("inbox", "受信箱"),
        Bucket::Today => ("today", "今日"),
        Bucket::Scheduled => ("upcoming", "予定"),
        Bucket::Later => ("later", "あとで"),
    }
}

fn task_json(store: &Store, task: &Task) -> Value {
    let project = task
        .project_id
        .as_deref()
        .and_then(|id| store.replica.project(id))
        .filter(|project| project.deleted_at.is_none())
        .map(|project| project.name.clone());
    json!({
        "id": task.id,
        "title": task.title,
        "memo": task.memo,
        "list": list_of(task).0,
        "scheduledOn": task.scheduled_on,
        "deadlineOn": task.deadline_on,
        "project": project,
        "priority": task.priority,
        "points": task.points,
        "inProgress": task.is_in_progress(),
        "checklist": task.checklist.iter().map(|item| json!({ "id": item.id, "title": item.title, "done": item.done })).collect::<Vec<_>>(),
        "createdAt": task.created_at,
        "updatedAt": task.updated_at,
        "completedAt": task.completed_at,
    })
}

/// 人が読むための1行
fn task_line(store: &Store, task: &Task) -> String {
    let today = &store.today;
    let glyph = if task.is_completed() {
        "●"
    } else if task.is_in_progress() {
        "◐"
    } else {
        "○"
    };
    let mut meta: Vec<String> = Vec::new();
    if !task.is_completed() {
        if let Some(on) = &task.scheduled_on {
            meta.push(format_short_date_with_weekday(on, today));
        }
        if let Some(on) = &task.deadline_on {
            meta.push(deadline_status(on, today).1);
        }
    }
    if let Some(project) = task
        .project_id
        .as_deref()
        .and_then(|id| store.replica.project(id))
        .filter(|project| project.deleted_at.is_none())
    {
        meta.push(project.name.clone());
    }
    if let Some(priority) = task.priority {
        meta.push(format!("優先度 {}", priority.label()));
    }
    if let Some(points) = task.points {
        meta.push(format!("{points}pt"));
    }
    if meta.is_empty() {
        format!("  {glyph} {}", task.title)
    } else {
        format!("  {glyph} {}  （{}）", task.title, meta.join("・"))
    }
}

// --- 既存のタスクへ足す変更の計算 --------------------------------------------------------

/// メモに追記したあとのメモ。空の行をはさんで後ろに足す。追記する文字がすでにメモの中にあれば、
/// 足さない（None。同じ追記をやり直しても重ならないように）
fn appended_memo(memo: &str, addition: &str) -> Option<String> {
    let addition = addition.trim();
    if addition.is_empty() || memo.contains(addition) {
        return None;
    }
    let body = memo.trim_end();
    Some(if body.is_empty() {
        addition.to_string()
    } else {
        format!("{body}\n\n{addition}")
    })
}

/// チェックリストに項目を足す。同じ名前（全角・半角と大文字・小文字の違いは吸収）の項目があれば足さない
fn with_added_checks(
    checklist: &[ChecklistItem],
    titles: &[String],
    mut new_id: impl FnMut() -> String,
) -> Vec<ChecklistItem> {
    let mut next = checklist.to_vec();
    for title in titles {
        let title = title.trim();
        if title.is_empty() || next.iter().any(|item| fold(&item.title) == fold(title)) {
            continue;
        }
        next.push(ChecklistItem {
            id: new_id(),
            title: title.to_string(),
            done: false,
        });
    }
    next
}

/// 項目（名前か id で指す）にチェックを付ける。見つからなければ失敗。外すことはしない
fn with_checked(
    checklist: &[ChecklistItem],
    keys: &[String],
) -> Result<Vec<ChecklistItem>, String> {
    let mut next = checklist.to_vec();
    for key in keys {
        let matches =
            |item: &ChecklistItem| item.id == *key || fold(&item.title) == fold(key.trim());
        // 同じ名前の項目がいくつかあれば、まだチェックの付いていないものから
        let index = next
            .iter()
            .position(|item| matches(item) && !item.done)
            .or_else(|| next.iter().position(matches))
            .ok_or(format!("チェックリストに、その項目がありません：{key}"))?;
        next[index].done = true;
    }
    Ok(next)
}

/// 文字を、引数かファイルのどちらかから受け取る（両方は渡せない）。
/// ファイルから渡すのは、外から拾った文章を、シェルの引数に入れないため（`$(…)` などが実行されないように）
fn text_or_file(
    text: Option<&str>,
    file: Option<&str>,
    flag: &str,
) -> Result<Option<String>, String> {
    match (text, file) {
        (Some(_), Some(_)) => Err(format!(
            "--{flag} と --{flag}-file は、どちらか一方だけ渡します"
        )),
        (Some(text), None) => Ok(Some(text.to_string())),
        (None, Some(path)) => std::fs::read_to_string(path)
            .map(|text| Some(text.trim_end().to_string()))
            .map_err(|error| format!("ファイルを読めません：{path}（{error}）")),
        (None, None) => Ok(None),
    }
}

/// 「none」（なし）なら None、それ以外は読んだ値
fn optional<T>(
    text: &str,
    read: impl FnOnce(&str) -> Result<T, String>,
) -> Result<Option<T>, String> {
    match text {
        "none" | "なし" => Ok(None),
        other => read(other).map(Some),
    }
}

/// id のタスク（削除済みは、ないものとして扱う）
fn find_task(store: &Store, id: &str) -> Result<Task, String> {
    store
        .replica
        .task(id)
        .filter(|task| task.deleted_at.is_none())
        .cloned()
        .ok_or(format!("タスクが見つかりません：{id}"))
}

/// 読んだときから変わっていないかを確かめる（ほかの画面での手動の変更を、上書きしないため）
fn ensure_unchanged(task: &Task, expected: Option<&str>) -> Result<(), String> {
    match expected {
        Some(expected) if expected != task.updated_at => Err(format!(
            "ほかで変更されています（今の updatedAt は {}）。読み直してから、もう一度実行してください",
            task.updated_at
        )),
        _ => Ok(()),
    }
}

/// 人が読むための詳細
fn task_detail(store: &Store, task: &Task) -> String {
    let today = &store.today;
    let mut lines = vec![task.title.clone()];
    let state = if task.is_in_progress() {
        "（進行中）"
    } else {
        ""
    };
    lines.push(format!("  リスト：{}{state}", list_of(task).1));
    if let Some(on) = &task.scheduled_on {
        lines.push(format!(
            "  予定：{}",
            format_short_date_with_weekday(on, today)
        ));
    }
    if let Some(on) = &task.deadline_on {
        lines.push(format!(
            "  締切：{}（{}）",
            format_short_date_with_weekday(on, today),
            deadline_status(on, today).1
        ));
    }
    if let Some(project) = task
        .project_id
        .as_deref()
        .and_then(|id| store.replica.project(id))
        .filter(|project| project.deleted_at.is_none())
    {
        lines.push(format!("  プロジェクト：{}", project.name));
    }
    if let Some(priority) = task.priority {
        lines.push(format!("  優先度：{}", priority.label()));
    }
    if let Some(points) = task.points {
        lines.push(format!("  工数：{points}"));
    }
    lines.push(format!("  id：{}", task.id));
    lines.push(format!("  更新：{}", task.updated_at));
    if !task.memo.trim().is_empty() {
        lines.push("メモ：".to_string());
        lines.extend(task.memo.lines().map(|line| format!("  {line}")));
    }
    if !task.checklist.is_empty() {
        lines.push("チェックリスト：".to_string());
        lines.extend(
            task.checklist
                .iter()
                .map(|item| format!("  {} {}", if item.done { "☑" } else { "☐" }, item.title)),
        );
    }
    lines.join("\n")
}

// --- コマンド ---------------------------------------------------------------------------

fn add(config: &Config, args: AddArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    // 追加する前に、指定をすべて確かめる（途中まで追加して止まらないように）
    let today = session.store.today.clone();
    let to = match &args.to {
        None => Destination::Inbox,
        Some(text) => parse_destination(text, &today)?,
    };
    let project_id = match &args.project {
        None => None,
        Some(name) => Some(find_project(&session.store, name)?),
    };
    let deadline = match &args.deadline {
        None => None,
        Some(text) => Some(parse_date(text, &today, "締切")?),
    };
    let priority = args.priority.as_deref().map(parse_priority).transpose()?;
    let points = args.points.as_deref().map(parse_points).transpose()?;
    let memo = text_or_file(
        Some(args.memo.as_str()).filter(|memo| !memo.is_empty()),
        args.memo_file.as_deref(),
        "memo",
    )?
    .unwrap_or_default();

    let done = session.store.add_task(AddTask {
        title: args.title,
        memo,
        project_id,
        to,
    });
    let id = match done {
        Ok(done) => done.ids[0].clone(),
        Err(failure) => {
            accepted(Err(failure))?;
            return Err("追加できませんでした".to_string());
        }
    };
    let ids = [id.clone()];
    if let Some(deadline) = &deadline {
        accepted(session.store.set_deadline(&ids, Some(deadline)))?;
    }
    if priority.is_some() {
        accepted(session.store.set_priority(&ids, priority))?;
    }
    if points.is_some() {
        accepted(session.store.set_points(&ids, points))?;
    }
    if !args.add_checks.is_empty() {
        let store = &mut session.store;
        let checklist = with_added_checks(&[], &args.add_checks, || store.new_id());
        accepted(store.update_task(
            &id,
            TaskChanges {
                checklist: Some(checklist),
                ..Default::default()
            },
            PerformOptions::default(),
        ))?;
    }
    session.flush()?;

    let store = &session.store;
    let task = store
        .replica
        .task(&id)
        .ok_or("追加したタスクが見つかりません")?;
    if args.json {
        emit!("{}", task_json(store, task));
    } else {
        emit!("{}に追加しました：{}", list_of(task).1, task.title);
    }
    Ok(())
}

fn list(config: &Config, args: ListArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    let store = &session.store;
    let lists = store.lists();
    // 見出しと、その中のタスク（上から出す順）
    let mut groups: Vec<(String, Vec<&String>)> = Vec::new();
    for (name, label, ids) in [
        (ListName::Inbox, "受信箱", &lists.inbox),
        (ListName::Today, "今日", &lists.today),
        (ListName::Upcoming, "予定", &lists.scheduled),
        (ListName::Later, "あとで", &lists.later),
    ] {
        if matches!(args.list, ListName::Open | ListName::All) || args.list == name {
            groups.push((label.to_string(), ids.iter().collect()));
        }
    }
    if matches!(args.list, ListName::Completed | ListName::All) {
        // 今日を含む days 日ぶん（論理日付）
        let since = add_days(&store.today, -(args.days - 1));
        groups.push((
            format!("{}（今日）", format_day_heading(&store.today, &store.today)),
            lists.completed_today.iter().collect(),
        ));
        for day in lists.logbook.iter().filter(|day| day.date >= since) {
            groups.push((
                format_day_heading(&day.date, &store.today),
                day.tasks.iter().collect(),
            ));
        }
    }
    let task = |id: &&String| store.replica.task(id);
    if args.json {
        let tasks: Vec<Value> = groups
            .iter()
            .flat_map(|(_, ids)| ids.iter().filter_map(task))
            .map(|task| task_json(store, task))
            .collect();
        emit!("{}", Value::Array(tasks));
        return Ok(());
    }
    let mut any = false;
    for (label, ids) in &groups {
        if ids.is_empty() {
            continue;
        }
        if any {
            emit("");
        }
        any = true;
        emit!("{label}（{}）", ids.len());
        for task in ids.iter().filter_map(task) {
            emit!("{}", task_line(store, task));
        }
    }
    if !any {
        emit!("タスクはありません");
    }
    Ok(())
}

fn show(config: &Config, args: ShowArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    let store = &session.store;
    let task = find_task(store, &args.id)?;
    if args.json {
        emit!("{}", task_json(store, &task));
    } else {
        emit!("{}", task_detail(store, &task));
    }
    Ok(())
}

fn update(config: &Config, args: UpdateArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    let store = &mut session.store;
    let task = find_task(store, &args.id)?;
    ensure_unchanged(&task, args.if_unchanged_since.as_deref())?;
    // 変える前に、指定をすべて確かめる（途中まで変えて止まらないように）
    let today = store.today.clone();
    let keep = args.keep_existing;
    let mut changes = TaskChanges::default();
    let addition = text_or_file(
        args.append_memo.as_deref(),
        args.append_memo_file.as_deref(),
        "append-memo",
    )?;
    if let Some(addition) = &addition {
        changes.memo = appended_memo(&task.memo, addition);
    }
    if !args.add_checks.is_empty() || !args.checks.is_empty() {
        let added = with_added_checks(&task.checklist, &args.add_checks, || store.new_id());
        changes.checklist = Some(with_checked(&added, &args.checks)?);
    }
    if let Some(text) = &args.priority
        && !(keep && task.priority.is_some())
    {
        changes.priority = Some(optional(text, parse_priority)?);
    }
    if let Some(text) = &args.points
        && !(keep && task.points.is_some())
    {
        changes.points = Some(optional(text, parse_points)?);
    }
    if let Some(name) = &args.project
        && !(keep && task.project_id.is_some())
    {
        changes.project_id = Some(optional(name, |name| find_project(store, name))?);
    }
    let deadline = match &args.deadline {
        Some(text) if !(keep && task.deadline_on.is_some()) => {
            Some(optional(text, |text| parse_date(text, &today, "締切"))?)
        }
        _ => None,
    };
    let to = args
        .to
        .as_deref()
        .map(|text| parse_destination(text, &today))
        .transpose()?;

    let ids = [task.id.clone()];
    if !changes.is_empty() {
        accepted(store.update_task(&task.id, changes, PerformOptions::default()))?;
    }
    if let Some(deadline) = &deadline {
        accepted(store.set_deadline(&ids, deadline.as_deref()))?;
    }
    if let Some(to) = to {
        accepted(store.move_tasks(&ids, to))?;
    }
    let changed = session.store.pending_count() > 0;
    session.flush()?;

    let store = &session.store;
    let after = find_task(store, &args.id)?;
    if args.json {
        emit!("{}", task_json(store, &after));
    } else if changed {
        emit!("更新しました：{}", after.title);
    } else {
        emit!("変更はありません：{}", after.title);
    }
    Ok(())
}

fn done(config: &Config, args: DoneArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    let task = find_task(&session.store, &args.id)?;
    ensure_unchanged(&task, args.if_unchanged_since.as_deref())?;
    let already = task.is_completed();
    if !already {
        accepted(session.store.complete_tasks(std::slice::from_ref(&task.id)))?;
        session.flush()?;
    }
    let store = &session.store;
    let after = find_task(store, &args.id)?;
    if args.json {
        emit!("{}", task_json(store, &after));
    } else if already {
        emit!("すでに完了しています：{}", after.title);
    } else {
        emit!("完了にしました：{}", after.title);
    }
    Ok(())
}

/// プロジェクトの一覧（アーカイブ済み・削除済みを除く。作成順）
fn projects(config: &Config, json: bool) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync()?;
    let store = &session.store;
    let lists = store.lists();
    let rows: Vec<(&String, &str, usize)> = lists
        .projects
        .iter()
        .filter_map(|id| {
            let project = store.replica.project(id)?;
            Some((id, project.name.as_str(), lists.project(id).open_count()))
        })
        .collect();
    if json {
        let values: Vec<Value> = rows
            .iter()
            .map(|(id, name, open)| json!({ "id": id, "name": name, "open": open }))
            .collect();
        emit!("{}", Value::Array(values));
    } else if rows.is_empty() {
        emit!("プロジェクトはありません");
    } else {
        for (_, name, open) in rows {
            emit!("{name}（未完了 {open}）");
        }
    }
    Ok(())
}

/// ログイン。URL とコードを出し、承認されるまで待つ
fn login(config: &Config) -> Result<(), String> {
    let client = ApiClient::new(&config.server, None);
    let start = auth::start(&client)?;
    emit!("1. ブラウザでこの URL を開く：{}", start.verification_uri);
    emit!("2. このコードを入力して、承認する：{}", start.user_code);
    emit!("承認を待っています…（ここに出たコード以外は、承認しないでください）");
    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    let mut interval = start.interval.max(1);
    loop {
        thread::sleep(Duration::from_secs(interval));
        if Instant::now() >= deadline {
            return Err("コードの期限が切れました。もう一度やり直してください".to_string());
        }
        match auth::poll(&client, &start.device_code) {
            // 通信のつまずきは、次の回でもう一度確かめる
            Ok(DevicePoll::Pending) | Err(_) => {}
            Ok(DevicePoll::SlowDown(next)) => interval = next.max(interval + 1),
            Ok(DevicePoll::Ok { token, user_id }) => {
                config
                    .save_session(&token, user_id.as_deref())
                    .map_err(|error| format!("トークンを保存できませんでした：{error}"))?;
                emit!("ログインしました。クラウドと同期します");
                // この端末だけで使っていたときのデータは、そのまま残る（クラウドへは移さない）
                let left = DeviceDb::open(&config.device_db_path())
                    .ok()
                    .and_then(|db| db.count().ok())
                    .unwrap_or(0);
                if left > 0 {
                    emit!(
                        "この端末のタスクとプロジェクト（{left} 件）はそのまま残り、`nagi logout` で戻ります"
                    );
                }
                return Ok(());
            }
            Ok(DevicePoll::Expired) => {
                return Err("コードの期限が切れました。もう一度やり直してください".to_string());
            }
            Ok(DevicePoll::Denied) => return Err("GitHub で承認されませんでした".to_string()),
            Ok(DevicePoll::Forbidden) => {
                return Err(
                    "この GitHub アカウントは、まだクラウドとの同期に招待されていません"
                        .to_string(),
                );
            }
        }
    }
}

/// ログアウト。Worker のセッションを消し、手元のトークンと控えも消す
fn logout(config: &Config) -> Result<(), String> {
    match config.saved_session() {
        Some(session) => {
            // 持ち主の分からないログイン（利用者の ID を返さないころのもの）は、消す前に聞いておく（どの控えかを決めるため）
            let user_id = session
                .user_id
                .clone()
                .or_else(|| auth::current_user_id(config));
            auth::logout(&ApiClient::new(&config.server, Some(session.token)));
            config.clear_token();
            config.remove_db(user_id.as_deref());
            if config.is_cloud() {
                emit!("ログアウトしました");
            } else {
                emit!("ログアウトしました。このあとは、この端末のデータを使います");
            }
        }
        None => emit!("ログインしていません"),
    }
    Ok(())
}

/// 画面なしのコマンドを実行する
pub fn run(config: &Config, command: Command) -> ExitCode {
    let result = match command {
        Command::Add(args) => add(config, args),
        Command::List(args) => list(config, args),
        Command::Show(args) => show(config, args),
        Command::Update(args) => update(config, args),
        Command::Done(args) => done(config, args),
        Command::Projects { json } => projects(config, json),
        Command::Login => login(config),
        Command::Logout => logout(config),
        Command::Tui | Command::Help | Command::Version => Ok(()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed(args: &[&str]) -> Result<Invocation, String> {
        parse(&args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>())
    }

    fn command(args: &[&str]) -> Command {
        parsed(args).unwrap().command
    }

    #[test]
    fn 引数がなければ画面を開く() {
        assert_eq!(command(&[]), Command::Tui);
        let with_server = parsed(&["--server", "http://localhost:5317"]).unwrap();
        assert_eq!(with_server.server.as_deref(), Some("http://localhost:5317"));
        assert_eq!(with_server.command, Command::Tui);
        assert_eq!(command(&["-h"]), Command::Help);
        assert_eq!(command(&["--help"]), Command::Help);
        assert_eq!(command(&["help"]), Command::Help);
        assert_eq!(command(&["add", "--help"]), Command::Help);
        assert_eq!(command(&["add", "x", "--version"]), Command::Version);
    }

    #[test]
    fn add_は_タイトルと指定を読む() {
        assert_eq!(
            command(&["add", " 見積もりを確認 "]),
            Command::Add(AddArgs {
                title: "見積もりを確認".into(),
                ..Default::default()
            })
        );
        // 指定は、タイトルの前でも後でも、= でつないでもよい
        assert_eq!(
            command(&[
                "--server=http://localhost:5317",
                "add",
                "--memo",
                "Slack のスレッド\nhttps://example.com",
                "PR のレビュー",
                "--to=today",
                "--project",
                "AIPR",
                "--deadline",
                "金曜",
                "--priority=high",
                "--points",
                "3",
                "--json",
            ]),
            Command::Add(AddArgs {
                title: "PR のレビュー".into(),
                memo: "Slack のスレッド\nhttps://example.com".into(),
                memo_file: None,
                to: Some("today".into()),
                project: Some("AIPR".into()),
                deadline: Some("金曜".into()),
                priority: Some("high".into()),
                points: Some("3".into()),
                add_checks: vec![],
                json: true,
            })
        );
        // チェックリストの項目は、何度でも書ける（書いた順）
        assert_eq!(
            command(&[
                "add",
                "納品",
                "--add-check",
                "見積もり",
                "--add-check=請求書"
            ]),
            Command::Add(AddArgs {
                title: "納品".into(),
                add_checks: vec!["見積もり".into(), "請求書".into()],
                ..Default::default()
            })
        );
        // -- のあとは、- で始まっていてもタイトル
        assert_eq!(
            command(&["add", "--", "--force を外す"]),
            Command::Add(AddArgs {
                title: "--force を外す".into(),
                ..Default::default()
            })
        );
    }

    #[test]
    fn add_の読めない引数は断る() {
        assert!(parsed(&["add"]).is_err());
        assert!(parsed(&["add", "  "]).is_err());
        assert!(parsed(&["add", "引用符で", "囲んでいない"]).is_err());
        assert!(parsed(&["add", "x", "--memo"]).is_err());
        assert!(parsed(&["add", "x", "--days", "3"]).is_err());
        assert!(parsed(&["add", "x", "--unknown"]).is_err());
    }

    #[test]
    fn list_は_リストと日数を読む() {
        assert_eq!(
            command(&["list"]),
            Command::List(ListArgs {
                list: ListName::Open,
                days: DEFAULT_COMPLETED_DAYS,
                json: false
            })
        );
        assert_eq!(
            command(&["list", "受信箱", "--json"]),
            Command::List(ListArgs {
                list: ListName::Inbox,
                days: DEFAULT_COMPLETED_DAYS,
                json: true
            })
        );
        assert_eq!(
            command(&["list", "completed", "--days", "3"]),
            Command::List(ListArgs {
                list: ListName::Completed,
                days: 3,
                json: false
            })
        );
        assert!(parsed(&["list", "somewhere"]).is_err());
        assert!(parsed(&["list", "--days", "0"]).is_err());
        assert!(parsed(&["list", "--memo", "x"]).is_err());
    }

    #[test]
    fn show_と_update_と_done_は_id_と指定を読む() {
        assert_eq!(
            command(&["show", "0199-aaaa", "--json"]),
            Command::Show(ShowArgs {
                id: "0199-aaaa".into(),
                json: true
            })
        );
        assert_eq!(
            command(&[
                "update",
                "0199-aaaa",
                "--append-memo",
                "10/6 Slack で再依頼",
                "--add-check",
                "見積もりを送る",
                "--check",
                "下書き",
                "--check",
                "c-2",
                "--points",
                "3",
                "--deadline=none",
                "--keep-existing",
                "--if-unchanged-since",
                "2026-10-06T01:02:03.000Z",
            ]),
            Command::Update(UpdateArgs {
                id: "0199-aaaa".into(),
                append_memo: Some("10/6 Slack で再依頼".into()),
                add_checks: vec!["見積もりを送る".into()],
                checks: vec!["下書き".into(), "c-2".into()],
                points: Some("3".into()),
                deadline: Some("none".into()),
                keep_existing: true,
                if_unchanged_since: Some("2026-10-06T01:02:03.000Z".into()),
                ..Default::default()
            })
        );
        assert_eq!(
            command(&["done", "0199-aaaa"]),
            Command::Done(DoneArgs {
                id: "0199-aaaa".into(),
                if_unchanged_since: None,
                json: false
            })
        );
        assert_eq!(
            command(&["projects", "--json"]),
            Command::Projects { json: true }
        );
        assert_eq!(
            command(&["list", "all"]),
            Command::List(ListArgs {
                list: ListName::All,
                days: DEFAULT_COMPLETED_DAYS,
                json: false
            })
        );
        // メモは、ファイルからも渡せる
        assert_eq!(
            command(&["add", "x", "--memo-file", "memo.txt"]),
            Command::Add(AddArgs {
                title: "x".into(),
                memo_file: Some("memo.txt".into()),
                ..Default::default()
            })
        );
        assert_eq!(
            command(&["update", "a", "--append-memo-file=add.txt"]),
            Command::Update(UpdateArgs {
                id: "a".into(),
                append_memo_file: Some("add.txt".into()),
                ..Default::default()
            })
        );
        assert_eq!(
            text_or_file(Some("直接"), None, "memo"),
            Ok(Some("直接".to_string()))
        );
        assert!(text_or_file(Some("直接"), Some("memo.txt"), "memo").is_err());
        assert!(text_or_file(None, Some("/nonexistent/memo.txt"), "memo").is_err());
        assert_eq!(text_or_file(None, None, "memo"), Ok(None));
        // id は1つだけ。update で使えない指定（メモの置き換えなど）は断る
        assert!(parsed(&["update"]).is_err());
        assert!(parsed(&["done", "a", "b"]).is_err());
        assert!(parsed(&["update", "a", "--memo", "置き換え"]).is_err());
        assert!(parsed(&["add", "x", "--keep-existing"]).is_err());
        assert!(parsed(&["show", "a", "--check", "x"]).is_err());
    }

    fn item(id: &str, title: &str, done: bool) -> ChecklistItem {
        ChecklistItem {
            id: id.into(),
            title: title.into(),
            done,
        }
    }

    #[test]
    fn メモの追記は後ろに足し_同じ文字は重ねない() {
        assert_eq!(appended_memo("", " 追記 "), Some("追記".into()));
        assert_eq!(
            appended_memo("元のメモ\n\n", "10/6 再依頼"),
            Some("元のメモ\n\n10/6 再依頼".into())
        );
        assert_eq!(
            appended_memo("元のメモ\n\n10/6 再依頼", "10/6 再依頼"),
            None
        );
        assert_eq!(appended_memo("元のメモ", "  "), None);
    }

    #[test]
    fn チェックリストは足すことと_チェックを付けることだけができる() {
        let list = [item("a", "見積もり", true), item("b", "請求書", false)];
        let mut next_id = 0;
        let added = with_added_checks(
            &list,
            &[
                "請求書".into(),
                " 納品 ".into(),
                "ＮＯＵＨＩＮ".into(),
                "nouhin".into(),
            ],
            || {
                next_id += 1;
                format!("new-{next_id}")
            },
        );
        // 同じ名前（全角・半角の違いも）は足さない。元の項目とチェックはそのまま
        assert_eq!(
            added,
            vec![
                item("a", "見積もり", true),
                item("b", "請求書", false),
                item("new-1", "納品", false),
                item("new-2", "ＮＯＵＨＩＮ", false),
            ]
        );
        // 名前でも id でも指せる。チェック済みはそのまま（外さない）
        let checked = with_checked(
            &added,
            &["請求書".into(), "new-1".into(), "見積もり".into()],
        );
        assert_eq!(
            checked.unwrap().iter().map(|i| i.done).collect::<Vec<_>>(),
            vec![true, true, true, false]
        );
        assert!(with_checked(&added, &["ない項目".into()]).is_err());
    }

    #[test]
    fn none_は外す指定として読む() {
        assert_eq!(optional("none", parse_points), Ok(None));
        assert_eq!(optional("なし", parse_priority), Ok(None));
        assert_eq!(optional("5", parse_points), Ok(Some(5)));
        assert!(optional("4", parse_points).is_err());
    }

    #[test]
    fn 知らないコマンドと_余計な引数は断る() {
        assert!(parsed(&["remove", "x"]).is_err());
        assert!(parsed(&["login", "now"]).is_err());
        assert!(parsed(&["logout", "--json"]).is_err());
        assert_eq!(command(&["login"]), Command::Login);
        assert_eq!(command(&["logout"]), Command::Logout);
    }

    #[test]
    fn 行き先と優先度と工数の読み方() {
        let today = "2026-10-06";
        assert_eq!(parse_destination("inbox", today), Ok(Destination::Inbox));
        assert_eq!(parse_destination("今日", today), Ok(Destination::Today));
        assert_eq!(
            parse_destination("明日", today),
            Ok(Destination::Scheduled("2026-10-07".into()))
        );
        assert_eq!(
            parse_destination("2026-10-20", today),
            Ok(Destination::Scheduled("2026-10-20".into()))
        );
        assert!(parse_destination("そのうち", today).is_err());
        assert_eq!(parse_priority("high"), Ok(Priority::High));
        assert_eq!(parse_priority("低"), Ok(Priority::Low));
        assert!(parse_priority("urgent").is_err());
        assert_eq!(parse_points("13"), Ok(13));
        assert!(parse_points("4").is_err());
    }
}
