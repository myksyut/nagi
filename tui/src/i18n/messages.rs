//! 画面と CLI の文言の全部。文言を直すときは、ここだけを見ればよい。
//!
//! `鍵 => ("日本語", "English"),` の形で書く。値の入る文は `{0}`・`{1}` の番号の穴で書き（`fill` が埋める）、
//! 言語で語順が変わっても書けるようにする。
//! 入力を読むための語（`dates.rs` の `relative_days` など、`cli.rs` の `list_name` の「受信箱」など）は
//! 読むためのものなので、ここには置かず今の場所に残してある。

/// 鍵の `enum Msg`・全部の鍵 `Msg::ALL`・日本語の文 `Msg::ja`・英語の文 `Msg::en` を作る。
/// 英語のない鍵はマクロが受けつけないので、ビルドが通らない。
/// 文は言語ごとに 1 本の文字列につないで、切れ目の位置の表で引く（`&str` の配列だと、
/// 文の数だけ、起動のときに直す印がバイナリに入る）
macro_rules! messages {
    ($($key:ident => ($ja:literal, $en:literal),)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Msg {
            $($key,)*
        }

        const COUNT: usize = [$(Msg::$key,)*].len();
        const JA_TEXT: &str = concat!($($ja,)*);
        const EN_TEXT: &str = concat!($($en,)*);
        static JA_ENDS: [u32; COUNT] = ends([$($ja.len(),)*]);
        static EN_ENDS: [u32; COUNT] = ends([$($en.len(),)*]);

        impl Msg {
            #[cfg(test)]
            pub const ALL: &'static [Msg] = &[$(Msg::$key,)*];

            pub fn ja(self) -> &'static str {
                slice(JA_TEXT, &JA_ENDS, self as usize)
            }

            pub fn en(self) -> &'static str {
                slice(EN_TEXT, &EN_ENDS, self as usize)
            }
        }
    };
}

/// 文ごとの長さから、つないだ文字列の中での終わりの位置の表を作る
const fn ends<const N: usize>(lengths: [usize; N]) -> [u32; N] {
    let mut ends = [0; N];
    let mut total = 0;
    let mut i = 0;
    while i < N {
        total += lengths[i];
        ends[i] = total as u32;
        i += 1;
    }
    ends
}

fn slice(text: &'static str, ends: &[u32], index: usize) -> &'static str {
    let start = if index == 0 { 0 } else { ends[index - 1] };
    &text[start as usize..ends[index] as usize]
}

messages! {

    // main.rs
    UsageHint => ("{0}\n\n使い方は `nagi --help` で見られます", "{0}\n\nRun `nagi --help` for usage"),
    HelpPage => ("{0}\n\n本番：{1}\n\n{2}", "{0}\n\nProduction: {1}\n\n{2}"),
    StartFailed => ("起動できませんでした：{0}", "Could not start: {0}"),
    ContinueWithoutLocalCopy => ("{0}\n手元の控えと記録なしで続けます", "{0}\nContinuing without a local copy or log"),
    LangUnsupported => ("知らない言語です：{0}（使える値：{1}）", "Unknown language: {0} (available: {1})"),

    // data/net.rs（取り込み）
    NetImportBadResponse => ("クラウドの応答を読めませんでした", "Could not read the cloud's response"),
    NetImportServerError => ("クラウドがエラーを返しました（{0}）", "The cloud returned an error ({0})"),
    NetImportRowTooLarge => ("{0} の行が大きすぎて、1 回に送れません（{1} KiB まで）", "A row in {0} is too large to send at once (up to {1} KiB)"),
    NetImportPartial => ("{0}（{1} 件までは移してあります。もう一度実行すると、残りだけが入ります）", "{0} ({1} items are already moved. Run it again to move only the rest)"),
    NetImportUnsupported => ("このクラウドは、まだ取り込みに対応していません", "This cloud does not support import yet"),
    NetImportBodyTooLarge => ("本文が大きすぎて、クラウドが受け付けませんでした", "The request was too large and the cloud rejected it"),
    NetImportRateLimited => ("回数が多すぎます。1 分待ってから、もう一度実行してください", "Too many requests. Wait a minute and run it again"),
    NetImportQuota => ("クラウドの上限（タスク {0} 件、プロジェクト {1} 件）を超えるため、移せません", "This would go over the cloud limit ({0} tasks, {1} projects), so nothing was moved"),
    NetImportSchemaFallback => ("クラウドが、この端末のデータを受け付けませんでした", "The cloud rejected this device's data"),
    NetImportRejectedStatus => ("クラウドが受け付けませんでした（{0}）", "The cloud rejected it ({0})"),
    NetImportPlaceProject => ("プロジェクトの {0} 件目", "project #{0}"),
    NetImportPlaceTask => ("タスクの {0} 件目", "task #{0}"),
    NetImportPlaceData => ("データ", "data"),
    NetImportRejectedField => ("この端末の{0}を、クラウドが受け付けませんでした（{1}：{2}）", "The cloud rejected this device's {0} ({1}: {2})"),
    NetImportRejectedRow => ("この端末の{0}を、クラウドが受け付けませんでした（{1}）", "The cloud rejected this device's {0} ({1})"),

    // ui/login.rs・ui/render/overlay.rs（取り込み）
    LoginImportAllThere => ("この端末のデータ {0} 件は、すべてクラウドにあります", "All {0} items on this device are already in the cloud"),
    LogImportCheckFailed => ("取り込みの確かめに失敗しました: {0}", "Could not check what to import: {0}"),
    LoginImportChanged => ("ログインが替わったため、移しませんでした", "The login changed, so nothing was moved"),
    LoginImportChangedHint => ("Ctrl+K の「この端末のデータをクラウドへ移す」から、もう一度確かめてください", "Check again from Ctrl+K, \"Move this device's data to the cloud\""),
    LoginImportDone => ("{0} 件をクラウドへ移しました。この端末のデータは消していません", "Moved {0} items to the cloud. This device's data was not deleted"),
    ImportChecking => ("この端末のデータを確かめています…", "Checking this device's data…"),
    ImportEscClose => ("Esc で閉じる", "Esc to close"),
    ImportRetryCheck => ("Enter で確かめ直す　Esc で閉じる", "Enter to check again  Esc to close"),
    ImportOfferTitle => ("この端末の {0} 件をクラウドへ移しますか", "Move {0} items from this device to the cloud?"),
    ImportOfferCounts => ("新しく {0} 件、もうある {1} 件", "{0} new, {1} already there"),
    ImportOfferNote => ("もうある分は入れません。この端末のデータは消しません", "Existing items are skipped. This device's data is kept"),
    ImportOfferLater1 => ("あとから Ctrl+K の「この端末のデータをクラウドへ", "You can move them any time from Ctrl+K,"),
    ImportOfferLater2 => ("移す」で、いつでも移せます", "\"Move this device's data to the cloud\""),
    ImportOfferKeys => ("Enter で移す　Esc で移さない", "Enter to move  Esc to skip"),
    ImportPreparing => ("移す準備をしています…", "Getting ready to move…"),
    ImportProgress => ("移しています… {0} / {1} 件", "Moving… {0} / {1}"),
    ImportRetryRest => ("Enter でもう一度（残りだけが入ります）　Esc で閉じる", "Enter to retry (only the rest is added)  Esc to close"),

    // cli.rs
    CliHelp => ("\
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
  nagi logout                ログアウトして、この端末のデータに戻る（送っていない変更があれば、消さずに止まる）
  nagi logout --discard-unsent
                             送っていない変更を消して、ログアウトする
  nagi export [--out <ファイル>]
                             データを JSON で書き出す（ログイン中はクラウドのデータ、していなければこの端末のデータ）
  nagi account delete [--yes]
                             クラウドのアカウントとデータを消す（`delete` と打って確かめる。この端末のデータは残る）
  nagi import [--dry-run]    この端末のデータをクラウドへ移す（もうあるものは入れない。何度動かしても同じ。--dry-run は件数だけ）

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
  --out <ファイル>           export の書き出し先（省くと標準出力。--output でも同じ）
  --yes                      account delete で、確かめを聞かずに消す
  --dry-run                  import で、移さずに件数だけを出す
  --server <URL>             接続する Worker（省くと環境変数 NAGI_SERVER。どちらもなければ、ログインしていれば本番、
                             していなければこの端末のデータ）
  --lang <ja|en>             画面の言語（省くと、覚えた選択、LC_ALL・LC_MESSAGES・LANG の順）
  -h, --help                 この説明（nagi help、nagi add --help でも同じ）
  -V, --version              版

日付は「2026-10-09」「明日」「金曜」「来週月曜」「3日後」「10/3」などで書ける（英語の「tomorrow」「fri」「next monday」「in 3 days」も読める）。
ログインのトークンは、環境変数 NAGI_TOKEN でも渡せる。
画面のキーの一覧は、起動してから ? で見られる", "\
nagi — a TODO app for your terminal

Without logging in, your data stays on this device only (local).
After logging in, it syncs with the cloud.

Usage:
  nagi                       open the screen (TUI)
  nagi add <title> [...]     add a task (goes to the inbox by default)
  nagi list [list] [...]     list tasks
  nagi show <ID>             show one task in detail
  nagi update <ID> [...]     add to an existing task or set its attributes
  nagi done <ID>             complete a task
  nagi projects              list projects
  nagi login                 log in to sync with the cloud (GitHub device flow; invite only for now)
  nagi logout                log out and go back to this device's data
                             (stops if there are unsent changes)
  nagi logout --discard-unsent
                             discard unsent changes and log out
  nagi export [--out <file>]
                             write your data as JSON (the cloud data when logged in,
                             otherwise this device's data)
  nagi account delete [--yes]
                             delete your cloud account and data (you confirm by typing `delete`;
                             this device's data stays)
  nagi import [--dry-run]    move this device's data to the cloud (items already there are skipped;
                             safe to run again; --dry-run only prints the counts)

Options for add:
  --memo <text>              memo
  --memo-file <file>         read the memo from a file (pass text taken from outside here,
                             not as an argument)
  --to <destination>         inbox (default), today, later, or a date (scheduled; a date
                             today or earlier goes to today)
  --project <name>           project, by name (fails if it does not exist)
  --deadline <date>          deadline
  --priority <high|medium|low>
  --points <1|2|3|5|8|13>
  --add-check <item>         checklist item (can be repeated)

Options for list:
  list                       inbox, today, upcoming, later, completed, all (omit for all open tasks)
  --days <N>                 days of completed tasks shown by completed and all (including today;
                             default 14)

Options for update (only adds and attributes; it cannot rewrite the title, replace the memo,
uncheck, or delete):
  --append-memo <text>       append to the memo (skipped if the same text is already there)
  --append-memo-file <file>
                             read the text to append from a file
  --add-check <item>         add a checklist item (skipped if the name exists; can be repeated)
  --check <item>             check an item (by name or id; can be repeated)
  --to, --project, --deadline, --priority, --points
                             same as add; --project, --deadline, --priority and --points are
                             cleared with none
  --keep-existing            do not change a deadline, priority, points or project that
                             already has a value
  --if-unchanged-since <updatedAt>
                             fail without changing anything if the current updatedAt differs
                             from the one you read (also works with done)

Common:
  --json                     print the result as JSON (add, list, show, update, done, projects)
  --out <file>               where export writes (stdout if omitted; --output works too)
  --yes                      delete the account without asking for confirmation (account delete)
  --dry-run                  print only the counts, without moving anything (import)
  --server <URL>             the Worker to connect to (default: env NAGI_SERVER; if neither is
                             set, production when logged in, otherwise this device's data)
  --lang <ja|en>             language of the screen and messages (default: the saved choice,
                             then LC_ALL, LC_MESSAGES, LANG)
  -h, --help                 this help (also nagi help, nagi add --help)
  -V, --version              version

Dates can be written as \"2026-10-09\", \"tomorrow\", \"fri\", \"next monday\", \"in 3 days\",
\"in 2 weeks\", \"10/3\" and so on.
The login token can also be passed in the environment variable NAGI_TOKEN.
For the keys on the screen, start nagi and press ?"),
    CliAddNeedsOneTitle => ("add には、タイトルを1つ渡します（空白を含むときは引用符で囲む）", "add takes one title (quote it if it has spaces)"),
    CliTitleEmpty => ("タイトルが空です", "The title is empty"),
    CliListTakesOne => ("list に渡せるリストは1つです", "list takes one list name"),
    CliNoExtraArgs => ("projects・login・logout・export・import には、ほかの引数を渡せません", "projects, login, logout, export and import take no other arguments"),
    CliJsonNotHere => ("--json は、ここでは使えません", "--json cannot be used here"),
    CliKeepExistingOnlyUpdate => ("--keep-existing は update で使えます", "--keep-existing works with update only"),
    CliDryRunOnlyImport => ("--dry-run は import で使えます", "--dry-run works with import"),
    CliNothingToImport => ("この端末には、移すデータがありません", "There is no data on this device to move"),
    CliImportDryRun => ("新しく {0} 件、もうある {1} 件（プロジェクト 新しく {2}・もうある {3}、タスク 新しく {4}・もうある {5}）", "{0} new, {1} already there (projects: {2} new, {3} already there; tasks: {4} new, {5} already there)"),
    CliImportProgress => ("{0} / {1} 件", "{0} / {1}"),
    CliImportDone => ("{0} 件をクラウドへ移しました（もうあった {1} 件は、そのままにしています）。この端末のデータは消していません", "Moved {0} items to the cloud ({1} that were already there were left as they are). This device's data was not deleted"),
    CliImportDetached => ("指すプロジェクトがなかったタスク {0} 件は、プロジェクトなしで入れました", "{0} tasks whose project was missing were added without a project"),
    CliDiscardUnsentOnlyLogout => ("--discard-unsent は logout で使えます", "--discard-unsent works with logout only"),
    CliNotLoggedIn => ("ログインしていません。先に `nagi login` を実行してください", "You are not logged in. Run `nagi login` first"),
    ThisDeviceData => ("この端末のデータ", "this device's data"),
    CliLoginExpiredRelogin => ("ログインが切れています。`nagi login` でログインし直してください", "Your login has expired. Run `nagi login` again"),
    SaveFailedConflict => ("ほかの画面で先に変更されていたため、保存できませんでした", "Could not save: it was changed elsewhere first"),
    CliSaveRejectedByWorker => ("保存できませんでした（Worker に受け付けられませんでした）", "Could not save (the Worker rejected it)"),
    CliWorkerUnreachable => ("Worker に接続できません", "Cannot reach the Worker"),
    CliLoginExpiredCannotSend => ("ログインが切れていて、送れません", "Your login has expired, so nothing can be sent"),
    CliContentRejected => ("受け付けられない内容です", "The content was rejected"),
    CliWhatDestination => ("行き先", "destination"),
    NoneLabel => ("なし", "None"),
    ListCompleted => ("完了", "Completed"),
    ListInbox => ("受信箱", "Inbox"),
    ListToday => ("今日", "Today"),
    ListScheduled => ("予定", "Upcoming"),
    ListLater => ("あとで", "Later"),
    CliInProgressSuffix => ("（進行中）", " (in progress)"),
    CliMemoHeading => ("メモ：", "Memo:"),
    CliChecklistHeading => ("チェックリスト：", "Checklist:"),
    CliWhatDeadline => ("締切", "deadline"),
    CliAddFailed => ("追加できませんでした", "Could not add the task"),
    CliAddedTaskNotFound => ("追加したタスクが見つかりません", "The added task was not found"),
    LoginCodeExpired => ("コードの期限が切れました。もう一度やり直してください", "The code has expired. Try again"),
    LoginDenied => ("GitHub で承認されませんでした", "GitHub did not approve the login"),
    CliNothingToExport => ("書き出すデータがありません", "There is no data to export"),
    CliFileNameMissing => ("ファイル名がありません", "The file name is missing"),
    CliSingleId => ("{0} には、タスクの id を1つ渡します", "{0} takes one task id"),
    CliFlagNeedsValue => ("--{0} には値が要ります", "--{0} needs a value"),
    CliUnknownFlag => ("知らない指定です：{0}", "Unknown option: {0}"),
    CliUnknownList => ("知らないリストです：{0}（inbox・today・upcoming・later・completed・all）", "Unknown list: {0} (inbox, today, upcoming, later, completed, all)"),
    CliDaysInvalid => ("--days は 1 以上の数で渡します：{0}", "--days takes a number of 1 or more: {0}"),
    CliUnknownCommand => ("知らないコマンドです：{0}", "Unknown command: {0}"),
    CliFlagNotHere => ("ここでは使えない指定です：--{0}", "This option cannot be used here: --{0}"),
    CliSaveNetwork => ("保存できませんでした（{0} に接続できません）", "Could not save (cannot reach {0})"),
    CliCannotReach => ("{0} に接続できません", "Cannot reach {0}"),
    CliNoResponse => ("{0} からの応答がありません", "No response from {0}"),
    CliCouldNotConnect => ("{0} に接続できませんでした", "Could not connect to {0}"),
    CliDateUnreadable => ("{0}を日付として読めません：{1}", "Cannot read the {0} as a date: {1}"),
    CliPriorityInvalid => ("優先度は high・medium・low で渡します：{0}", "Priority must be high, medium or low: {0}"),
    CliPointsInvalid => ("工数は 1・2・3・5・8・13 のどれかで渡します：{0}", "Points must be one of 1, 2, 3, 5, 8, 13: {0}"),
    CliUnknownProject => ("プロジェクト「{0}」がありません（今あるもの：{1}）", "There is no project \"{0}\" (existing: {1})"),
    ListSeparator => ("・", ", "),
    CliMetaPriority => ("優先度 {0}", "priority {0}"),
    CliTaskMeta => ("  {0} {1}  （{2}）", "  {0} {1}  ({2})"),
    CliNoChecklistItem => ("チェックリストに、その項目がありません：{0}", "There is no such checklist item: {0}"),
    CliFlagOrFile => ("--{0} と --{0}-file は、どちらか一方だけ渡します", "Give either --{0} or --{0}-file, not both"),
    CliFileUnreadable => ("ファイルを読めません：{0}（{1}）", "Cannot read the file: {0} ({1})"),
    CliTaskNotFound => ("タスクが見つかりません：{0}", "Task not found: {0}"),
    CliChangedElsewhere => ("ほかで変更されています（今の updatedAt は {0}）。読み直してから、もう一度実行してください", "Changed elsewhere (its updatedAt is now {0}). Read it again, then retry"),
    CliDetailList => ("  リスト：{0}{1}", "  List: {0}{1}"),
    CliDetailScheduled => ("  予定：{0}", "  Scheduled: {0}"),
    CliDetailDeadline => ("  締切：{0}（{1}）", "  Deadline: {0} ({1})"),
    CliDetailProject => ("  プロジェクト：{0}", "  Project: {0}"),
    CliDetailPriority => ("  優先度：{0}", "  Priority: {0}"),
    CliDetailPoints => ("  工数：{0}", "  Points: {0}"),
    CliDetailUpdated => ("  更新：{0}", "  Updated: {0}"),
    CliIdLine => ("  id：{0}", "  id: {0}"),
    CliAddedTo => ("{0}に追加しました：{1}", "Added to {0}: {1}"),
    CliTodayHeading => ("{0}（今日）", "{0} (today)"),
    CliNoTasks => ("タスクはありません", "No tasks"),
    CliUpdated => ("更新しました：{0}", "Updated: {0}"),
    CliNoChange => ("変更はありません：{0}", "No change: {0}"),
    CliAlreadyCompleted => ("すでに完了しています：{0}", "Already completed: {0}"),
    CliCompleted => ("完了にしました：{0}", "Completed: {0}"),
    CliNoProjects => ("プロジェクトはありません", "No projects"),
    CliProjectLine => ("{0}（未完了 {1}）", "{0} ({1} open)"),
    CliLoginStepOpen => ("1. ブラウザでこの URL を開く：{0}", "1. Open this URL in your browser: {0}"),
    CliLoginStepCode => ("2. このコードを入力して、承認する：{0}", "2. Enter this code and approve: {0}"),
    CliLoginWaiting => ("承認を待っています…（ここに出たコード以外は、承認しないでください）", "Waiting for approval… (approve only the code shown here)"),
    CliSaveTokenFailed => ("トークンを保存できませんでした：{0}", "Could not save the token: {0}"),
    CliLoggedIn => ("ログインしました。クラウドと同期します", "Logged in. Syncing with the cloud"),
    CliLocalDataKept => ("この端末のタスクとプロジェクト（{0} 件）は、`nagi import` でクラウドへ移せます。移さなければ、そのまま残り、`nagi logout` で戻ります", "Your tasks and projects on this device ({0}) can be moved to the cloud with `nagi import`. If you do not, they stay as they are and come back with `nagi logout`"),
    LoginNotInvited => ("この GitHub アカウントは、まだクラウドとの同期に招待されていません", "This GitHub account has not been invited to cloud sync yet"),
    UnsentCountFound => ("送っていない変更が {0} 件あります", "Unsent changes: {0}"),
    UnsentCountUnknown => ("送っていない変更があるかを確かめられません（{0}）", "Cannot tell whether there are unsent changes ({0})"),
    CliLogoutRefused => ("{0}。ログアウトすると消えるため、ログアウトしていません。消してよければ `nagi logout --discard-unsent` を実行してください", "{0}. Logging out would discard them, so you are still logged in. To discard them, run `nagi logout --discard-unsent`"),
    CliLoggedOut => ("ログアウトしました", "Logged out"),
    CliLoggedOutLocal => ("ログアウトしました。このあとは、この端末のデータを使います", "Logged out. From now on, this device's data is used"),
    CliNotLoggedInShort => ("ログインしていません", "You are not logged in"),
    CliExportWhileLoggedIn => ("ログイン中ですが、この端末のデータ（{0}）を書き出します（クラウドのデータは含みません）", "You are logged in, but this exports this device's data ({0}), not the cloud data"),
    CliExportWriteFailed => ("{0} に書き出せませんでした：{1}", "Could not write to {0}: {1}"),

    // config.rs
    ConfigHomeMissing => ("データの置き場を決められません。環境変数 HOME（か {0}）が設定されていません", "Cannot decide where to keep data. The environment variable HOME (or {0}) is not set"),
    ConfigCreateDirFailed => ("{0} を作れませんでした：{1}", "Could not create {0}: {1}"),
    ConfigLocations => ("置き場：\n  データ    {0}\n  ログイン  {1}\n  記録      {2}", "Locations:\n  data   {0}\n  login  {1}\n  log    {2}"),

    // auth.rs
    AuthWorkerNotConfigured => ("Worker のログインの設定が足りません", "The Worker's login settings are incomplete"),
    AuthGithubUnreachable => ("GitHub とやり取りできませんでした（OAuth App でデバイスフローが有効か確かめてください）", "Could not talk to GitHub (check that the device flow is enabled on the OAuth App)"),
    AuthTooManyAttempts => ("試行が多すぎます。1 分待ってください", "Too many attempts. Wait a minute"),
    WorkerUnreachable => ("Worker に接続できませんでした", "Could not connect to the Worker"),
    AuthResponseUnreadable => ("ログインの応答が読めません", "Cannot read the login response"),
    AuthStartFailed => ("ログインを始められませんでした（HTTP {0}）", "Could not start the login (HTTP {0})"),
    AuthResponseUnreadableWith => ("ログインの応答が読めません（{0}）", "Cannot read the login response ({0})"),
    AuthSaveLoginFailed => ("ログインを保存できませんでした: {0}", "Could not save the login: {0}"),

    // dates.rs
    WeekdaySun => ("日", "Sun"),
    WeekdayMon => ("月", "Mon"),
    WeekdayTue => ("火", "Tue"),
    WeekdayWed => ("水", "Wed"),
    WeekdayThu => ("木", "Thu"),
    WeekdayFri => ("金", "Fri"),
    WeekdaySat => ("土", "Sat"),
    DateLong => ("{0}{1}日({2})", "{2}, {0} {1}"),
    DateLongWithYear => ("{0}年{1}{2}日({3})", "{3}, {1} {2}, {0}"),
    DateHeading => ("{0}{1}日 {2}", "{2}, {0} {1}"),
    DateHeadingWithYear => ("{0}年{1}{2}日 {3}", "{3}, {1} {2}, {0}"),
    DeadlineFar => ("締切 {0}", "due {0}"),
    DaysLeftMany => ("あと{0}日", "{0} days left"),
    DeadlineToday => ("今日まで", "due today"),
    DaysOverdueMany => ("{0}日超過", "{0} days overdue"),
    DateTomorrow => ("明日", "Tomorrow"),
    WeekdayLongSun => ("日曜日", "Sunday"),
    WeekdayLongMon => ("月曜日", "Monday"),
    WeekdayLongTue => ("火曜日", "Tuesday"),
    WeekdayLongWed => ("水曜日", "Wednesday"),
    WeekdayLongThu => ("木曜日", "Thursday"),
    WeekdayLongFri => ("金曜日", "Friday"),
    WeekdayLongSat => ("土曜日", "Saturday"),
    MonthShort1 => ("1月", "Jan"),
    MonthShort2 => ("2月", "Feb"),
    MonthShort3 => ("3月", "Mar"),
    MonthShort4 => ("4月", "Apr"),
    MonthShort5 => ("5月", "May"),
    MonthShort6 => ("6月", "Jun"),
    MonthShort7 => ("7月", "Jul"),
    MonthShort8 => ("8月", "Aug"),
    MonthShort9 => ("9月", "Sep"),
    MonthShort10 => ("10月", "Oct"),
    MonthShort11 => ("11月", "Nov"),
    MonthShort12 => ("12月", "Dec"),
    MonthFull1 => ("1月", "January"),
    MonthFull2 => ("2月", "February"),
    MonthFull3 => ("3月", "March"),
    MonthFull4 => ("4月", "April"),
    MonthFull5 => ("5月", "May"),
    MonthFull6 => ("6月", "June"),
    MonthFull7 => ("7月", "July"),
    MonthFull8 => ("8月", "August"),
    MonthFull9 => ("9月", "September"),
    MonthFull10 => ("10月", "October"),
    MonthFull11 => ("11月", "November"),
    MonthFull12 => ("12月", "December"),
    DateShort => ("{0}/{1}", "{0}/{1}"),
    DateShortWithYear => ("{0}/{1}/{2}", "{1}/{2}/{0}"),
    DateShortWeekday => ("{0}({1})", "{1} {0}"),
    DaysLeftOne => ("あと{0}日", "{0} day left"),
    DaysOverdueOne => ("{0}日超過", "{0} day overdue"),
    Parenthesized => ("{0}（{1}）", "{0} ({1})"),
    QuotedTitle => ("「{0}」", "\"{0}\""),

    // model.rs
    PriorityHigh => ("高", "High"),
    PriorityMedium => ("中", "Medium"),
    PriorityLow => ("低", "Low"),

    // upgrade.rs
    UpgradeHint => ("nagi を更新してください。`{0}`", "Please update nagi: `{0}`"),
    UpgradeHintWithNote => ("{0}。{1}", "{0}. {1}"),
    UpgradeUnreadablePending => ("送っていない変更に、この nagi で読めないものがあります。{0}", "Some unsent changes cannot be read by this nagi. {0}"),
    WaitingForWorkerWithNote => ("Worker の更新を待っています。{0}", "Waiting for the Worker to update. {0}"),
    WaitingForWorker => ("Worker の更新を待っています", "Waiting for the Worker to update"),
    UnsentKept => ("送っていない変更 {0} 件は残してあります", "Unsent changes kept: {0}"),
    UnsentNotSaved => ("送っていない変更 {0} 件を保存できていません。閉じると消えます", "Unsent changes not saved: {0}. They are lost when you close"),

    // data/mod.rs
    LogLocalDbOpenFailed => ("手元の控えを開けないため、保存せずに動きます: {0}", "Could not open the local copy, so changes are not saved: {0}"),
    LogPendingMoveFailed => ("Worker ごとの控えに残した変更を、利用者の控えへ移せませんでした: {0}", "Could not move changes kept per Worker into the user's local copy: {0}"),

    // data/net.rs
    NetResetRepeated => ("reset が続きました", "reset kept repeating"),

    // data/store.rs
    LimitTitle => ("タイトルは {0} 文字まで", "A title can have up to {0} characters"),
    LimitMemo => ("メモは {0} 文字まで", "A memo can have up to {0} characters"),
    LimitChecklistItems => ("チェックリストは {0} 項目まで", "A checklist can have up to {0} items"),
    LimitChecklistItem => ("チェックリストの項目は {0} 文字まで", "A checklist item can have up to {0} characters"),
    LimitProjectName => ("プロジェクト名は {0} 文字まで", "A project name can have up to {0} characters"),
    QuotaTasks => ("タスクは {0} 件まで", "You can have up to {0} tasks"),
    QuotaProjects => ("プロジェクトは {0} 件まで", "You can have up to {0} projects"),
    LogLocalCopyCleanFailed => ("手元の控えを片付けられませんでした: {0}", "Could not clean up the local copy: {0}"),
    LogLocalCopyReadFailed => ("手元の控えを読めませんでした: {0}", "Could not read the local copy: {0}"),
    LogUnreadablePending => ("送っていない変更に、この nagi で読めないものがあります", "Some unsent changes cannot be read by this nagi"),
    LogPendingReadFailed => ("送っていない変更を手元の控えから読めませんでした: {0}", "Could not read unsent changes from the local copy: {0}"),
    LogSyncFailed => ("差分を取得できませんでした: {0}", "Could not fetch the diff: {0}"),
    LogApiVersionRequired => ("Worker は API の版 {0} 以上を求めています（この nagi は {1}）", "The Worker requires API version {0} or later (this nagi is {1})"),
    LogMalformedMutations => ("操作の形が正しくありません: {0}", "The operations are malformed: {0}"),
    LogMutationRejected => ("保存を受け付けられませんでした: {0} {1}", "The save was rejected: {0} {1}"),
    LogLocalSaveFailed => ("手元の控えに保存できませんでした: {0}", "Could not save to the local copy: {0}"),
    LogTimeZoneUnreadable => ("Worker が返したタイムゾーン {0} を、そのままでは読めません", "Cannot use the time zone {0} returned by the Worker as it is"),
    LogTimeZoneUnusable => ("Worker が返したタイムゾーン {0} を読めないため、{1} のままにします", "Cannot read the time zone {0} returned by the Worker, so {1} stays"),

    // data/device.rs
    LogDeviceReadWriteFailed => ("この端末のデータを読み書きできませんでした: {0}", "Could not read or write this device's data: {0}"),
    DeviceNewerFormatBy => ("この端末のデータ（{0}）は nagi {1} で作られました。nagi を {1} 以降に更新してください", "This device's data ({0}) was made by nagi {1}. Update nagi to {1} or later"),
    DeviceNewerFormat => ("この端末のデータ（{0}）は、新しい版の nagi のものです。nagi を更新してください", "This device's data ({0}) is from a newer nagi. Update nagi"),
    DeviceOpenFailed => ("この端末のデータ（{0}）を開けませんでした：{1}", "Could not open this device's data ({0}): {1}"),
    DeviceCreateFailed => ("この端末のデータ（{0}）を作れませんでした：{1}", "Could not create this device's data ({0}): {1}"),
    DeviceBackupFailed => ("この端末のデータ（{0}）を移す前の控え（{1}）を取れなかったので、移さずに止めました：{2}", "Could not make a backup ({1}) before migrating this device's data ({0}), so it was not migrated: {2}"),
    DeviceMigrateFailed => ("この端末のデータ（{0}）を版 {1} から版 {2} に移せなかったので、元のまま残しました：{3}。移す前の控えは {4} にあります", "Could not migrate this device's data ({0}) from version {1} to version {2}, so it was left as is: {3}. The backup from before the migration is at {4}"),
    DeviceRowMissing => ("書き込む行がありません: {0}", "There is no row to write: {0}"),

    // data/sort.rs
    SortManual => ("手動", "Manual"),
    SortPriority => ("優先度", "Priority"),
    SortPointsAsc => ("工数が少ない順", "Points, low to high"),
    SortPointsDesc => ("工数が多い順", "Points, high to low"),

    // ui/mod.rs
    LoginExpiredRelogin => ("ログインが切れました。もう一度ログインしてください", "Your login has expired. Log in again"),

    // ui/app.rs
    LabelPriority => ("優先度", "Priority"),
    LabelPoints => ("工数", "Points"),
    AddToInbox => ("受信箱に追加", "Add to Inbox"),
    AddToToday => ("今日に追加", "Add to Today"),
    AddToLater => ("あとでに追加", "Add to Later"),
    ToastOfflineBlocked => ("オフラインのため、操作できません", "You are offline, so this cannot be done"),
    ToastUndoConflict => ("ほかの画面で先に変更されていたため、元に戻せませんでした", "Could not undo: it was changed elsewhere first"),
    SaveFailed => ("保存できませんでした", "Could not save"),
    InputKeptInAddBox => ("追加した文字は、追加欄（n）に戻してあります", "Your text is back in the add box (n)"),
    FoldCompleted => ("完了 {0}件", "{0} completed"),
    LogTimeZoneSaveFailed => ("タイムゾーンを保存できませんでした: {0}", "Could not save the time zone: {0}"),
    ToastTimeZoneSet => ("タイムゾーンを {0} にしました", "Time zone set to {0}"),

    // ui/keys.rs
    GroupTask => ("タスク", "Task"),
    GroupWhen => ("いつやる", "When"),
    GroupMove => ("移動", "Move"),
    GroupList => ("リスト", "List"),
    GroupGlobal => ("全体", "General"),
    KeyDown => ("下へ", "Down"),
    KeyUp => ("上へ", "Up"),
    KeyExtendDown => ("選択を下へ広げる", "Extend selection down"),
    KeyExtendUp => ("選択を上へ広げる", "Extend selection up"),
    KeyTop => ("一番上へ", "Go to top"),
    KeyBottom => ("一番下へ", "Go to bottom"),
    KeyReorderUp => ("並べ替え（上へ）", "Reorder (up)"),
    KeyReorderDown => ("並べ替え（下へ）", "Reorder (down)"),
    KeyAdd => ("追加", "Add"),
    KeyOpen => ("開く", "Open"),
    KeyClose => ("閉じる", "Close"),
    KeyComplete => ("完了（もう一度で戻す）", "Complete (again to undo)"),
    KeyStart => ("進行中にする／未着手に戻す", "Start / stop"),
    KeyToToday => ("今日へ", "Move to Today"),
    KeyToLater => ("あとでへ", "Move to Later"),
    KeySchedule => ("日付を決めて予定へ", "Pick a date and schedule"),
    KeyDeadline => ("締切", "Deadline"),
    KeyProject => ("プロジェクト", "Project"),
    KeyPriority => ("優先度", "Priority"),
    KeyPoints => ("工数", "Points"),
    KeyDelete => ("削除", "Delete"),
    KeyCopy => ("タイトルとメモをコピー", "Copy title and memo"),
    KeyUndo => ("元に戻す", "Undo"),
    KeyGoInbox => ("受信箱を開く", "Open Inbox"),
    KeyGoToday => ("今日を開く", "Open Today"),
    KeyGoUpcoming => ("予定を開く", "Open Upcoming"),
    KeyGoLater => ("あとでを開く", "Open Later"),
    KeyGoLogbook => ("完了ログを開く", "Open Logbook"),
    KeyGoCalendar => ("カレンダーを開く", "Open Calendar"),
    KeyGoTimeline => ("タイムラインを開く", "Open Timeline"),
    PlaceTodayProject => ("今日・プロジェクト", "Today, Project"),
    KeyToggleBoard => ("リスト／ボードの切り替え", "Switch list / board"),
    PlaceBoard => ("ボード", "Board"),
    KeyColumnLeft => ("左の列へ", "Column to the left"),
    KeyColumnRight => ("右の列へ", "Column to the right"),
    PlaceTodayLaterProject => ("今日・あとで・プロジェクト", "Today, Later, Project"),
    KeySortMenu => ("並び方を選ぶ", "Choose sort order"),
    KeyToggleFold => ("「完了 N件」を開く／閉じる", "Open / close the completed group"),
    KeyCreateProject => ("プロジェクトを作成", "Create project"),
    PlaceProject => ("プロジェクト", "Project"),
    KeyRenameProject => ("プロジェクトの名前を変更", "Rename project"),
    KeyArchiveProject => ("プロジェクトをアーカイブ（もう一度で解除）", "Archive project (again to restore)"),
    KeyProjectColor => ("プロジェクトの色", "Project color"),
    PlaceCalendar => ("カレンダー", "Calendar"),
    KeyPrevDay => ("前の日へ", "Previous day"),
    KeyNextDay => ("次の日へ", "Next day"),
    KeyPrevWeek => ("前の週へ", "Previous week"),
    KeyNextWeek => ("次の週へ", "Next week"),
    KeyEntryDown => ("その日の中で下へ", "Down within the day"),
    KeyEntryUp => ("その日の中で上へ", "Up within the day"),
    KeyBackToToday => ("今日の日へ戻る", "Back to today"),
    PlaceTimeline => ("タイムライン", "Timeline"),
    KeyTimelineDown => ("下のタスクへ", "Task below"),
    KeyTimelineUp => ("上のタスクへ", "Task above"),
    PlaceCalendarTimeline => ("カレンダー・タイムライン", "Calendar, Timeline"),
    KeyPrevPeriod => ("前の月・前の週へ", "Previous month / week"),
    KeyNextPeriod => ("次の月・次の週へ", "Next month / week"),
    KeyShiftBack => ("1日前へずらす", "Shift 1 day earlier"),
    KeyShiftForward => ("1日後へずらす", "Shift 1 day later"),
    KeyFilterProject => ("プロジェクトで絞り込む", "Filter by project"),
    KeyFocusSidebar => ("サイドバーへ移る", "Go to the sidebar"),
    KeyToggleSidebar => ("サイドバーを畳む・広げる", "Collapse / expand the sidebar"),
    KeyPalette => ("検索とコマンド", "Search and commands"),
    PlaceShortcuts => ("ショートカット", "Shortcuts"),
    KeyShortcutsClose => ("ショートカットを閉じる", "Close shortcuts"),
    KeyShortcuts => ("ショートカットの一覧", "List of shortcuts"),
    KeySync => ("今すぐ同期", "Sync now"),
    KeyLogin => ("クラウドと同期する（ログイン。いまは招待制）", "Sync with the cloud (log in; invite only for now)"),
    KeyLogout => ("ログアウト", "Log out"),
    KeyImportLocal => ("この端末のデータをクラウドへ移す", "Move this device's data to the cloud"),
    KeyQuit => ("終了", "Quit"),
    KeyLanguage => ("{0}に切り替える", "Switch to {0}"),
    LangNameJa => ("日本語", "Japanese"),
    LangNameEn => ("英語", "English"),
    FieldAddBox => ("追加欄", "Add box"),
    FieldAddContinue => ("追加して続ける", "Add and continue"),
    FieldClose => ("閉じる", "Close"),
    FieldOpenTask => ("開いたタスク", "Open task"),
    FieldMove => ("欄を移る", "Move between fields"),
    FieldEdit => ("欄を直す・押す", "Edit or press the field"),
    FieldSaveMemo => ("直した文字を保存して欄を出る（メモ）", "Save the text and leave the field (memo)"),
    FieldChecklist => ("チェックリスト", "Checklist"),
    FieldCheckToggle => ("チェックを付ける・外す", "Check / uncheck"),
    FieldRename => ("名前を直す", "Rename"),
    FieldRemoveItem => ("項目を消す", "Remove the item"),
    FieldMoveItem => ("項目を上・下へ", "Move the item up / down"),
    FieldDateInput => ("日付の入力（d・D）", "Date input (d, D)"),
    FieldDecide => ("決める", "Confirm"),
    FieldClearDeadline => ("締切を外す（空のまま）", "Clear the deadline (leave empty)"),
    FieldCancel => ("やめる", "Cancel"),
    FieldProjectPicker => ("p の候補", "Choices for p"),
    FieldPickCandidate => ("候補を選ぶ", "Pick a choice"),
    FieldDecideCreate => ("決める（「◯◯」を作成も）", "Confirm (or create \"...\")"),
    FieldPriorityPoints => ("優先度・工数の候補", "Priority and points choices"),
    FieldQuickPriority => ("その場で決める（優先度：1 高・2 中・3 低・0 なし）", "Pick directly (priority: 1 high, 2 medium, 3 low, 0 none)"),
    FieldSortList => ("並び方の一覧", "Sort order list"),
    FieldQuickSort => ("その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）", "Pick directly (1 manual, 2 priority, 3 points low to high, 4 points high to low)"),
    FieldQuickAdd => ("小さな追加欄（カレンダー・タイムライン）", "Small add box (calendar, timeline)"),
    FieldSwitchTarget => ("行き先を切り替える", "Switch the destination"),
    FieldRunOpen => ("実行する・開く", "Run or open"),
    FieldSidebar => ("サイドバー", "Sidebar"),
    FieldPickList => ("リストを選ぶ", "Pick a list"),
    FieldBackToList => ("一覧へ戻る", "Back to the list"),
    ToastSyncing => ("同期しています", "Syncing"),
    KeySortBy => ("並び方：{0}", "Sort: {0}"),

    // ui/commands.rs
    ToastCompleted => ("完了しました", "Completed"),
    ToastDeleted => ("削除しました", "Deleted"),
    ToastCopyFailed => ("コピーできませんでした", "Could not copy"),
    ToastCannotArchive => ("アーカイブできません", "Cannot archive"),
    ManualOrderOnly => ("手動の並びのときに使えます", "Available with manual order"),
    ToastTooMany => ("一度に扱えるのは {0} 件まで", "Up to {0} at a time"),
    CountItems => ("{0}件", "{0} tasks"),
    ToastCompletedCount => ("{0}件を完了しました", "Completed {0} tasks"),
    ToastBackToToday => ("{0}を今日に戻しました", "Moved {0} back to Today"),
    ToastMovedTo => ("{0}を{1}へ", "Moved {0} to {1}"),
    ToastDeadlinesCleared => ("{0}件の締切を外しました", "Cleared the deadline of {0} tasks"),
    ToastDeadlinesSet => ("{0}件の締切を{1}にしました", "Set the deadline of {0} tasks to {1}"),
    ToastToToday => ("{0}を今日へ", "Moved {0} to Today"),
    ToastDatesShifted => ("{0}件の日付をずらしました", "Shifted the dates of {0} tasks"),
    ToastBackToInProgress => ("{0}件を進行中に戻しました", "Set {0} tasks back to in progress"),
    ToastBackToNotStarted => ("{0}件を未着手に戻しました", "Set {0} tasks back to not started"),
    ToastStarted => ("{0}件を進行中にしました", "Started {0} tasks"),
    ToastDeletedCount => ("{0}件を削除しました", "Deleted {0} tasks"),
    ToastProjectCleared => ("{0}のプロジェクトを外しました", "Removed the project from {0}"),
    ToastProjectSet => ("{0}を「{1}」へ", "Moved {0} to project \"{1}\""),
    ToastPrioritySet => ("{0}件の優先度を{1}にしました", "Set the priority of {0} tasks to {1}"),
    ToastPriorityCleared => ("{0}件の優先度を外しました", "Cleared the priority of {0} tasks"),
    ToastPointsSet => ("{0}件の工数を {1} にしました", "Set the points of {0} tasks to {1}"),
    ToastPointsCleared => ("{0}件の工数を外しました", "Cleared the points of {0} tasks"),
    ToastArchived => ("「{0}」をアーカイブしました", "Archived \"{0}\""),
    ToastOpenTasksRemain => ("未完了のタスクが {0} 件残っています", "Open tasks remaining: {0}"),
    ToastAddedTo => ("{0}に追加しました", "Added to {0}"),

    // ui/input.rs
    InputKeptInField => ("打った文字は欄に残してあります", "Your text is still in the field"),
    LocationWithProject => ("{0}・{1}", "{0} · {1}"),

    // ui/list.rs
    ColumnNotStarted => ("未着手", "Not started"),
    ColumnInProgress => ("進行中", "In progress"),
    ColumnCompleted => ("完了", "Completed"),

    // ui/login.rs
    DataOpenFailed => ("データを開けませんでした", "Could not open the data"),
    LoginSyncStartedKeepLocal => ("クラウドと同期します。この端末のタスクはそのまま残り、ログアウトすると戻ります", "Syncing with the cloud. Your tasks on this device stay as they are, and come back when you log out"),
    UnsentUnknownLogoutWarning => ("送っていない変更があるかを確かめられません。ログアウトすると消えます", "Cannot tell whether there are unsent changes. Logging out discards them"),
    LogoutAgainHint => ("もう一度ログアウトを選ぶと、消してログアウトします", "Choose log out again to discard them and log out"),
    DevServerNoLogin => ("手元の開発サーバーでは、ログインなしで使っています", "The local dev server is used without logging in"),
    LoggedOutNotice => ("ログアウトしました", "Logged out"),
    LoggedOutLocalToast => ("ログアウトしました。この端末のデータに戻りました", "Logged out. Back to this device's data"),
    LogSaveTokenFailed => ("トークンを保存できませんでした: {0}", "Could not save the token: {0}"),
    UnsentCountLogoutWarning => ("送っていない変更が {0} 件あります。ログアウトすると消えます", "Unsent changes: {0}. Logging out discards them"),
    AccountDeletedNotice => ("クラウドのアカウントを消しました", "Deleted your cloud account"),
    AccountDeletedToast => ("クラウドのアカウントを消しました。この端末のデータに戻りました", "Deleted your cloud account. Back to this device's data"),
    AccountDeleteFailed => ("アカウントを消せませんでした", "Could not delete the account"),
    AccountDeleteNoOwner => ("ログインの持ち主を確かめられないため、消せません", "Cannot confirm who is logged in, so nothing was deleted"),
    AccountDeleteRelogin => ("`nagi login` でログインし直してください", "Log in again with `nagi login`"),
    KeyDeleteAccount => ("アカウントを削除", "Delete account"),

    // ui/render/overlay.rs（アカウントの削除）
    AccountDeleteTitle => ("アカウントを削除", "Delete account"),
    AccountDeleteHeading => (" クラウドのアカウントとデータを消します", " This deletes your cloud account and data"),
    AccountDeleteCounts => (" タスク {0} 件、プロジェクト {1} 件", " {0} tasks, {1} projects"),
    AccountDeleteNotice => ("消すと元に戻せません。先に `nagi export` で書き出せます。この端末のデータ（local.db）は消えません。", "This cannot be undone. You can back up first with\n`nagi export`. This device's data (local.db) is\nnot deleted."),
    AccountDeleting => (" 消しています…", " Deleting…"),
    AccountDeletePlaceholder => ("delete と打って Enter（Esc でやめる）", "Type delete and press Enter (Esc to cancel)"),

    // cli.rs（アカウントの削除と書き出し）
    CliAccountUsage => ("account の使い方は `nagi account delete` です", "Usage: `nagi account delete`"),
    CliYesOnlyAccountDelete => ("--yes は account delete で使えます", "--yes works with account delete"),
    CliExportReadFailed => ("書き出しの応答を読めませんでした：{0}", "Could not read the export response: {0}"),
    CliExportRateLimited => ("回数の制限にかかったので、{0} 秒待ってから続けます", "Rate limited. Waiting {0} seconds before continuing"),
    CliAccountDeleteNoOwner => ("ログインしていません（利用者を確かめられません）。先に `nagi login` を実行してください", "You are not logged in (cannot confirm who you are). Run `nagi login` first"),
    CliAccountDeleteWarning => ("{0} のアカウントとデータを消します（タスク {1} 件、プロジェクト {2} 件）。元に戻せません", "This deletes the account of {0} and its data ({1} tasks, {2} projects). It cannot be undone"),
    CliAccountDeleteExportHint => ("先に `nagi export` で書き出せます。この端末のデータ（local.db）は消しません", "You can back up first with `nagi export`. This device's data (local.db) is not deleted"),
    CliAccountDeletePrompt => ("消すなら delete と打ってください：", "Type delete to confirm: "),
    CliReadInputFailed => ("入力を読めませんでした：{0}", "Could not read the input: {0}"),
    CliAccountDeleteDeclined => ("消しませんでした（何も消していません）", "Not deleted (nothing was deleted)"),
    CliAccountDeleted => ("クラウドのアカウントを消しました", "Deleted your cloud account"),

    // data/net.rs（アカウントの削除と書き出し）
    ExportFailedHttp => ("書き出せませんでした（HTTP {0}）", "Could not export (HTTP {0})"),
    DeleteLoginExpired => ("ログインが切れています。`nagi login` でログインし直してください（何も消していません）", "Your login has expired. Log in again with `nagi login` (nothing was deleted)"),
    DeleteIdMismatch => ("利用者の ID が合いませんでした（何も消していません）", "The user ID did not match (nothing was deleted)"),
    DeleteFailedHttp => ("消せませんでした（HTTP {0}）", "Could not delete (HTTP {0})"),
    DeleteUnreachable => ("Worker に接続できませんでした（消せたかを確かめられません）", "Could not reach the Worker (cannot confirm whether it was deleted)"),

    // ui/theme.rs
    ColorViolet => ("すみれ", "Violet"),
    ColorSky => ("空", "Sky"),
    ColorPink => ("桃", "Pink"),
    ColorAmber => ("琥珀", "Amber"),
    ColorEmerald => ("若葉", "Emerald"),
    ColorOrange => ("橙", "Orange"),
    ColorTeal => ("青緑", "Teal"),
    ColorGray => ("灰", "Gray"),

    // ui/clipboard.rs
    CopiedTitle => ("タイトルをコピーしました", "Copied the title"),
    CopiedTitleAndMemo => ("タイトルとメモをコピーしました", "Copied the title and memo"),
    CopiedCount => ("{0}件のタイトルとメモをコピーしました", "Copied the titles and memos of {0} tasks"),

    // ui/render/mod.rs
    PointsLabel => ("工数 {0}", "{0} pts"),
    SidebarRailTitle => (" 凪", " n"),
    SidebarViews => (" ビュー", " Views"),
    SidebarProjects => (" プロジェクト", " Projects"),
    ScreenLogbook => ("完了ログ", "Logbook"),
    ScreenCalendar => ("カレンダー", "Calendar"),
    ScreenTimeline => ("タイムライン", "Timeline"),
    ScreenShortcuts => ("ショートカット", "Shortcuts"),
    SidebarCreateHint => ("  N で作成", "  N to create"),
    JoinDot => (" ・ ", " · "),
    HeaderGap => ("　", "  "),
    ProjectArchived => ("アーカイブ済み", "Archived"),
    ViewList => ("リスト", "List"),
    AddMark => ("＋", "+"),
    BarSeparator => ("｜", "|"),
    ViewBoard => ("ボード", "Board"),
    HintBarAdd => ("Enter 追加して続ける  Esc 閉じる", "Enter add and continue  Esc close"),
    HintBarMemo => ("Enter / Esc 保存して欄を出る（メモは Esc か Ctrl+S）", "Enter / Esc save and leave (memo: Esc or Ctrl+S)"),
    HintBarDetail => ("↑↓ 欄を移る  Enter 直す・押す  x 完了  s 進行中  d 日付  D 締切  p プロジェクト  Esc 閉じる", "↑↓ field  Enter edit  x done  d date  D deadline  p project  Esc close"),
    HintBarSidebar => ("↑↓ リストを選ぶ  Enter 一覧へ  N プロジェクトを作成", "↑↓ pick list  Enter open  N new project"),
    HintBarCalendar => ("←→↑↓ 日  j/k その日の中  Enter 開く  < > 1日ずらす  [ ] 月  n 追加  f 絞り込み  ? キー", "←→↑↓ day  Enter open  <> shift  [ ] month  n add  f filter  ? keys"),
    HintBarTimeline => ("↑↓ タスク  Enter 開く  < > 1日ずらす  d 日付  D 締切  [ ] 週  n 追加  f 絞り込み  ? キー", "↑↓ task  Enter open  <> shift  d date  [ ] week  n add  f filter  ? keys"),
    HintBarShortcuts => ("文字で絞り込み  ↑↓ スクロール  Esc / ? 戻る", "Type to filter  ↑↓ scroll  Esc / ? back"),
    HintBarList => ("n 追加  x 完了  Enter 開く  t 今日  l あとで  d 日付  u 元に戻す  Ctrl+K 検索  ? キー", "n add  x done  Enter open  t today  d date  u undo  Ctrl+K find  ? keys"),
    StatusLoginExpired => ("ログインが切れました", "Login expired"),
    StatusOffline => ("オフライン：操作は保存できません", "Offline: changes cannot be saved"),
    StatusSaving => ("保存しています…", "Saving…"),
    StatusSavingShort => ("保存中…", "Saving…"),
    StatusSyncing => ("同期中…", "Syncing…"),
    StatusLocal => ("ローカル", "Local"),
    HintUndo => (" u 元に戻す ", " u undo "),
    CountSpacedMany => ("{0} 件", "{0} tasks"),
    CountSpacedOne => ("{0} 件", "{0} task"),
    SortedBy => ("並び方：{0}  ", "Sort: {0}  "),

    // ui/render/board.rs
    BoardHeaderPoints => (" ・ 工数 {0}", " · {0} pts"),

    // ui/render/calendar.rs
    FilterAll => ("すべて", "All"),
    ProjectNone => ("プロジェクトなし", "No project"),
    CalendarDayEmpty => ("  この日のタスクはありません（n で追加）", "  No tasks on this day (n to add)"),
    KindDeadline => ("◆ 締切 ", "◆ Due: "),
    CalendarMonthTitle => ("{0}年{1}", "{1} {0}"),
    FilterLabel => ("    絞り込み：{0}", "    Filter: {0}"),
    CalendarTodayCell => ("{0} 今日", "{0} Today"),
    CalendarMoreEntries => (" ほか {0} 件", " +{0}"),
    CalendarEntryCountMany => ("  {0} 件", "  {0} tasks"),
    CalendarEntryCountOne => ("  {0} 件", "  {0} task"),

    // ui/render/detail.rs
    LabelMemo => ("メモ", "Memo"),
    ChecklistAddItem => ("＋ 項目を追加", "+ Add item"),
    StatusCompleted => ("● 完了", "● Completed"),
    StatusInProgress => ("◐ 進行中", "◐ In progress"),
    StatusNotStarted => ("○ 未着手", "○ Not started"),
    LabelStatus => ("状態", "Status"),
    LabelWhen => ("いつやる", "When"),
    LabelDeadline => ("締切", "Deadline"),
    LabelProject => ("プロジェクト", "Project"),
    TitleTask => (" タスク ", " Task "),
    MoreMemoLines => ("  …ほか {0} 行", "  … more lines: {0}"),

    // ui/render/list.rs
    EmptyInbox => ("受信箱は空です", "Your inbox is empty"),
    HintAdd => ("n で追加", "n to add"),
    EmptyTodayAllDone => ("今日のタスクはすべて完了しました", "All of today's tasks are done"),
    EmptyToday => ("今日のタスクはまだありません", "No tasks for today yet"),
    EmptyUpcoming => ("予定のタスクはありません", "No upcoming tasks"),
    HintAddToInbox => ("n で追加（受信箱に入ります）", "n to add (goes to Inbox)"),
    EmptyLater => ("あとでのタスクはありません", "No tasks in Later"),
    EmptyLogbook => ("完了したタスクは、次の日からここに並びます", "Completed tasks show up here from tomorrow"),
    EmptyProject => ("このプロジェクトのタスクはまだありません", "No tasks in this project yet"),
    FoldToggleHint => ("   z で開く／閉じる", "   z to open / close"),
    MoreRows => ("  ほか {0} 件（一番下で ↓ を押すと続きを表示）", "  {0} more (press ↓ at the bottom to show more)"),

    // ui/render/overlay.rs
    DateScheduleLabel => ("やる日（日付を決めて予定へ）", "Date to do it (pick a date and schedule)"),
    DatePlaceholder => ("明日・金曜・来週月曜・3日後・10/3", "tomorrow, fri, next monday, in 3 days, 10/3"),
    DateHintSchedule => ("   今日以前の日付なら今日へ入ります", "   A date today or earlier goes to Today"),
    DateHintDeadline => ("   空のまま Enter で締切を外します", "   Press Enter on an empty box to clear the deadline"),
    DateUnreadable => ("   日付として読めません", "   Not a date"),
    ProjectPlaceholder => ("名前で探す・作る", "Search or create by name"),
    NoneIndented => ("     なし", "     None"),
    NoneZero => ("なし（0）", "None (0)"),
    LabelSortBy => ("並び方", "Sort"),
    PalettePlaceholder => ("コマンド・プロジェクト・タスクを探す", "Search commands, projects and tasks"),
    NotFoundIndented => ("   見つかりません", "   Not found"),
    ProjectColorTitle => ("プロジェクトの色", "Project color"),
    ProjectNamePlaceholder => ("プロジェクトの名前", "Project name"),
    ProjectRenameTitle => ("プロジェクトの名前を変更", "Rename project"),
    ProjectCreateTitle => ("プロジェクトを作成", "Create project"),
    TaskNamePlaceholder => ("タスクの名前", "Task name"),
    QuickTargetLabel => ("   行き先：", "   Destination: "),
    QuickSwitchHint => ("  （Tab で切り替え）", "  (Tab to switch)"),
    QuickAddTitle => ("追加", "Add"),
    NoKey => ("キーなし（Ctrl+K から）", "No key (use Ctrl+K)"),
    NotFound => ("  見つかりません", "  Not found"),
    FilterEmptyHint => ("絞り込み：文字を打つと絞り込めます", "Filter: type to narrow down"),
    FilterPrefix => ("絞り込み：", "Filter: "),
    ShortcutsQuit => ("q で終了", "q to quit"),
    ShortcutsBack => ("Esc で戻る", "Esc to go back"),
    LoginPanelDevice => ("GitHub でログインします", "Log in with GitHub"),
    LoginPanelCloud => ("GitHub でログインすると、クラウドと同期して使えます", "Log in with GitHub to sync with the cloud"),
    LoginPanelInviteOnly => ("クラウドとの同期は、いまは招待した人だけが使えます", "Cloud sync is invite only for now"),
    LoginPanelKeepLocal => ("この端末のタスクはそのまま残り、ログアウトすると戻ります", "Your tasks on this device stay as they are, and come back when you log out"),
    LoginPreparingCode => ("コードを用意しています…", "Getting a code ready…"),
    LoginStepOpenPanel => ("1. ブラウザでこの URL を開く", "1. Open this URL in your browser"),
    LoginStepCodePanel => ("2. このコードを入力して、承認する", "2. Enter this code and approve"),
    LoginWarnCode => ("この画面に出たコード以外は、承認しないでください", "Approve only the code shown on this screen"),
    CountedLabel => ("{0}件の{1}", "{1} for {0} tasks"),
    CreateProjectNamed => ("「{0}」を作成", "Create \"{0}\""),
    ColorPickHint => ("  {0}　←→ で選び、Enter で決める", "  {0}  ←→ to pick, Enter to confirm"),
    LoginEnterStart => ("Enter で始める　{0}", "Enter to start  {0}"),
    LoginEnterRetry => ("Enter でやり直す　{0}", "Enter to retry  {0}"),
    ServerLabel => ("接続先：{0}", "Server: {0}"),
    LoginWaitingRemaining => ("承認を待っています…（あと {0} 分 {1} 秒）", "Waiting for approval… ({0} min {1} s left)"),

    // ui/render/timeline.rs
    TimelineRange => ("1 週前から 8 週先まで", "From 1 week ago to 8 weeks ahead"),
    TimelineEmpty => ("  やる日か締切のあるタスクはありません（n で追加、d で日付）", "  No tasks with a date or deadline (n to add, d for a date)"),
}
