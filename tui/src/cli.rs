//! 画面なしの使い方（CLI）。エージェントや定期の実行から、タスクを追加したり一覧を読んだりする。
//! データの決まり（置き場・並び順キー・締切で今日へ移すなど）は、画面と同じデータ層（Store）に任せる

use std::io::{Read, Write};
use std::path::Path;
use std::process::ExitCode;
use std::sync::mpsc::{Receiver, channel};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::auth::{self, DevicePoll};
use crate::config::Config;
use crate::data::device::DeviceDb;
use crate::data::local_db::unsent_count_at;
use crate::data::net::{ApiClient, NetEvent};
use crate::data::{
    AddTask, Destination, Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason,
    Store, open_store,
};
use crate::dates::{
    add_days, deadline_status, format_day_heading, format_short_date_with_weekday, parse_date_input,
};
use crate::i18n::{Msg, fill, t};
use crate::model::{Bucket, ChecklistItem, POINTS, Priority, Task, TaskChanges};
use crate::ui::text::fold;
use crate::upgrade::{upgrade_message, waiting_message};

/// 書き出すファイルの形の名前と版
const EXPORT_FORMAT: &str = "nagi-export";
const EXPORT_FORMAT_VERSION: u32 = 1;

/// Worker の応答を待つ時間
const WAIT: Duration = Duration::from_secs(60);
/// 完了の一覧に出す日数（今日を含む）の既定
const DEFAULT_COMPLETED_DAYS: i64 = 14;

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
pub struct ExportArgs {
    /// 書き出し先のファイル。なければ標準出力
    pub out: Option<String>,
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
    Projects {
        json: bool,
    },
    Login,
    Logout {
        /// 送っていない変更があっても、消してログアウトする
        discard_unsent: bool,
    },
    Export(ExportArgs),
    AccountDelete {
        /// 確かめを聞かずに消す
        yes: bool,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub server: Option<String>,
    pub command: Command,
}

/// `--lang` の値。言語は引数を読む前に決める（引数の誤りの文も表を通す）ので、`parse` とは別に先に拾う。
/// 同じ指定が重なっていたら、最後のものを使う
pub fn lang_flag(args: &[String]) -> Option<String> {
    let mut found = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        if arg == "--" {
            break;
        }
        let Some(flag) = arg.strip_prefix("--") else {
            continue;
        };
        match flag.split_once('=') {
            Some(("lang", value)) => found = Some(value.to_string()),
            Some(_) => {}
            None if flag == "lang" => found = rest.next().cloned(),
            // 値を取る指定の値は、`--lang` に見えても指定ではない
            None if VALUE_FLAGS.contains(&flag) => {
                rest.next();
            }
            None => {}
        }
    }
    found
}

/// 値を取る指定
const VALUE_FLAGS: [&str; 17] = [
    "server",
    "lang",
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
    "out",
    "output",
];
/// 値を取らない指定
const SWITCHES: [&str; 6] = [
    "json",
    "help",
    "version",
    "keep-existing",
    "discard-unsent",
    "yes",
];

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
        _ => Err(fill(Msg::CliSingleId, &[&command])),
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
                        .ok_or(fill(Msg::CliFlagNeedsValue, &[&name]))?,
                };
                values.push((name, value));
            } else if SWITCHES.contains(&name) && inline.is_none() {
                switches.push(name);
            } else {
                return Err(fill(Msg::CliUnknownFlag, &[&arg]));
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
    // --lang は、引数を読む前に main が拾って使っている（lang_flag）
    take_all(values, "lang");
    let json = switches.contains(&"json");
    let keep_existing = switches.contains(&"keep-existing");
    let discard_unsent = switches.contains(&"discard-unsent");
    let yes = switches.contains(&"yes");
    let command = match positionals.split_first() {
        None => Command::Tui,
        Some((&"help", _)) => Command::Help,
        Some((&"add", titles)) => {
            let [title] = titles else {
                return Err(t(Msg::CliAddNeedsOneTitle).to_string());
            };
            if title.trim().is_empty() {
                return Err(t(Msg::CliTitleEmpty).to_string());
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
                [name] => list_name(name).ok_or(fill(Msg::CliUnknownList, &[&name]))?,
                _ => return Err(t(Msg::CliListTakesOne).to_string()),
            };
            let days = match take(values, "days") {
                None => DEFAULT_COMPLETED_DAYS,
                Some(text) => text
                    .parse::<i64>()
                    .ok()
                    .filter(|days| (1..=3660).contains(days))
                    .ok_or(fill(Msg::CliDaysInvalid, &[&text]))?,
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
        Some((&"logout", [])) => Command::Logout { discard_unsent },
        Some((&"export", [])) => {
            let out = take(values, "out");
            let output = take(values, "output");
            Command::Export(ExportArgs {
                out: output.or(out),
            })
        }
        Some((&"account", ["delete"])) => Command::AccountDelete { yes },
        Some((&"account", _)) => {
            return Err(t(Msg::CliAccountUsage).to_string());
        }
        Some((&("projects" | "login" | "logout" | "export"), _)) => {
            return Err(t(Msg::CliNoExtraArgs).to_string());
        }
        Some((other, _)) => return Err(fill(Msg::CliUnknownCommand, &[&other])),
    };
    // そのコマンドで使わない指定が残っていたら、黙って捨てずに断る
    if let Some((name, _)) = values.first() {
        return Err(fill(Msg::CliFlagNotHere, &[&name]));
    }
    if json
        && matches!(
            command,
            Command::Tui
                | Command::Login
                | Command::Logout { .. }
                | Command::Export(_)
                | Command::AccountDelete { .. }
        )
    {
        return Err(t(Msg::CliJsonNotHere).to_string());
    }
    if keep_existing && !matches!(command, Command::Update(_)) {
        return Err(t(Msg::CliKeepExistingOnlyUpdate).to_string());
    }
    if discard_unsent && !matches!(command, Command::Logout { .. }) {
        return Err(t(Msg::CliDiscardUnsentOnlyLogout).to_string());
    }
    if yes && !matches!(command, Command::AccountDelete { .. }) {
        return Err(t(Msg::CliYesOnlyAccountDelete).to_string());
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
        let login = auth::current_login(config);
        // Worker を名指ししたのにログインがない（この端末だけで使うときは、ログインは要らない）
        if config.is_cloud() && login.token.is_none() && !config.is_dev_server() {
            return Err(t(Msg::CliNotLoggedIn).to_string());
        }
        let (sender, events) = channel();
        let store = open_store(
            config,
            login.token,
            login.user_id.as_deref(),
            move |event| {
                let _ = sender.send(event);
            },
        )?;
        Ok(Session {
            store,
            events,
            server: if config.is_cloud() {
                config.server.clone()
            } else {
                t(Msg::ThisDeviceData).to_string()
            },
        })
    }

    /// 止まった理由や保存の失敗があれば、その文言を返す（nagi の更新が要るときは、ここでは返さない。
    /// 書き込みは手元で受け付けて pending の表に残し、flush で知らせる）
    fn check(&mut self) -> Result<(), String> {
        if self.store.stopped_by == Some(StopReason::Unauthorized) {
            return Err(t(Msg::CliLoginExpiredRelogin).to_string());
        }
        for notice in self.store.take_notices() {
            match notice {
                Notice::SaveFailed { reason, .. } => {
                    return Err(match reason {
                        SaveFailure::Network => fill(Msg::CliSaveNetwork, &[&self.server]),
                        SaveFailure::Conflict => t(Msg::SaveFailedConflict).to_string(),
                        SaveFailure::Quota(quota) => quota.message(),
                        SaveFailure::Rejected => t(Msg::CliSaveRejectedByWorker).to_string(),
                    });
                }
                Notice::OfflineBlocked { .. } => {
                    return Err(fill(Msg::CliCannotReach, &[&self.server]));
                }
                Notice::Unauthorized { .. } | Notice::UpgradeRequired => {}
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
                Err(_) => return Err(fill(Msg::CliNoResponse, &[&self.server])),
            }
            self.check()?;
        }
        Ok(())
    }

    /// 差分を取って、手元を最新にする（読むだけのコマンド）。nagi の更新が要るときは、その文言を返す
    fn sync(&mut self) -> Result<(), String> {
        self.refresh()?;
        self.stopped_for_upgrade()
    }

    /// 書き込む前に差分を取る。nagi の更新が要るときも止めずに、手元の控えのまま進める
    /// （書き込みは送らずに pending の表に残り、flush でそれを知らせる）
    fn sync_to_write(&mut self) -> Result<(), String> {
        self.refresh()
    }

    /// 差分を取る。前に送れなかった変更が控えから戻っていれば、送り終えるまで待つ
    fn refresh(&mut self) -> Result<(), String> {
        self.store.sync();
        self.pump(|store| !store.is_syncing())?;
        if self.store.needs_upgrade() {
            return Ok(());
        }
        self.waiting_for_server()?;
        if !self.store.synced {
            return Err(fill(Msg::CliCouldNotConnect, &[&self.server]));
        }
        self.flush()
    }

    /// 送信中の操作が、すべて保存されるまで待つ。版のずれで送れないときは、その文言を返す
    fn flush(&mut self) -> Result<(), String> {
        self.pump(|store| {
            store.pending_count() == 0 || store.needs_upgrade() || store.waiting_for_server
        })?;
        // 送らずに持つ変更を控えに書けていなければ、知らせる前にもう一度書いてみる
        self.store.retry_keep();
        self.stopped_for_upgrade()?;
        self.waiting_for_server()
    }

    fn stopped_for_upgrade(&self) -> Result<(), String> {
        if self.store.needs_upgrade() {
            return Err(upgrade_message(&self.store));
        }
        Ok(())
    }

    fn waiting_for_server(&self) -> Result<(), String> {
        if self.store.waiting_for_server {
            return Err(waiting_message(&self.store));
        }
        Ok(())
    }
}

/// 受け付けられなかった操作の文言。変えるものがなかったときは、失敗にしない
fn accepted(result: OpResult) -> Result<(), String> {
    match result {
        Ok(_) | Err(Failure::Noop) => Ok(()),
        Err(Failure::Offline) => Err(t(Msg::CliWorkerUnreachable).to_string()),
        Err(Failure::Stopped) => Err(t(Msg::CliLoginExpiredCannotSend).to_string()),
        Err(Failure::TooLong(limit)) => Err(limit.message()),
        Err(_) => Err(t(Msg::CliContentRejected).to_string()),
    }
}

fn parse_date(text: &str, today: &str, what: &str) -> Result<String, String> {
    parse_date_input(text, today).ok_or(fill(Msg::CliDateUnreadable, &[&what, &text]))
}

fn parse_destination(text: &str, today: &str) -> Result<Destination, String> {
    Ok(match text {
        "inbox" | "受信箱" => Destination::Inbox,
        "today" | "今日" => Destination::Today,
        "later" | "あとで" => Destination::Later,
        date => Destination::Scheduled(parse_date(date, today, t(Msg::CliWhatDestination))?),
    })
}

fn parse_priority(text: &str) -> Result<Priority, String> {
    Ok(match text {
        "high" | "高" => Priority::High,
        "medium" | "中" => Priority::Medium,
        "low" | "低" => Priority::Low,
        _ => return Err(fill(Msg::CliPriorityInvalid, &[&text])),
    })
}

fn parse_points(text: &str) -> Result<u8, String> {
    text.parse::<u8>()
        .ok()
        .filter(|points| POINTS.contains(points))
        .ok_or(fill(Msg::CliPointsInvalid, &[&text]))
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
        None => {
            let existing = if names.is_empty() {
                t(Msg::NoneLabel).to_string()
            } else {
                names
                    .iter()
                    .map(|(_, name)| *name)
                    .collect::<Vec<_>>()
                    .join(t(Msg::ListSeparator))
            };
            Err(fill(Msg::CliUnknownProject, &[&name, &existing]))
        }
    }
}

/// タスクが今あるリストの名前（JSON 用、表示用）
fn list_of(task: &Task) -> (&'static str, &'static str) {
    if task.is_completed() {
        return ("completed", t(Msg::ListCompleted));
    }
    match task.bucket {
        Bucket::Inbox => ("inbox", t(Msg::ListInbox)),
        Bucket::Today => ("today", t(Msg::ListToday)),
        Bucket::Scheduled => ("upcoming", t(Msg::ListScheduled)),
        Bucket::Later => ("later", t(Msg::ListLater)),
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
        meta.push(fill(Msg::CliMetaPriority, &[&priority.label()]));
    }
    if let Some(points) = task.points {
        meta.push(format!("{points}pt"));
    }
    if meta.is_empty() {
        format!("  {glyph} {}", task.title)
    } else {
        format!(
            "  {glyph} {}  （{}）",
            task.title,
            meta.join(t(Msg::ListSeparator))
        )
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
            .ok_or(fill(Msg::CliNoChecklistItem, &[&key]))?;
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
        (Some(_), Some(_)) => Err(fill(Msg::CliFlagOrFile, &[&flag])),
        (Some(text), None) => Ok(Some(text.to_string())),
        (None, Some(path)) => std::fs::read_to_string(path)
            .map(|text| Some(text.trim_end().to_string()))
            .map_err(|error| fill(Msg::CliFileUnreadable, &[&path, &error])),
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
        .ok_or(fill(Msg::CliTaskNotFound, &[&id]))
}

/// 読んだときから変わっていないかを確かめる（ほかの画面での手動の変更を、上書きしないため）
fn ensure_unchanged(task: &Task, expected: Option<&str>) -> Result<(), String> {
    match expected {
        Some(expected) if expected != task.updated_at => {
            Err(fill(Msg::CliChangedElsewhere, &[&task.updated_at]))
        }
        _ => Ok(()),
    }
}

/// 人が読むための詳細
fn task_detail(store: &Store, task: &Task) -> String {
    let today = &store.today;
    let mut lines = vec![task.title.clone()];
    let state = if task.is_in_progress() {
        t(Msg::CliInProgressSuffix)
    } else {
        ""
    };
    lines.push(fill(Msg::CliDetailList, &[&list_of(task).1, &state]));
    if let Some(on) = &task.scheduled_on {
        lines.push(fill(
            Msg::CliDetailScheduled,
            &[&format_short_date_with_weekday(on, today)],
        ));
    }
    if let Some(on) = &task.deadline_on {
        lines.push(fill(
            Msg::CliDetailDeadline,
            &[
                &format_short_date_with_weekday(on, today),
                &deadline_status(on, today).1,
            ],
        ));
    }
    if let Some(project) = task
        .project_id
        .as_deref()
        .and_then(|id| store.replica.project(id))
        .filter(|project| project.deleted_at.is_none())
    {
        lines.push(fill(Msg::CliDetailProject, &[&project.name]));
    }
    if let Some(priority) = task.priority {
        lines.push(fill(Msg::CliDetailPriority, &[&priority.label()]));
    }
    if let Some(points) = task.points {
        lines.push(fill(Msg::CliDetailPoints, &[&points]));
    }
    lines.push(format!("  id：{}", task.id));
    lines.push(fill(Msg::CliDetailUpdated, &[&task.updated_at]));
    if !task.memo.trim().is_empty() {
        lines.push(t(Msg::CliMemoHeading).to_string());
        lines.extend(task.memo.lines().map(|line| format!("  {line}")));
    }
    if !task.checklist.is_empty() {
        lines.push(t(Msg::CliChecklistHeading).to_string());
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
    session.sync_to_write()?;
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
        Some(text) => Some(parse_date(text, &today, t(Msg::CliWhatDeadline))?),
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
            return Err(t(Msg::CliAddFailed).to_string());
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
        .ok_or(t(Msg::CliAddedTaskNotFound))?;
    if args.json {
        emit!("{}", task_json(store, task));
    } else {
        emit(&fill(Msg::CliAddedTo, &[&list_of(task).1, &task.title]));
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
        (ListName::Inbox, t(Msg::ListInbox), &lists.inbox),
        (ListName::Today, t(Msg::ListToday), &lists.today),
        (ListName::Upcoming, t(Msg::ListScheduled), &lists.scheduled),
        (ListName::Later, t(Msg::ListLater), &lists.later),
    ] {
        if matches!(args.list, ListName::Open | ListName::All) || args.list == name {
            groups.push((label.to_string(), ids.iter().collect()));
        }
    }
    if matches!(args.list, ListName::Completed | ListName::All) {
        // 今日を含む days 日ぶん（論理日付）
        let since = add_days(&store.today, -(args.days - 1));
        groups.push((
            fill(
                Msg::CliTodayHeading,
                &[&format_day_heading(&store.today, &store.today)],
            ),
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
        emit(t(Msg::CliNoTasks));
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
    session.sync_to_write()?;
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
        Some(text) if !(keep && task.deadline_on.is_some()) => Some(optional(text, |text| {
            parse_date(text, &today, t(Msg::CliWhatDeadline))
        })?),
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
        emit(&fill(Msg::CliUpdated, &[&after.title]));
    } else {
        emit(&fill(Msg::CliNoChange, &[&after.title]));
    }
    Ok(())
}

fn done(config: &Config, args: DoneArgs) -> Result<(), String> {
    let mut session = Session::open(config)?;
    session.sync_to_write()?;
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
        emit(&fill(Msg::CliAlreadyCompleted, &[&after.title]));
    } else {
        emit(&fill(Msg::CliCompleted, &[&after.title]));
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
        emit(t(Msg::CliNoProjects));
    } else {
        for (_, name, open) in rows {
            emit(&fill(Msg::CliProjectLine, &[&name, &open]));
        }
    }
    Ok(())
}

/// ログイン。URL とコードを出し、承認されるまで待つ
fn login(config: &Config) -> Result<(), String> {
    let client = ApiClient::new(&config.server, None);
    let start = auth::start(&client)?;
    emit(&fill(Msg::CliLoginStepOpen, &[&start.verification_uri]));
    emit(&fill(Msg::CliLoginStepCode, &[&start.user_code]));
    emit(t(Msg::CliLoginWaiting));
    let deadline = Instant::now() + Duration::from_secs(start.expires_in);
    let mut interval = start.interval.max(1);
    loop {
        thread::sleep(Duration::from_secs(interval));
        if Instant::now() >= deadline {
            return Err(t(Msg::LoginCodeExpired).to_string());
        }
        match auth::poll(&client, &start.device_code) {
            // 通信のつまずきは、次の回でもう一度確かめる
            Ok(DevicePoll::Pending) | Err(_) => {}
            Ok(DevicePoll::SlowDown(next)) => interval = next.max(interval + 1),
            Ok(DevicePoll::Ok { token, user_id }) => {
                config
                    .save_session(&token, user_id.as_deref())
                    .map_err(|error| fill(Msg::CliSaveTokenFailed, &[&error]))?;
                emit(t(Msg::CliLoggedIn));
                // この端末だけで使っていたときのデータは、そのまま残る（クラウドへは移さない）
                let left = DeviceDb::open(&config.device_db_path())
                    .ok()
                    .and_then(|db| db.count().ok())
                    .unwrap_or(0);
                if left > 0 {
                    emit(&fill(Msg::CliLocalDataKept, &[&left]));
                }
                return Ok(());
            }
            Ok(DevicePoll::Expired) => {
                return Err(t(Msg::LoginCodeExpired).to_string());
            }
            Ok(DevicePoll::Denied) => return Err(t(Msg::LoginDenied).to_string()),
            Ok(DevicePoll::Forbidden) => {
                return Err(t(Msg::LoginNotInvited).to_string());
            }
        }
    }
}

/// ログアウト。Worker のセッションを消し、手元のトークンと控えも消す。控えに送っていない変更があれば
/// （あるかを確かめられなければ）、discard_unsent がない限り、何も消さずに止まる
fn logout(config: &Config, discard_unsent: bool) -> Result<(), String> {
    match config.saved_session() {
        Some(session) => {
            // 持ち主の分からないログイン（利用者の ID を返さないころのもの）は、消す前に聞いておく（どの控えかを決めるため）
            let user_id = session
                .user_id
                .clone()
                .or_else(|| auth::current_login(config).user_id);
            if !discard_unsent {
                let found = match unsent_count_at(&config.db_path(user_id.as_deref())) {
                    Ok(0) => None,
                    Ok(count) => Some(fill(Msg::UnsentCountFound, &[&count])),
                    Err(error) => Some(fill(Msg::UnsentCountUnknown, &[&error])),
                };
                if let Some(found) = found {
                    return Err(fill(Msg::CliLogoutRefused, &[&found]));
                }
            }
            auth::logout(&ApiClient::new(&config.server, Some(session.token)));
            config.clear_token();
            config.remove_db(user_id.as_deref());
            if config.is_cloud() {
                emit(t(Msg::CliLoggedOut));
            } else {
                emit(t(Msg::CliLoggedOutLocal));
            }
        }
        None => emit(t(Msg::CliNotLoggedInShort)),
    }
    Ok(())
}

/// データを書き出す。クラウドのとき（ログイン中）は Worker のデータ（GET /api/export）、そうでなければ
/// この端末のデータ（`local.db`）。どちらも同じ形（src/shared/export.ts の exportSchema）
fn export(config: &Config, args: ExportArgs) -> Result<(), String> {
    if config.is_cloud() {
        let login = auth::current_login(config);
        if login.token.is_none() && !config.is_dev_server() {
            return Err(t(Msg::CliNotLoggedIn).to_string());
        }
        // Worker は、端末のデータの書き出しと同じ整形（2 文字の字下げ）で流すので、そのまま写す
        let mut body = ApiClient::new(&config.server, login.token).export_account()?;
        return match args.out {
            Some(out) => write_replacing(Path::new(&out), |file| copy_document(&mut body, file))
                .map_err(|error| fill(Msg::CliExportWriteFailed, &[&out, &error])),
            None => match copy_document(&mut body, std::io::stdout().lock()) {
                // 読む側が先に閉じた（`| head` など）。emit と同じく、そこで終える
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                    std::process::exit(0)
                }
                result => result.map_err(|error| fill(Msg::CliExportReadFailed, &[&error])),
            },
        };
    }
    let path = config.device_db_path();
    if !path.exists() {
        return Err(t(Msg::CliNothingToExport).to_string());
    }
    let rows = DeviceDb::open(&path)?.export()?;
    let document = json!({
        "format": EXPORT_FORMAT,
        "formatVersion": EXPORT_FORMAT_VERSION,
        "exportedAt": crate::dates::iso(chrono::Utc::now()),
        "app": format!("nagi {}", crate::VERSION),
        "projects": rows.projects,
        "tasks": rows.tasks,
    });
    let text = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?;
    match args.out {
        Some(out) => write_replacing(Path::new(&out), |file| writeln!(file, "{text}"))
            .map_err(|error| fill(Msg::CliExportWriteFailed, &[&out, &error])),
        None => {
            emit(&text);
            Ok(())
        }
    }
}

/// 応答の本文を、読みながら書き先へ写す（全部を手元に持たない）。端末のデータの書き出しと同じく、最後に改行を足す
fn copy_document(body: &mut impl Read, out: impl Write) -> std::io::Result<()> {
    let mut out = std::io::BufWriter::new(out);
    std::io::copy(body, &mut out)?;
    writeln!(out)?;
    out.flush()
}

/// クラウドのアカウントとデータを消す。先に件数と書き出しの案内を出し、`delete` と打たせる（yes なら聞かない）。
/// Worker が 204 を返してから、手元のログインと控えを消す。この端末のデータ（local.db）には触れない
fn account_delete(config: &Config, yes: bool) -> Result<(), String> {
    let login = auth::current_login(config);
    let (Some(token), Some(user_id)) = (login.token, login.user_id) else {
        return Err(t(Msg::CliAccountDeleteNoOwner).to_string());
    };
    if !yes {
        let (tasks, projects) = {
            let mut session = Session::open(config)?;
            session.sync()?;
            let replica = &session.store.replica;
            (
                replica
                    .tasks()
                    .filter(|task| task.deleted_at.is_none())
                    .count(),
                replica
                    .projects()
                    .filter(|project| project.deleted_at.is_none())
                    .count(),
            )
        };
        emit(&fill(
            Msg::CliAccountDeleteWarning,
            &[&config.server, &tasks, &projects],
        ));
        emit(t(Msg::CliAccountDeleteExportHint));
        eprint!("{}", t(Msg::CliAccountDeletePrompt));
        let _ = std::io::stderr().flush();
        let mut answer = String::new();
        std::io::stdin()
            .read_line(&mut answer)
            .map_err(|error| fill(Msg::CliReadInputFailed, &[&error]))?;
        if answer.trim() != "delete" {
            return Err(t(Msg::CliAccountDeleteDeclined).to_string());
        }
    }
    ApiClient::new(&config.server, Some(token.clone())).delete_account(&user_id)?;
    forget_deleted_login(config, &user_id, &token);
    config.remove_db(Some(&user_id));
    emit(t(Msg::CliAccountDeleted));
    Ok(())
}

/// 保存してあるログインが、消したアカウントのもの（同じトークンか、同じ利用者）なら消す。
/// NAGI_TOKEN で別の利用者を消したときや、確かめているあいだに別のログインに替わったときは、残す
pub fn forget_deleted_login(config: &Config, user_id: &str, token: &str) {
    if config
        .saved_session()
        .is_some_and(|saved| saved.token == token || saved.user_id.as_deref() == Some(user_id))
    {
        config.clear_token();
    }
}

/// 同じフォルダの一時ファイルに（unix では 0600 で）write で書いてから、`rename` で置き換える
/// （書き出しの途中で止まっても、前のファイルは壊れない）。
/// 一時ファイルは、この呼び出しが新しく作れた名前だけを使い、消すのも自分が作ったものだけ
/// （同じ名前が先にあれば、他の書き出しや前回の残りなので、触らずに別の名前にする）
fn write_replacing(
    path: &Path,
    write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>,
) -> std::io::Result<()> {
    let dir = match path.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    let name = path.file_name().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, t(Msg::CliFileNameMissing))
    })?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let (temp, mut file) = loop {
        let mut temp_name = std::ffi::OsString::from(".");
        temp_name.push(name);
        temp_name.push(format!(
            ".{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::now_v7().simple()
        ));
        let temp = dir.join(temp_name);
        match options.open(&temp) {
            Ok(file) => break (temp, file),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
    };

    let written = write(&mut file)
        .and_then(|()| file.sync_all())
        .and_then(|()| std::fs::rename(&temp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written
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
        Command::Logout { discard_unsent } => logout(config, discard_unsent),
        Command::Export(args) => export(config, args),
        Command::AccountDelete { yes } => account_delete(config, yes),
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
        assert_eq!(
            command(&["logout"]),
            Command::Logout {
                discard_unsent: false
            }
        );
        assert_eq!(
            command(&["logout", "--discard-unsent"]),
            Command::Logout {
                discard_unsent: true
            }
        );
        assert!(parsed(&["list", "--discard-unsent"]).is_err());
    }

    #[test]
    fn 送っていない変更があれば_logout_はログインも控えも消さずに止まる() {
        use crate::data::local_db::{LocalDb, PendingOwner};
        use crate::data::replica::{OperationKind, PendingBatch};
        use crate::model::Mutation;

        let dir = std::env::temp_dir().join(format!(
            "nagi-cli-logout-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        let config = Config::at("https://nagi.example.com", &dir);
        config.save_session("token", Some("u1")).unwrap();
        let path = config.db_path(Some("u1"));
        let batch = PendingBatch {
            id: "b1".into(),
            mutations: vec![Mutation::update_task(
                "t1",
                TaskChanges {
                    memo: Some("残すメモ".into()),
                    ..Default::default()
                },
            )],
            at: "2026-10-06T03:00:00.000Z".into(),
            kind: OperationKind::TaskUpdate,
        };
        LocalDb::open(&path)
            .unwrap()
            .save_pending(&PendingOwner::new(Some("u1"), Some("token")), &[batch])
            .unwrap();

        assert!(logout(&config, false).is_err());
        assert!(config.saved_session().is_some());
        assert_eq!(unsent_count_at(&path).unwrap(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn exportは_書き出し先を省ける() {
        assert_eq!(
            command(&["export"]),
            Command::Export(ExportArgs { out: None })
        );
        assert_eq!(
            command(&["export", "--out", "x.json"]),
            Command::Export(ExportArgs {
                out: Some("x.json".into())
            })
        );
        assert!(parsed(&["export", "x.json"]).is_err());
        assert!(parsed(&["export", "--json"]).is_err());
        assert!(parsed(&["list", "--out", "x.json"]).is_err());
    }

    #[test]
    fn exportは_output_でも書き出し先を読む() {
        assert_eq!(
            command(&["export", "--output", "nagi.json"]),
            Command::Export(ExportArgs {
                out: Some("nagi.json".into())
            })
        );
    }

    #[test]
    fn account_delete_は_確かめを聞くか_yes_で省く() {
        assert_eq!(
            command(&["account", "delete"]),
            Command::AccountDelete { yes: false }
        );
        assert_eq!(
            command(&["account", "delete", "--yes"]),
            Command::AccountDelete { yes: true }
        );
    }

    #[test]
    fn account_の知らない続きは断る() {
        assert!(parsed(&["account"]).is_err());
        assert!(parsed(&["account", "remove"]).is_err());
        assert!(parsed(&["account", "delete", "now"]).is_err());
        assert!(parsed(&["account", "delete", "--json"]).is_err());
        assert!(parsed(&["list", "--yes"]).is_err());
    }

    #[test]
    fn 書き出しは_前のファイルを置き換え_一時ファイルを残さない() {
        let dir = std::env::temp_dir().join(format!(
            "nagi-cli-test-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.json");
        std::fs::write(&out, "old").unwrap();

        write_replacing(&out, |file| writeln!(file, "{{}}")).unwrap();

        assert_eq!(std::fs::read_to_string(&out).unwrap(), "{}\n");
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("out.json")]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn 書き出しは_先にある同じ名前の一時ファイルに触らない() {
        let dir = std::env::temp_dir().join(format!(
            "nagi-cli-test-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("out.json");
        let other = dir.join(format!(".out.json.{}.tmp", std::process::id()));
        std::fs::write(&other, "other").unwrap();

        write_replacing(&out, |file| writeln!(file, "{{}}")).unwrap();

        assert_eq!(std::fs::read_to_string(&out).unwrap(), "{}\n");
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "other");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nagi-cli-test-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// GET /api/export を 1 回だけ受けて、本文を chunked で返す Worker の代わり。
    /// finish が false なら、終わりの印を送らずに切る（Worker が途中で止まったとき）
    fn serve_export(chunks: Vec<String>, finish: bool) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = format!("http://{}", listener.local_addr().unwrap());
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut buf = [0; 4096];
            while !request.ends_with(b"\r\n\r\n") {
                let read = stream.read(&mut buf).unwrap();
                assert!(read > 0, "要求の途中で切れました");
                request.extend_from_slice(&buf[..read]);
            }
            assert!(request.starts_with(b"GET /api/export "));
            write!(
                stream,
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n"
            )
            .unwrap();
            for chunk in chunks {
                write!(stream, "{:x}\r\n{chunk}\r\n", chunk.len()).unwrap();
            }
            if finish {
                stream.write_all(b"0\r\n\r\n").unwrap();
            }
        });
        server
    }

    fn file_names(dir: &Path) -> Vec<std::ffi::OsString> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect()
    }

    #[test]
    fn クラウドの書き出しは_応答を読みながら_そのままファイルに書く() {
        // ureq が本文を一度に読むときの既定の上限（10 MiB）より大きい
        let chunks: Vec<String> = std::iter::once("{\n  \"tasks\": [".to_string())
            .chain((0..12).map(|i| format!("\n    \"{i}{}\",", "あ".repeat(350_000))))
            .chain(std::iter::once("\n    \"x\"\n  ]\n}".to_string()))
            .collect();
        let expected = format!("{}\n", chunks.concat());
        let dir = temp_dir("cloud-export");
        let config = Config::at(&serve_export(chunks, true), &dir);
        config.save_session("token-a", Some("user-a")).unwrap();
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let out = out_dir.join("out.json");
        std::fs::write(&out, "old").unwrap();

        export(
            &config,
            ExportArgs {
                out: Some(out.to_string_lossy().into_owned()),
            },
        )
        .unwrap();

        assert_eq!(std::fs::read_to_string(&out).unwrap(), expected);
        assert_eq!(
            file_names(&out_dir),
            vec![std::ffi::OsString::from("out.json")]
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&out).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn クラウドの書き出しが途中で切れたら_失敗し_前のファイルも一時ファイルもそのまま() {
        let dir = temp_dir("cloud-export-cut");
        let config = Config::at(
            &serve_export(vec!["{\n  \"tasks\": [".to_string()], false),
            &dir,
        );
        config.save_session("token-a", Some("user-a")).unwrap();
        let out_dir = dir.join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let out = out_dir.join("out.json");
        std::fs::write(&out, "old").unwrap();

        let result = export(
            &config,
            ExportArgs {
                out: Some(out.to_string_lossy().into_owned()),
            },
        );

        assert!(result.is_err(), "{result:?}");
        assert_eq!(std::fs::read_to_string(&out).unwrap(), "old");
        assert_eq!(
            file_names(&out_dir),
            vec![std::ffi::OsString::from("out.json")]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn アカウントを消したあと_保存してあるログインは_消したアカウントのものだけを消す() {
        let config = Config::at("https://nagi.example.com", &temp_dir("forget"));

        // NAGI_TOKEN で A を消した。保存してあるのは B のログイン
        config.save_session("token-b", Some("user-b")).unwrap();
        forget_deleted_login(&config, "user-a", "token-a");
        assert_eq!(config.saved_token().as_deref(), Some("token-b"));
        // 利用者の ID が分からない古いログインも、トークンが違えば残す
        config.save_session("token-old", None).unwrap();
        forget_deleted_login(&config, "user-a", "token-a");
        assert_eq!(config.saved_token().as_deref(), Some("token-old"));

        // 同じトークン
        config.save_session("token-a", None).unwrap();
        forget_deleted_login(&config, "user-a", "token-a");
        assert_eq!(config.saved_session(), None);
        // 同じ利用者の別のトークン（Worker では、利用者のセッションはすべて消えている）
        config.save_session("token-a2", Some("user-a")).unwrap();
        forget_deleted_login(&config, "user-a", "token-a");
        assert_eq!(config.saved_session(), None);
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
