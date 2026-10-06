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
use crate::data::net::{ApiClient, NetEvent};
use crate::data::{
    AddTask, Destination, Failure, Notice, OpResult, SaveFailure, StopReason, Store, open_store,
};
use crate::dates::{
    add_days, deadline_status, format_day_heading, format_short_date_with_weekday, parse_date_input,
};
use crate::model::{Bucket, POINTS, Priority, Task};
use crate::ui::text::fold;

/// Worker の応答を待つ時間
const WAIT: Duration = Duration::from_secs(60);
/// 完了の一覧に出す日数（今日を含む）の既定
const DEFAULT_COMPLETED_DAYS: i64 = 14;

pub const HELP: &str = "\
nagi — 自分専用の TODO アプリ

使い方：
  nagi                       画面（TUI）を開く
  nagi add <タイトル> [...]  タスクを追加する（既定は受信箱）
  nagi list [リスト] [...]   タスクの一覧を出す
  nagi login                 ログインする（GitHub のデバイスフロー。コードを出して待つ）
  nagi logout                ログアウトする

add の指定：
  --memo <文字>              メモ
  --to <行き先>              inbox（既定）・today・later か、日付（予定へ。今日以前の日付なら今日へ）
  --project <名前>           プロジェクト（名前で指す。なければ失敗する）
  --deadline <日付>          締切
  --priority <high|medium|low>
  --points <1|2|3|5|8|13>
  --json                     追加したタスクを JSON で出す

list の指定：
  リスト                     inbox・today・upcoming・later・completed（省くと未完了のすべて）
  --days <N>                 completed に出す日数（今日を含む。既定は 14）
  --json                     JSON で出す（重複を避けるための照合などに）

共通：
  --server <URL>             接続する Worker（省くと環境変数 NAGI_SERVER、なければ本番）
  -h, --help                 この説明（nagi help、nagi add --help でも同じ）
  -V, --version              版

日付は「2026-10-09」「明日」「金曜」「来週月曜」「3日後」「10/3」などで書ける。
ログインのトークンは、環境変数 NAGI_TOKEN でも渡せる。
画面のキーの一覧は、起動してから ? で見られる";

#[derive(Debug, Default, PartialEq, Eq)]
pub struct AddArgs {
    pub title: String,
    pub memo: String,
    pub to: Option<String>,
    pub project: Option<String>,
    pub deadline: Option<String>,
    pub priority: Option<String>,
    pub points: Option<String>,
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
}

#[derive(Debug, PartialEq, Eq)]
pub struct ListArgs {
    pub list: ListName,
    pub days: i64,
    pub json: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Tui,
    Help,
    Version,
    Add(AddArgs),
    List(ListArgs),
    Login,
    Logout,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Invocation {
    pub server: Option<String>,
    pub command: Command,
}

/// 値を取る指定
const VALUE_FLAGS: [&str; 8] = [
    "server", "memo", "to", "project", "deadline", "priority", "points", "days",
];

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
            } else if ["json", "help", "version"].contains(&name) && inline.is_none() {
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

    let mut take = |name: &str| -> Option<String> {
        let index = values.iter().rposition(|(flag, _)| *flag == name)?;
        let value = values.remove(index).1;
        // 同じ指定が重なっていたら、最後のものを使う
        values.retain(|(flag, _)| *flag != name);
        Some(value)
    };
    let server = take("server");
    let json = switches.contains(&"json");
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
                memo: take("memo").unwrap_or_default(),
                to: take("to"),
                project: take("project"),
                deadline: take("deadline"),
                priority: take("priority"),
                points: take("points"),
                json,
            })
        }
        Some((&"list", names)) => {
            let list = match names {
                [] => ListName::Open,
                [name] => list_name(name).ok_or(format!(
                    "知らないリストです：{name}（inbox・today・upcoming・later・completed）"
                ))?,
                _ => return Err("list に渡せるリストは1つです".to_string()),
            };
            let days = match take("days") {
                None => DEFAULT_COMPLETED_DAYS,
                Some(text) => text
                    .parse::<i64>()
                    .ok()
                    .filter(|days| (1..=3660).contains(days))
                    .ok_or(format!("--days は 1 以上の数で渡します：{text}"))?,
            };
            Command::List(ListArgs { list, days, json })
        }
        Some((&"login", [])) => Command::Login,
        Some((&"logout", [])) => Command::Logout,
        Some((&("login" | "logout"), _)) => {
            return Err("login と logout には、ほかの引数を渡せません".to_string());
        }
        Some((other, _)) => return Err(format!("知らないコマンドです：{other}")),
    };
    // そのコマンドで使わない指定が残っていたら、黙って捨てずに断る
    if let Some((name, _)) = values.first() {
        return Err(format!("ここでは使えない指定です：--{name}"));
    }
    if json && !matches!(command, Command::Add(_) | Command::List(_)) {
        return Err("--json は add と list で使えます".to_string());
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
        "open" | "all" => ListName::Open,
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
        if token.is_none() && !config.is_local() {
            return Err("ログインしていません。先に `nagi login` を実行してください".to_string());
        }
        let (sender, events) = channel();
        let store = open_store(config, token, move |event| {
            let _ = sender.send(event);
        });
        Ok(Session {
            store,
            events,
            server: config.server.clone(),
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
        "checklist": task.checklist.iter().map(|item| json!({ "title": item.title, "done": item.done })).collect::<Vec<_>>(),
        "createdAt": task.created_at,
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

    let done = session.store.add_task(AddTask {
        title: args.title,
        memo: args.memo,
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
        if args.list == ListName::Open || args.list == name {
            groups.push((label.to_string(), ids.iter().collect()));
        }
    }
    if args.list == ListName::Completed {
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
            Ok(DevicePoll::Ok(token)) => {
                config
                    .save_token(&token)
                    .map_err(|error| format!("トークンを保存できませんでした：{error}"))?;
                emit!("ログインしました");
                return Ok(());
            }
            Ok(DevicePoll::Expired) => {
                return Err("コードの期限が切れました。もう一度やり直してください".to_string());
            }
            Ok(DevicePoll::Denied) => return Err("GitHub で承認されませんでした".to_string()),
            Ok(DevicePoll::Forbidden) => {
                return Err("この GitHub アカウントでは、nagi を使えません".to_string());
            }
        }
    }
}

/// ログアウト。Worker のセッションを消し、手元のトークンと控えも消す
fn logout(config: &Config) -> Result<(), String> {
    match config.saved_token() {
        Some(token) => {
            auth::logout(&ApiClient::new(&config.server, Some(token)));
            config.clear_token();
            let _ = std::fs::remove_file(config.db_path());
            emit!("ログアウトしました");
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
                to: Some("today".into()),
                project: Some("AIPR".into()),
                deadline: Some("金曜".into()),
                priority: Some("high".into()),
                points: Some("3".into()),
                json: true,
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
