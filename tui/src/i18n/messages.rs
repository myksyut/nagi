//! 画面と CLI の文言の全部。文言を直すときは、ここだけを見ればよい。
//!
//! `鍵 => "日本語",` の形で書く。値の入る文は `{0}`・`{1}` の番号の穴で書き（`fill` が埋める）、
//! 言語で語順が変わっても書けるようにする。
//! 入力を読むための語（`dates.rs` の `relative_days` など、`cli.rs` の `list_name` の「受信箱」など）は
//! 読むためのものなので、ここには置かず今の場所に残してある。

/// 鍵の `enum Msg`・全部の鍵 `Msg::ALL`・日本語の文 `Msg::ja` を作る
macro_rules! messages {
    ($($key:ident => $ja:literal,)*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum Msg {
            $($key,)*
        }

        impl Msg {
            #[cfg(test)]
            pub const ALL: &'static [Msg] = &[$(Msg::$key,)*];

            pub fn ja(self) -> &'static str {
                const JA: &[&str] = &[$($ja,)*];
                JA[self as usize]
            }
        }
    };
}

messages! {
    // main.rs
    UsageHint => "{0}\n\n使い方は `nagi --help` で見られます",
    HelpPage => "{0}\n\n本番：{1}\n\n{2}",
    StartFailed => "起動できませんでした：{0}",
    ContinueWithoutLocalCopy => "{0}\n手元の控えと記録なしで続けます",
    LangUnsupported => "知らない言語です：{0}（使える値：{1}）",

    // data/net.rs（取り込み）
    NetImportBadResponse => "クラウドの応答を読めませんでした",
    NetImportServerError => "クラウドがエラーを返しました（{0}）",
    NetImportRowTooLarge => "{0} の行が大きすぎて、1 回に送れません（{1} KiB まで）",
    NetImportPartial => "{0}（{1} 件までは移してあります。もう一度実行すると、残りだけが入ります）",
    NetImportUnsupported => "このクラウドは、まだ取り込みに対応していません",
    NetImportBodyTooLarge => "本文が大きすぎて、クラウドが受け付けませんでした",
    NetImportRateLimited => "回数が多すぎます。1 分待ってから、もう一度実行してください",
    NetImportQuota => "クラウドの上限（タスク {0} 件、プロジェクト {1} 件）を超えるため、移せません",
    NetImportSchemaFallback => "クラウドが、この端末のデータを受け付けませんでした",
    NetImportRejectedStatus => "クラウドが受け付けませんでした（{0}）",
    NetImportPlaceProject => "プロジェクトの {0} 件目",
    NetImportPlaceTask => "タスクの {0} 件目",
    NetImportPlaceData => "データ",
    NetImportRejectedField => "この端末の{0}を、クラウドが受け付けませんでした（{1}：{2}）",
    NetImportRejectedRow => "この端末の{0}を、クラウドが受け付けませんでした（{1}）",

    // ui/login.rs・ui/render/overlay.rs（取り込み）
    LoginImportAllThere => "この端末のデータ {0} 件は、すべてクラウドにあります",
    LogImportCheckFailed => "取り込みの確かめに失敗しました: {0}",
    LoginImportChanged => "ログインが替わったため、移しませんでした",
    LoginImportChangedHint => "Ctrl+K の「この端末のデータをクラウドへ移す」から、もう一度確かめてください",
    LoginImportDone => "{0} 件をクラウドへ移しました。この端末のデータは消していません",
    ImportChecking => "この端末のデータを確かめています…",
    ImportEscClose => "Esc で閉じる",
    ImportRetryCheck => "Enter で確かめ直す　Esc で閉じる",
    ImportOfferTitle => "この端末の {0} 件をクラウドへ移しますか",
    ImportOfferCounts => "新しく {0} 件、もうある {1} 件",
    ImportOfferNote => "もうある分は入れません。この端末のデータは消しません",
    ImportOfferLater1 => "あとから Ctrl+K の「この端末のデータをクラウドへ",
    ImportOfferLater2 => "移す」で、いつでも移せます",
    ImportOfferKeys => "Enter で移す　Esc で移さない",
    ImportPreparing => "移す準備をしています…",
    ImportProgress => "移しています… {0} / {1} 件",
    ImportRetryRest => "Enter でもう一度（残りだけが入ります）　Esc で閉じる",

    // cli.rs
    CliHelp => "\
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
  --lang <言語>              画面の言語（いまは ja だけ）
  -h, --help                 この説明（nagi help、nagi add --help でも同じ）
  -V, --version              版

日付は「2026-10-09」「明日」「金曜」「来週月曜」「3日後」「10/3」などで書ける。
ログインのトークンは、環境変数 NAGI_TOKEN でも渡せる。
画面のキーの一覧は、起動してから ? で見られる",
    CliAddNeedsOneTitle => "add には、タイトルを1つ渡します（空白を含むときは引用符で囲む）",
    CliTitleEmpty => "タイトルが空です",
    CliListTakesOne => "list に渡せるリストは1つです",
    CliNoExtraArgs => "projects・login・logout・export・import には、ほかの引数を渡せません",
    CliJsonNotHere => "--json は、ここでは使えません",
    CliKeepExistingOnlyUpdate => "--keep-existing は update で使えます",
    CliDryRunOnlyImport => "--dry-run は import で使えます",
    CliNothingToImport => "この端末には、移すデータがありません",
    CliImportDryRun => "新しく {0} 件、もうある {1} 件（プロジェクト 新しく {2}・もうある {3}、タスク 新しく {4}・もうある {5}）",
    CliImportProgress => "{0} / {1} 件",
    CliImportDone => "{0} 件をクラウドへ移しました（もうあった {1} 件は、そのままにしています）。この端末のデータは消していません",
    CliImportDetached => "指すプロジェクトがなかったタスク {0} 件は、プロジェクトなしで入れました",
    CliDiscardUnsentOnlyLogout => "--discard-unsent は logout で使えます",
    CliNotLoggedIn => "ログインしていません。先に `nagi login` を実行してください",
    ThisDeviceData => "この端末のデータ",
    CliLoginExpiredRelogin => "ログインが切れています。`nagi login` でログインし直してください",
    SaveFailedConflict => "ほかの画面で先に変更されていたため、保存できませんでした",
    CliSaveRejectedByWorker => "保存できませんでした（Worker に受け付けられませんでした）",
    CliWorkerUnreachable => "Worker に接続できません",
    CliLoginExpiredCannotSend => "ログインが切れていて、送れません",
    CliContentRejected => "受け付けられない内容です",
    CliWhatDestination => "行き先",
    NoneLabel => "なし",
    ListCompleted => "完了",
    ListInbox => "受信箱",
    ListToday => "今日",
    ListScheduled => "予定",
    ListLater => "あとで",
    CliInProgressSuffix => "（進行中）",
    CliMemoHeading => "メモ：",
    CliChecklistHeading => "チェックリスト：",
    CliWhatDeadline => "締切",
    CliAddFailed => "追加できませんでした",
    CliAddedTaskNotFound => "追加したタスクが見つかりません",
    LoginCodeExpired => "コードの期限が切れました。もう一度やり直してください",
    LoginDenied => "GitHub で承認されませんでした",
    CliNothingToExport => "書き出すデータがありません",
    CliFileNameMissing => "ファイル名がありません",
    CliSingleId => "{0} には、タスクの id を1つ渡します",
    CliFlagNeedsValue => "--{0} には値が要ります",
    CliUnknownFlag => "知らない指定です：{0}",
    CliUnknownList => "知らないリストです：{0}（inbox・today・upcoming・later・completed・all）",
    CliDaysInvalid => "--days は 1 以上の数で渡します：{0}",
    CliUnknownCommand => "知らないコマンドです：{0}",
    CliFlagNotHere => "ここでは使えない指定です：--{0}",
    CliSaveNetwork => "保存できませんでした（{0} に接続できません）",
    CliCannotReach => "{0} に接続できません",
    CliNoResponse => "{0} からの応答がありません",
    CliCouldNotConnect => "{0} に接続できませんでした",
    CliDateUnreadable => "{0}を日付として読めません：{1}",
    CliPriorityInvalid => "優先度は high・medium・low で渡します：{0}",
    CliPointsInvalid => "工数は 1・2・3・5・8・13 のどれかで渡します：{0}",
    CliUnknownProject => "プロジェクト「{0}」がありません（今あるもの：{1}）",
    ListSeparator => "・",
    CliMetaPriority => "優先度 {0}",
    CliNoChecklistItem => "チェックリストに、その項目がありません：{0}",
    CliFlagOrFile => "--{0} と --{0}-file は、どちらか一方だけ渡します",
    CliFileUnreadable => "ファイルを読めません：{0}（{1}）",
    CliTaskNotFound => "タスクが見つかりません：{0}",
    CliChangedElsewhere => "ほかで変更されています（今の updatedAt は {0}）。読み直してから、もう一度実行してください",
    CliDetailList => "  リスト：{0}{1}",
    CliDetailScheduled => "  予定：{0}",
    CliDetailDeadline => "  締切：{0}（{1}）",
    CliDetailProject => "  プロジェクト：{0}",
    CliDetailPriority => "  優先度：{0}",
    CliDetailPoints => "  工数：{0}",
    CliDetailUpdated => "  更新：{0}",
    CliAddedTo => "{0}に追加しました：{1}",
    CliTodayHeading => "{0}（今日）",
    CliNoTasks => "タスクはありません",
    CliUpdated => "更新しました：{0}",
    CliNoChange => "変更はありません：{0}",
    CliAlreadyCompleted => "すでに完了しています：{0}",
    CliCompleted => "完了にしました：{0}",
    CliNoProjects => "プロジェクトはありません",
    CliProjectLine => "{0}（未完了 {1}）",
    CliLoginStepOpen => "1. ブラウザでこの URL を開く：{0}",
    CliLoginStepCode => "2. このコードを入力して、承認する：{0}",
    CliLoginWaiting => "承認を待っています…（ここに出たコード以外は、承認しないでください）",
    CliSaveTokenFailed => "トークンを保存できませんでした：{0}",
    CliLoggedIn => "ログインしました。クラウドと同期します",
    CliLocalDataKept => "この端末のタスクとプロジェクト（{0} 件）は、`nagi import` でクラウドへ移せます。移さなければ、そのまま残り、`nagi logout` で戻ります",
    LoginNotInvited => "この GitHub アカウントは、まだクラウドとの同期に招待されていません",
    UnsentCountFound => "送っていない変更が {0} 件あります",
    UnsentCountUnknown => "送っていない変更があるかを確かめられません（{0}）",
    CliLogoutRefused => "{0}。ログアウトすると消えるため、ログアウトしていません。消してよければ `nagi logout --discard-unsent` を実行してください",
    CliLoggedOut => "ログアウトしました",
    CliLoggedOutLocal => "ログアウトしました。このあとは、この端末のデータを使います",
    CliNotLoggedInShort => "ログインしていません",
    CliExportWriteFailed => "{0} に書き出せませんでした：{1}",

    // config.rs
    ConfigHomeMissing => "データの置き場を決められません。環境変数 HOME（か {0}）が設定されていません",
    ConfigCreateDirFailed => "{0} を作れませんでした：{1}",
    ConfigLocations => "置き場：\n  データ    {0}\n  ログイン  {1}\n  記録      {2}",

    // auth.rs
    AuthWorkerNotConfigured => "Worker のログインの設定が足りません",
    AuthGithubUnreachable => "GitHub とやり取りできませんでした（OAuth App でデバイスフローが有効か確かめてください）",
    AuthTooManyAttempts => "試行が多すぎます。1 分待ってください",
    WorkerUnreachable => "Worker に接続できませんでした",
    AuthResponseUnreadable => "ログインの応答が読めません",
    AuthStartFailed => "ログインを始められませんでした（HTTP {0}）",
    AuthResponseUnreadableWith => "ログインの応答が読めません（{0}）",
    AuthSaveLoginFailed => "ログインを保存できませんでした: {0}",

    // dates.rs
    WeekdaySun => "日",
    WeekdayMon => "月",
    WeekdayTue => "火",
    WeekdayWed => "水",
    WeekdayThu => "木",
    WeekdayFri => "金",
    WeekdaySat => "土",
    DateLong => "{0}月{1}日({2})",
    DateLongWithYear => "{0}年{1}月{2}日({3})",
    DateHeading => "{0}月{1}日 {2}曜日",
    DateHeadingWithYear => "{0}年{1}月{2}日 {3}曜日",
    DeadlineFar => "締切 {0}",
    DeadlineSoon => "あと{0}日",
    DeadlineToday => "今日まで",
    DeadlineOverdue => "{0}日超過",
    DateTomorrow => "明日",

    // model.rs
    PriorityHigh => "高",
    PriorityMedium => "中",
    PriorityLow => "低",

    // upgrade.rs
    UpgradeHint => "nagi を更新してください。`{0}`",
    UpgradeHintWithNote => "{0}。{1}",
    UpgradeUnreadablePending => "送っていない変更に、この nagi で読めないものがあります。{0}",
    WaitingForWorkerWithNote => "Worker の更新を待っています。{0}",
    WaitingForWorker => "Worker の更新を待っています",
    UnsentKept => "送っていない変更 {0} 件は残してあります",
    UnsentNotSaved => "送っていない変更 {0} 件を保存できていません。閉じると消えます",

    // data/mod.rs
    LogLocalDbOpenFailed => "手元の控えを開けないため、保存せずに動きます: {0}",
    LogPendingMoveFailed => "Worker ごとの控えに残した変更を、利用者の控えへ移せませんでした: {0}",

    // data/net.rs
    NetResetRepeated => "reset が続きました",

    // data/store.rs
    LimitTitle => "タイトルは {0} 文字まで",
    LimitMemo => "メモは {0} 文字まで",
    LimitChecklistItems => "チェックリストは {0} 項目まで",
    LimitChecklistItem => "チェックリストの項目は {0} 文字まで",
    LimitProjectName => "プロジェクト名は {0} 文字まで",
    QuotaTasks => "タスクは {0} 件まで",
    QuotaProjects => "プロジェクトは {0} 件まで",
    LogLocalCopyCleanFailed => "手元の控えを片付けられませんでした: {0}",
    LogLocalCopyReadFailed => "手元の控えを読めませんでした: {0}",
    LogUnreadablePending => "送っていない変更に、この nagi で読めないものがあります",
    LogPendingReadFailed => "送っていない変更を手元の控えから読めませんでした: {0}",
    LogSyncFailed => "差分を取得できませんでした: {0}",
    LogApiVersionRequired => "Worker は API の版 {0} 以上を求めています（この nagi は {1}）",
    LogMalformedMutations => "操作の形が正しくありません: {0}",
    LogMutationRejected => "保存を受け付けられませんでした: {0} {1}",
    LogLocalSaveFailed => "手元の控えに保存できませんでした: {0}",
    LogTimeZoneUnreadable => "Worker が返したタイムゾーン {0} を、そのままでは読めません",
    LogTimeZoneUnusable => "Worker が返したタイムゾーン {0} を読めないため、{1} のままにします",

    // data/device.rs
    LogDeviceReadWriteFailed => "この端末のデータを読み書きできませんでした: {0}",
    DeviceNewerFormatBy => "この端末のデータ（{0}）は nagi {1} で作られました。nagi を {1} 以降に更新してください",
    DeviceNewerFormat => "この端末のデータ（{0}）は、新しい版の nagi のものです。nagi を更新してください",
    DeviceOpenFailed => "この端末のデータ（{0}）を開けませんでした：{1}",
    DeviceCreateFailed => "この端末のデータ（{0}）を作れませんでした：{1}",
    DeviceBackupFailed => "この端末のデータ（{0}）を移す前の控え（{1}）を取れなかったので、移さずに止めました：{2}",
    DeviceMigrateFailed => "この端末のデータ（{0}）を版 {1} から版 {2} に移せなかったので、元のまま残しました：{3}。移す前の控えは {4} にあります",
    DeviceRowMissing => "書き込む行がありません: {0}",

    // data/sort.rs
    SortManual => "手動",
    SortPriority => "優先度",
    SortPointsAsc => "工数が少ない順",
    SortPointsDesc => "工数が多い順",

    // ui/mod.rs
    LoginExpiredRelogin => "ログインが切れました。もう一度ログインしてください",

    // ui/app.rs
    LabelPriority => "優先度",
    LabelPoints => "工数",
    AddToInbox => "受信箱に追加",
    AddToToday => "今日に追加",
    AddToLater => "あとでに追加",
    ToastOfflineBlocked => "オフラインのため、操作できません",
    ToastUndoConflict => "ほかの画面で先に変更されていたため、元に戻せませんでした",
    SaveFailed => "保存できませんでした",
    InputKeptInAddBox => "追加した文字は、追加欄（n）に戻してあります",
    FoldCompleted => "完了 {0}件",
    LogTimeZoneSaveFailed => "タイムゾーンを保存できませんでした: {0}",
    ToastTimeZoneSet => "タイムゾーンを {0} にしました",

    // ui/keys.rs
    GroupTask => "タスク",
    GroupWhen => "いつやる",
    GroupMove => "移動",
    GroupList => "リスト",
    GroupGlobal => "全体",
    KeyDown => "下へ",
    KeyUp => "上へ",
    KeyExtendDown => "選択を下へ広げる",
    KeyExtendUp => "選択を上へ広げる",
    KeyTop => "一番上へ",
    KeyBottom => "一番下へ",
    KeyReorderUp => "並べ替え（上へ）",
    KeyReorderDown => "並べ替え（下へ）",
    KeyAdd => "追加",
    KeyOpen => "開く",
    KeyClose => "閉じる",
    KeyComplete => "完了（もう一度で戻す）",
    KeyStart => "進行中にする／未着手に戻す",
    KeyToToday => "今日へ",
    KeyToLater => "あとでへ",
    KeySchedule => "日付を決めて予定へ",
    KeyDeadline => "締切",
    KeyProject => "プロジェクト",
    KeyPriority => "優先度",
    KeyPoints => "工数",
    KeyDelete => "削除",
    KeyCopy => "タイトルとメモをコピー",
    KeyUndo => "元に戻す",
    KeyGoInbox => "受信箱を開く",
    KeyGoToday => "今日を開く",
    KeyGoUpcoming => "予定を開く",
    KeyGoLater => "あとでを開く",
    KeyGoLogbook => "完了ログを開く",
    KeyGoCalendar => "カレンダーを開く",
    KeyGoTimeline => "タイムラインを開く",
    PlaceTodayProject => "今日・プロジェクト",
    KeyToggleBoard => "リスト／ボードの切り替え",
    PlaceBoard => "ボード",
    KeyColumnLeft => "左の列へ",
    KeyColumnRight => "右の列へ",
    PlaceTodayLaterProject => "今日・あとで・プロジェクト",
    KeySortMenu => "並び方を選ぶ",
    KeyToggleFold => "「完了 N件」を開く／閉じる",
    KeyCreateProject => "プロジェクトを作成",
    PlaceProject => "プロジェクト",
    KeyRenameProject => "プロジェクトの名前を変更",
    KeyArchiveProject => "プロジェクトをアーカイブ（もう一度で解除）",
    KeyProjectColor => "プロジェクトの色",
    PlaceCalendar => "カレンダー",
    KeyPrevDay => "前の日へ",
    KeyNextDay => "次の日へ",
    KeyPrevWeek => "前の週へ",
    KeyNextWeek => "次の週へ",
    KeyEntryDown => "その日の中で下へ",
    KeyEntryUp => "その日の中で上へ",
    KeyBackToToday => "今日の日へ戻る",
    PlaceTimeline => "タイムライン",
    KeyTimelineDown => "下のタスクへ",
    KeyTimelineUp => "上のタスクへ",
    PlaceCalendarTimeline => "カレンダー・タイムライン",
    KeyPrevPeriod => "前の月・前の週へ",
    KeyNextPeriod => "次の月・次の週へ",
    KeyShiftBack => "1日前へずらす",
    KeyShiftForward => "1日後へずらす",
    KeyFilterProject => "プロジェクトで絞り込む",
    KeyFocusSidebar => "サイドバーへ移る",
    KeyToggleSidebar => "サイドバーを畳む・広げる",
    KeyPalette => "検索とコマンド",
    PlaceShortcuts => "ショートカット",
    KeyShortcutsClose => "ショートカットを閉じる",
    KeyShortcuts => "ショートカットの一覧",
    KeySync => "今すぐ同期",
    KeyLogin => "クラウドと同期する（ログイン。いまは招待制）",
    KeyLogout => "ログアウト",
    KeyImportLocal => "この端末のデータをクラウドへ移す",
    KeyQuit => "終了",
    FieldAddBox => "追加欄",
    FieldAddContinue => "追加して続ける",
    FieldClose => "閉じる",
    FieldOpenTask => "開いたタスク",
    FieldMove => "欄を移る",
    FieldEdit => "欄を直す・押す",
    FieldSaveMemo => "直した文字を保存して欄を出る（メモ）",
    FieldChecklist => "チェックリスト",
    FieldCheckToggle => "チェックを付ける・外す",
    FieldRename => "名前を直す",
    FieldRemoveItem => "項目を消す",
    FieldMoveItem => "項目を上・下へ",
    FieldDateInput => "日付の入力（d・D）",
    FieldDecide => "決める",
    FieldClearDeadline => "締切を外す（空のまま）",
    FieldCancel => "やめる",
    FieldProjectPicker => "p の候補",
    FieldPickCandidate => "候補を選ぶ",
    FieldDecideCreate => "決める（「◯◯」を作成も）",
    FieldPriorityPoints => "優先度・工数の候補",
    FieldQuickPriority => "その場で決める（優先度：1 高・2 中・3 低・0 なし）",
    FieldSortList => "並び方の一覧",
    FieldQuickSort => "その場で決める（1 手動・2 優先度・3 工数が少ない順・4 工数が多い順）",
    FieldQuickAdd => "小さな追加欄（カレンダー・タイムライン）",
    FieldSwitchTarget => "行き先を切り替える",
    FieldRunOpen => "実行する・開く",
    FieldSidebar => "サイドバー",
    FieldPickList => "リストを選ぶ",
    FieldBackToList => "一覧へ戻る",
    ToastSyncing => "同期しています",
    KeySortBy => "並び方：{0}",

    // ui/commands.rs
    ToastCompleted => "完了しました",
    ToastDeleted => "削除しました",
    ToastCopyFailed => "コピーできませんでした",
    ToastCannotArchive => "アーカイブできません",
    ManualOrderOnly => "手動の並びのときに使えます",
    ToastTooMany => "一度に扱えるのは {0} 件まで",
    CountItems => "{0}件",
    ToastCompletedCount => "{0}件を完了しました",
    ToastBackToToday => "{0}を今日に戻しました",
    ToastMovedTo => "{0}を{1}へ",
    ToastDeadlinesCleared => "{0}件の締切を外しました",
    ToastDeadlinesSet => "{0}件の締切を{1}にしました",
    ToastToToday => "{0}を今日へ",
    ToastDatesShifted => "{0}件の日付をずらしました",
    ToastBackToInProgress => "{0}件を進行中に戻しました",
    ToastBackToNotStarted => "{0}件を未着手に戻しました",
    ToastStarted => "{0}件を進行中にしました",
    ToastDeletedCount => "{0}件を削除しました",
    ToastProjectCleared => "{0}のプロジェクトを外しました",
    ToastProjectSet => "{0}を「{1}」へ",
    ToastPrioritySet => "{0}件の優先度を{1}にしました",
    ToastPriorityCleared => "{0}件の優先度を外しました",
    ToastPointsSet => "{0}件の工数を {1} にしました",
    ToastPointsCleared => "{0}件の工数を外しました",
    ToastArchived => "「{0}」をアーカイブしました",
    ToastOpenTasksRemain => "未完了のタスクが {0} 件残っています",
    ToastAddedTo => "{0}に追加しました",

    // ui/input.rs
    InputKeptInField => "打った文字は欄に残してあります",
    LocationWithProject => "{0}・{1}",

    // ui/list.rs
    ColumnNotStarted => "未着手",
    ColumnInProgress => "進行中",
    ColumnCompleted => "完了",

    // ui/login.rs
    DataOpenFailed => "データを開けませんでした",
    LoginSyncStartedKeepLocal => "クラウドと同期します。この端末のタスクはそのまま残り、ログアウトすると戻ります",
    UnsentUnknownLogoutWarning => "送っていない変更があるかを確かめられません。ログアウトすると消えます",
    LogoutAgainHint => "もう一度ログアウトを選ぶと、消してログアウトします",
    DevServerNoLogin => "手元の開発サーバーでは、ログインなしで使っています",
    LoggedOutNotice => "ログアウトしました",
    LoggedOutLocalToast => "ログアウトしました。この端末のデータに戻りました",
    LogSaveTokenFailed => "トークンを保存できませんでした: {0}",
    UnsentCountLogoutWarning => "送っていない変更が {0} 件あります。ログアウトすると消えます",
    AccountDeletedNotice => "クラウドのアカウントを消しました",
    AccountDeletedToast => "クラウドのアカウントを消しました。この端末のデータに戻りました",
    AccountDeleteFailed => "アカウントを消せませんでした",
    AccountDeleteNoOwner => "ログインの持ち主を確かめられないため、消せません",
    AccountDeleteRelogin => "`nagi login` でログインし直してください",
    KeyDeleteAccount => "アカウントを削除",

    // ui/render/overlay.rs（アカウントの削除）
    AccountDeleteTitle => "アカウントを削除",
    AccountDeleteHeading => " クラウドのアカウントとデータを消します",
    AccountDeleteCounts => " タスク {0} 件、プロジェクト {1} 件",
    AccountDeleteNotice => "消すと元に戻せません。先に `nagi export` で書き出せます。この端末のデータ（local.db）は消えません。",
    AccountDeleting => " 消しています…",
    AccountDeletePlaceholder => "delete と打って Enter（Esc でやめる）",

    // cli.rs（アカウントの削除と書き出し）
    CliAccountUsage => "account の使い方は `nagi account delete` です",
    CliYesOnlyAccountDelete => "--yes は account delete で使えます",
    CliExportReadFailed => "書き出しの応答を読めませんでした：{0}",
    CliExportRateLimited => "回数の制限にかかったので、{0} 秒待ってから続けます",
    CliAccountDeleteNoOwner => "ログインしていません（利用者を確かめられません）。先に `nagi login` を実行してください",
    CliAccountDeleteWarning => "{0} のアカウントとデータを消します（タスク {1} 件、プロジェクト {2} 件）。元に戻せません",
    CliAccountDeleteExportHint => "先に `nagi export` で書き出せます。この端末のデータ（local.db）は消しません",
    CliAccountDeletePrompt => "消すなら delete と打ってください：",
    CliReadInputFailed => "入力を読めませんでした：{0}",
    CliAccountDeleteDeclined => "消しませんでした（何も消していません）",
    CliAccountDeleted => "クラウドのアカウントを消しました",

    // data/net.rs（アカウントの削除と書き出し）
    ExportFailedHttp => "書き出せませんでした（HTTP {0}）",
    DeleteLoginExpired => "ログインが切れています。`nagi login` でログインし直してください（何も消していません）",
    DeleteIdMismatch => "利用者の ID が合いませんでした（何も消していません）",
    DeleteFailedHttp => "消せませんでした（HTTP {0}）",
    DeleteUnreachable => "Worker に接続できませんでした（消せたかを確かめられません）",

    // ui/theme.rs
    ColorViolet => "すみれ",
    ColorSky => "空",
    ColorPink => "桃",
    ColorAmber => "琥珀",
    ColorEmerald => "若葉",
    ColorOrange => "橙",
    ColorTeal => "青緑",
    ColorGray => "灰",

    // ui/clipboard.rs
    CopiedTitle => "タイトルをコピーしました",
    CopiedTitleAndMemo => "タイトルとメモをコピーしました",
    CopiedCount => "{0}件のタイトルとメモをコピーしました",

    // ui/render/mod.rs
    PointsLabel => "工数 {0}",
    SidebarRailTitle => " 凪",
    SidebarViews => " ビュー",
    SidebarProjects => " プロジェクト",
    ScreenLogbook => "完了ログ",
    ScreenCalendar => "カレンダー",
    ScreenTimeline => "タイムライン",
    ScreenShortcuts => "ショートカット",
    SidebarCreateHint => "  N で作成",
    JoinDot => " ・ ",
    ProjectArchived => "アーカイブ済み",
    ViewList => "リスト",
    ViewBoard => "ボード",
    HintBarAdd => "Enter 追加して続ける  Esc 閉じる",
    HintBarMemo => "Enter / Esc 保存して欄を出る（メモは Esc か Ctrl+S）",
    HintBarDetail => "↑↓ 欄を移る  Enter 直す・押す  x 完了  s 進行中  d 日付  D 締切  p プロジェクト  Esc 閉じる",
    HintBarSidebar => "↑↓ リストを選ぶ  Enter 一覧へ  N プロジェクトを作成",
    HintBarCalendar => "←→↑↓ 日  j/k その日の中  Enter 開く  < > 1日ずらす  [ ] 月  n 追加  f 絞り込み  ? キー",
    HintBarTimeline => "↑↓ タスク  Enter 開く  < > 1日ずらす  d 日付  D 締切  [ ] 週  n 追加  f 絞り込み  ? キー",
    HintBarShortcuts => "文字で絞り込み  ↑↓ スクロール  Esc / ? 戻る",
    HintBarList => "n 追加  x 完了  Enter 開く  t 今日  l あとで  d 日付  u 元に戻す  Ctrl+K 検索  ? キー",
    StatusLoginExpired => "ログインが切れました",
    StatusOffline => "オフライン：操作は保存できません",
    StatusSaving => "保存しています…",
    StatusSavingShort => "保存中…",
    StatusSyncing => "同期中…",
    StatusLocal => "ローカル",
    HintUndo => " u 元に戻す ",
    CountSpaced => "{0} 件",
    SortedBy => "並び方：{0}  ",

    // ui/render/board.rs
    BoardHeaderPoints => " ・ 工数 {0}",

    // ui/render/calendar.rs
    FilterAll => "すべて",
    ProjectNone => "プロジェクトなし",
    CalendarDayEmpty => "  この日のタスクはありません（n で追加）",
    KindDeadline => "◆ 締切 ",
    CalendarMonthTitle => "{0}年{1}月",
    FilterLabel => "    絞り込み：{0}",
    CalendarTodayCell => "{0} 今日",
    CalendarMoreEntries => " ほか {0} 件",
    CalendarEntryCount => "  {0} 件",

    // ui/render/detail.rs
    LabelMemo => "メモ",
    ChecklistAddItem => "＋ 項目を追加",
    StatusCompleted => "● 完了",
    StatusInProgress => "◐ 進行中",
    StatusNotStarted => "○ 未着手",
    LabelStatus => "状態",
    LabelWhen => "いつやる",
    LabelDeadline => "締切",
    LabelProject => "プロジェクト",
    TitleTask => " タスク ",
    MoreMemoLines => "  …ほか {0} 行",

    // ui/render/list.rs
    EmptyInbox => "受信箱は空です",
    HintAdd => "n で追加",
    EmptyTodayAllDone => "今日のタスクはすべて完了しました",
    EmptyToday => "今日のタスクはまだありません",
    EmptyUpcoming => "予定のタスクはありません",
    HintAddToInbox => "n で追加（受信箱に入ります）",
    EmptyLater => "あとでのタスクはありません",
    EmptyLogbook => "完了したタスクは、次の日からここに並びます",
    EmptyProject => "このプロジェクトのタスクはまだありません",
    FoldToggleHint => "   z で開く／閉じる",
    MoreRows => "  ほか {0} 件（一番下で ↓ を押すと続きを表示）",

    // ui/render/overlay.rs
    DateScheduleLabel => "やる日（日付を決めて予定へ）",
    DatePlaceholder => "明日・金曜・来週月曜・3日後・10/3",
    DateHintSchedule => "   今日以前の日付なら今日へ入ります",
    DateHintDeadline => "   空のまま Enter で締切を外します",
    DateUnreadable => "   日付として読めません",
    ProjectPlaceholder => "名前で探す・作る",
    NoneIndented => "     なし",
    NoneZero => "なし（0）",
    LabelSortBy => "並び方",
    PalettePlaceholder => "コマンド・プロジェクト・タスクを探す",
    NotFoundIndented => "   見つかりません",
    ProjectColorTitle => "プロジェクトの色",
    ProjectNamePlaceholder => "プロジェクトの名前",
    ProjectRenameTitle => "プロジェクトの名前を変更",
    ProjectCreateTitle => "プロジェクトを作成",
    TaskNamePlaceholder => "タスクの名前",
    QuickTargetLabel => "   行き先：",
    QuickSwitchHint => "  （Tab で切り替え）",
    QuickAddTitle => "追加",
    NoKey => "キーなし（Ctrl+K から）",
    NotFound => "  見つかりません",
    FilterEmptyHint => "絞り込み：文字を打つと絞り込めます",
    FilterPrefix => "絞り込み：",
    ShortcutsQuit => "q で終了",
    ShortcutsBack => "Esc で戻る",
    LoginPanelDevice => "GitHub でログインします",
    LoginPanelCloud => "GitHub でログインすると、クラウドと同期して使えます",
    LoginPanelInviteOnly => "クラウドとの同期は、いまは招待した人だけが使えます",
    LoginPanelKeepLocal => "この端末のタスクはそのまま残り、ログアウトすると戻ります",
    LoginPreparingCode => "コードを用意しています…",
    LoginStepOpenPanel => "1. ブラウザでこの URL を開く",
    LoginStepCodePanel => "2. このコードを入力して、承認する",
    LoginWarnCode => "この画面に出たコード以外は、承認しないでください",
    CountedLabel => "{0}件の{1}",
    CreateProjectNamed => "「{0}」を作成",
    ColorPickHint => "  {0}　←→ で選び、Enter で決める",
    LoginEnterStart => "Enter で始める　{0}",
    LoginEnterRetry => "Enter でやり直す　{0}",
    ServerLabel => "接続先：{0}",
    LoginWaitingRemaining => "承認を待っています…（あと {0} 分 {1} 秒）",

    // ui/render/timeline.rs
    TimelineRange => "1 週前から 8 週先まで",
    TimelineEmpty => "  やる日か締切のあるタスクはありません（n で追加、d で日付）",
    MonthLabel => "{0}月",
}
