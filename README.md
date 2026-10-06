# nagi

ターミナルで使う TODO アプリ。TUI から、キーボードだけで素早くタスクを片付ける。データは利用者ごとに分かれていて、ほかの利用者のタスクは見えない。

名前は凪（なぎ）から。慌ただしい仕事のタスクを、静かに片付けていく道具。

## 構成

クライアントは Rust の TUI（`tui/`、バイナリの名前は `nagi`）。サーバーは Cloudflare Workers の Worker（Hono）で、データは Cloudflare D1 に置く。TUI は Worker の API（`/api/sync`・`/api/mutate`）でデータをやり取りする。

```text
tui/             # Rust の TUI（バイナリの名前は nagi）
src/
├── worker/      # Hono の API（/api/*）とログイン（/auth/*）。同期の API は worker/sync
└── shared/      # Worker が使う型・検証スキーマ・論理日付・並び順キー・API の版
migrations/      # D1 のマイグレーション（Drizzle で生成し、wrangler で適用）
scripts/         # 手元の D1 に、試すためのデータを入れるスクリプト
wrangler.jsonc   # Worker・D1 の設定
```

Worker がすべてのリクエストを受ける（画面のファイルは配らない）。

版ごとのプレビュー URL は止めてある（`wrangler.jsonc` の `preview_urls: false`）。出したままだと、Web 版だったころの古い版の画面が、その URL から開けてしまうため。

| 口 | 内容 |
| --- | --- |
| `POST /auth/device/start` | ログインを始める（GitHub のデバイスフロー）。ログイン不要 |
| `POST /auth/device/token` | 承認されたかを1回聞く。承認されていれば、セッションのトークンと利用者の ID を返す |
| `POST /auth/logout` | `Authorization: Bearer <token>` のセッションを消す（204） |
| `GET /api/session` | ログインしているかと、だれとしてかを確かめる（`{"authenticated":true,"userId":"…"}`） |
| `POST /api/sync`・`POST /api/mutate` | 差分の取得と、操作の書き込み。形は `src/shared/api.ts`・`src/shared/mutations.ts` |

- `/api/*` には `Authorization: Bearer <token>` が要る。なし・無効・期限切れは 401 `{"error":"unauthorized"}`。セッションの期限は 1 年で、使うたびに（1 日 1 回まで）延びる。D1 にはトークンの SHA-256 だけを置く
- 書き込み（POST）は、本文が JSON（`Content-Type: application/json`）でなければ 415。`Origin` は、付いているときだけ Worker の URL と同じかを確かめる（違えば 403）。ブラウザは POST に必ず `Origin` を付けるので、別のサイトからの書き込みは止まり、`Origin` を付けない TUI は通る
- `/api/sync` と `/api/mutate` には `X-Api-Version`（`src/shared/api.ts` の `API_VERSION`）を付ける（違えば 409）
- それ以外の URL は 404 `{"error":"not_found"}`

### 利用者

データは利用者ごとに分かれる。タスク・プロジェクト・同期の通し番号（seq）・日付の切り替え・セッションは、どれも利用者のもので、`/api/*` はログインしている利用者の行だけを読み書きする（ほかの利用者の行は、ID を知っていても、読めず・書けず・検証にも入らない。`src/worker/sync/isolation.test.ts` で確かめている）。利用者は、GitHub のアカウントで初めてログインしたときにできる。

だれがログインできるかは、`wrangler.jsonc` の `vars` で決める（`src/worker/auth/users.ts`）。

| 設定 | 意味 |
| --- | --- |
| `OWNER_GITHUB_USER_ID` | 持ち主の GitHub ユーザー ID。利用者を分ける前（`migrations/0004` より前）からあったデータは、この人のものになる。いつでもログインできる |
| `SIGNUP` | `allowlist`（既定）なら、持ち主と `ALLOWED_GITHUB_USER_IDS` の人だけがログインできる。`open` なら、GitHub のアカウントがあればだれでも登録できる |
| `ALLOWED_GITHUB_USER_IDS` | `allowlist` のときにログインできる GitHub ユーザー ID（カンマ区切り）。ID は `https://api.github.com/users/<ユーザー名>` の `id` |

- 人を足すときは、`ALLOWED_GITHUB_USER_IDS` に ID を足して main に入れる（デプロイされる）。その人が `nagi login` すると、空の状態から使い始められる
- 一覧から外した人は、ログインできなくなり、すでに出ているセッションも、次に使ったときに消える（`/api/*` は、セッションの持ち主がいまの設定でも使える人かを毎回確かめる）。データは残るので、一覧に戻せば、ログインし直して続きから使える
- 設定が正しくないと（ID が数でない、`SIGNUP` が知らない値、だれもログインできない、など）、ログインも `/api/*` も、だれも通さない（500 `{"error":"config"}`）
- 持ち主の行は、最初にログインした持ち主のもののままで、あとから `OWNER_GITHUB_USER_ID` を変えても移らない。持ち主に設定する前に、その人が許可した人として登録されていると、あとから設定しても持ち主にはならない（その人の利用者は、すでに別にあるため）
- TUI の手元の複製は、いまはサーバーごとに 1 つで、利用者ごとには分かれていない。同じ PC で別の GitHub アカウントに入り直すときは、先に `nagi logout` する（手元の複製が消える）。ログアウトせずに入り直すと、前のアカウントの行が手元に残って混ざる
- 日付の切り替えの時刻（午前 4 時）は、いまは全員が `APP_TIMEZONE`（日本時間）で決まる
- 手元の開発（`AUTH_DISABLED`）では、持ち主として動く

### ログイン（GitHub のデバイスフロー）

GitHub とやり取りするのは Worker だけで、GitHub のアクセストークンは Worker の外に出さない（ユーザー ID を確かめたら捨てる）。

1. TUI が `POST /auth/device/start`（本文 `{}`）を呼ぶ。応答は `{ deviceCode, userCode, verificationUri, expiresIn, interval }`
2. 利用者が `verificationUri`（<https://github.com/login/device>）を開いて `userCode` を打ち込み、承認する
3. TUI が `interval` 秒ごとに `POST /auth/device/token`（本文 `{ "deviceCode": "…" }`）を呼ぶ。応答は HTTP 200 で、`status` で分かれる

   | `status` | 意味 |
   | --- | --- |
   | `pending` | まだ承認されていない（同じ間隔でまた聞く） |
   | `slow_down` | 聞くのが速すぎる。次からは `interval`（秒）あける |
   | `expired` | コードの期限が切れた・コードが違う（1 からやり直す） |
   | `denied` | 利用者が GitHub で拒否した |
   | `forbidden` | 承認されたが、ログインできない GitHub ユーザーだった（利用者もセッションも作らない） |
   | `ok` | ログインできた。`token`（セッションのトークン）・`expiresAt`（期限。ISO 8601）・`userId`（利用者の ID）が付く |

4. そのあとは、`Authorization: Bearer <token>` を付けて `/api/*` を呼ぶ

失敗の応答：設定の不備（`GITHUB_CLIENT_ID`、だれがログインできるかの `OWNER_GITHUB_USER_ID`・`SIGNUP`・`ALLOWED_GITHUB_USER_IDS`）は 500 `{"error":"config"}`、GitHub とのやり取りの失敗（OAuth App のデバイスフローが無効のときも）は 502 `{"error":"github"}`（理由は Worker のログに残る）、`/auth/device/token` の本文の形が違えば 400 `{"error":"invalid_request"}`。

## TUI

ターミナルで動くクライアント（Rust + [ratatui](https://ratatui.rs/)）。左にサイドバー、右に今の画面、一番下に今使えるキーと通信の状態を出す。操作はキーボードだけで行う（マウスは使わない）。

### 入れ方

- **Releases から**：[GitHub の Releases](https://github.com/myksyut/nagi/releases) の `tui-v…` から、自分の環境のファイル（Mac は `nagi-aarch64-apple-darwin.tar.gz`、Linux は `nagi-x86_64-unknown-linux-gnu.tar.gz`）を落として展開し、`nagi` を PATH の通った場所に置く。Mac でブラウザから落としたときは、`xattr -d com.apple.quarantine nagi` を実行してから使う（Apple の開発者の署名はしていない）。`gh release download --repo myksyut/nagi --pattern 'nagi-aarch64-apple-darwin.tar.gz'` で落とせば、この手間は要らない
- 入っている版は `nagi --version` で分かる（Release のタグ `tui-v0.1.<番号>` と同じ番号。手元でビルドしたものは `Cargo.toml` の版）
- **手元でビルド**：Rust（1.88 以降）と C のコンパイラ（SQLite を一緒にビルドする）を入れて、`cargo install --path tui`。M7 には Rust を入れていないので、nix で一時的に使う

  ```sh
  cd tui
  nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc -c cargo build --release   # target/release/nagi
  ```

### 起動とログイン

```sh
nagi                                   # 本番（https://nagi.wizard1026miya.workers.dev）につなぐ
nagi --server http://localhost:5317    # 手元の Worker（pnpm dev）につなぐ。環境変数 NAGI_SERVER でも渡せる
```

- 初めて起動すると、ログインの画面が出る（画面を開かずに `nagi login` でもよい）。Enter を押すと URL（<https://github.com/login/device>）とコードが出るので、手元のブラウザで開いてコードを打ち込み、承認する。承認されると自動で一覧に移る。**画面に出たコード以外は承認しない**（`/auth/device/start` は誰でも呼べるので、他人が出したコードを承認すると、その相手にセッションが渡る）
- ログインのトークンは `~/.config/nagi/session-<接続先>.json`（自分だけが読める）に置く。期限は 1 年で、使うたびに延びる。Ctrl+K の「ログアウト」で、Worker のセッション・手元のトークン・手元の控えを消す
- 手元の Worker（`localhost`）は `AUTH_DISABLED` でログインなしで使える
- データの控えは `~/.local/share/nagi/<接続先>.db`（SQLite）。起動するとまず控えを読んで描き、そのあと差分を取る。記録は `~/.local/share/nagi/nagi.log`、画面の覚え書き（リスト｜ボード・並び方）は `~/.config/nagi/prefs.json`（置き場は `XDG_CONFIG_HOME`・`XDG_DATA_HOME` で変えられる）
- ほかの端末の変更は、45 秒ごと・端末にフォーカスが戻ったとき・Ctrl+R で取り込む
- オフラインのあいだは、控えを読めるが操作は受け付けない（一番下に「オフライン」と出る。つながると自動で戻る）。送ったあとに保存できなかった操作は、表示を元に戻して知らせる。保存できなかった追加の文字は、追加欄（n）の下書きに戻る
- 終了は q（入力欄の中では Ctrl+C）。送信中の操作があれば、保存されるのを最長 4 秒待ってから終わる

### 画面

| 画面 | キー | 中身 |
| --- | --- | --- |
| 受信箱・今日・予定・あとで・完了ログ | 1〜5 | リスト。今日とプロジェクトは v でボード（未着手・進行中・完了の列）に切り替わる。今日・あとで・プロジェクトは o で並び方（手動・優先度・工数）を選べる |
| カレンダー | 6 | 月の表。日のマスに締切の◆とタスク。下に、選んでいる日の一覧。←→↑↓ で日、j/k でその日の中、[ ] で月、< > で1日ずらす（タスクは予定の日付、◆は締切） |
| タイムライン | 7 | 1 週前から 8 週先まで。プロジェクトごとに、やる日から締切までの棒と◆。< > で、やる日と締切を同じ日数ずらす。[ ] で1週ずつ横に送る |
| プロジェクト | サイドバー（Tab）か Ctrl+K | 今日／予定／あとで／受信箱のまとまりと「完了 N件」。⇧N で作成、⇧R で名前の変更、⇧C で色、⇧A でアーカイブ |
| ショートカット | ? | すべてのキー。文字を打つと絞り込める |

タスクへの主なキー：n 追加、Enter 開く、x 完了（もう一度で戻す）、s 進行中、t 今日へ、l あとでへ、d 日付を決めて予定へ、⇧D 締切、p プロジェクト、⇧P 優先度、e 工数、y コピー、Del 削除、u 元に戻す、⇧↑↓（⇧J・⇧K）で複数選択、Alt+↑↓ で並べ替え、Ctrl+K（: や / でも）で検索とコマンド。`\` でサイドバーを畳む・広げる（印だけの細い帯。その端末に覚える）。

- 日付の入力（d・⇧D）は「明日」「金曜」「来週月曜」「3日後」「10/3」などを読む（`tui/src/dates.rs` の `parse_date_input`）
- Enter で開いたタスクは、一覧ではその行の場所に広がり、ボード・カレンダー・タイムラインでは小さな詳細として重なる。↑↓ で欄（タイトル・メモ・チェックリスト・状態・いつやる・締切・プロジェクト・優先度・工数）を移り、Enter で直す・押す。タイトル・メモ・チェックリストの項目の名前は、欄を出たときに保存する（元に戻すの対象にしない）
- y（c でもよい）は、選んでいるタスクのタイトルとメモをクリップボードに入れる（1行目にタイトル、空の行をはさんでメモ。何件かあるときは `---` の行で区切る。`tui/src/ui/clipboard.rs`）。端末のクリップボードには OSC 52 のエスケープシーケンスで入れるので、SSH の先で動かしていても手元の端末に届く。受け取るかどうかは端末の設定による（iTerm2 は「Applications in terminal may access clipboard」を有効にする。tmux の中で使うときは `set -g set-clipboard on`）
- 日本語の入力は、端末の IME にそのまま任せる

### CLI（画面なし）

エージェントや定期の実行から使うためのコマンド。データの決まり（置き場・並び順キー・締切で今日へ移すなど）は、画面と同じデータ層を通る。

```sh
nagi add "PR #128 のレビュー"                    # 受信箱へ
nagi add "見積もりの返信" --memo "Slack のスレッド https://…" --deadline 金曜
nagi add "歯医者に電話" --to 明日                 # 予定へ（今日以前の日付なら今日へ）
nagi add "請求書の確認" --to today --project AIPR --priority high --points 3 --json
nagi list                                        # 未完了のすべて（受信箱・今日・予定・あとで）
nagi list inbox --json                           # 受信箱だけを JSON で
nagi list completed --days 7 --json              # 直近 7 日（今日を含む）に完了したもの
nagi list all --json                             # 未完了のすべてと、直近に完了したもの
nagi show <ID> --json                            # 1件を詳しく（メモ・チェックリスト・updatedAt）
nagi update <ID> --append-memo "10/6 再依頼あり" --add-check "請求書を送る" --check "金額を確認"
nagi update <ID> --points 3 --deadline 金曜 --keep-existing --if-unchanged-since <updatedAt>
nagi done <ID>                                   # 完了にする
nagi projects --json                             # プロジェクトの一覧
nagi login                                       # 画面なしでログイン（URL とコードを出して、承認を待つ）
nagi logout
nagi --help
```

- `add` の行き先（`--to`）は `inbox`（既定）・`today`・`later` か日付。`--add-check` で、チェックリストの項目を一緒に作れる（何度でも書ける）。日付と締切は、画面の日付の入力と同じ書き方（`2026-10-09`・`明日`・`金曜`・`来週月曜`・`3日後`・`10/3`）で渡せる。`--project` は名前で指す（なければ追加せずに失敗する。プロジェクトは作らない）
- `--json`：`add`・`show`・`update`・`done` はそのタスクを、`list` はタスクの配列を出す。1件の形は `id`・`title`・`memo`・`list`（`inbox`・`today`・`upcoming`・`later`・`completed`）・`scheduledOn`・`deadlineOn`・`project`（名前）・`priority`・`points`・`inProgress`・`checklist`（`id`・`title`・`done`）・`createdAt`・`updatedAt`・`completedAt`
- `update` でできるのは、足すこと（メモの追記・チェックリストの項目）と、チェックを付けること、属性（行き先・プロジェクト・締切・優先度・工数）を付けることだけ。タイトルの書き換え・メモの置き換え・チェックを外す・削除・完了を外すことは、CLI からはできない（自動の実行が、人の書いたものを壊さないように）。同じ追記・同じ項目は重ねないので、やり直しても増えない
- 外から拾った文章（Slack の本文など）をメモに入れるときは、引数ではなくファイルで渡す：`add --memo-file <ファイル>`・`update --append-memo-file <ファイル>`。引数に入れると、文章の中の `$(…)` などをシェルが実行してしまうことがある
- 人の変更を上書きしないための指定：`--keep-existing` は、すでに値がある締切・優先度・工数・プロジェクトを変えない。`--if-unchanged-since <updatedAt>` は、読んだあとにほかで変更されていたら、何も変えずに失敗する（読み直して、もう一度判断する）
- 毎朝の巡回のように同じものを見つけ直す使い方では、先に `nagi list --json`（必要なら `nagi list completed --json` も）で今あるタスクを読み、同じものは足さないようにする（`add` は重複を確かめない）
- 終了コード：成功は 0、失敗（ログインが切れた・つながらない・保存できなかった・プロジェクトがない・日付が読めない）は 1、引数の誤りは 2。失敗の理由は標準エラーに出る。指定に誤りがあるときは、何も追加しない
- ログインは、画面（`nagi`）か `nagi login` で済ませておく（トークンは同じ場所に置かれる）。手元にログインを置けない実行では、環境変数 `NAGI_TOKEN` にトークンを渡す
- 画面を開いたまま実行してよい（手元の控えは共有する。画面には、次の同期か Ctrl+R で出る）

### Web 版との違い

- ドラッグの代わりにキーを使う：並べ替えは Alt+↑↓、日付の移動は d・⇧D・< >、ボードの列の移動は s（進行中にする／未着手に戻す。完了のカードは進行中で戻る）と x（完了／完了を外す）
- 元に戻すは u（Ctrl+Z でもよい）、削除は Del、検索とコマンドは Ctrl+K、コピー（⇧⌘C）は y、サイドバーを畳む（⌘\\）は `\`
- 追加欄の下書きと、保存できなかったタイトル・メモは、起動しているあいだだけ覚えている（終了すると消える）
- API の版（`X-Api-Version`）が Worker と合わなくなったら、「新しいバージョンがあります。nagi を更新してください」と出て、操作を止める。Releases の新しい版に入れ替える

### `tui/` の中

```text
tui/src/
├── main.rs      # 起動（引数を読んで、画面か CLI へ）
├── cli.rs       # 画面なしのコマンド（add・list・show・update・done・projects・login・logout）と、引数の読み方
├── config.rs    # 接続先・トークン・控え・覚え書きの置き場
├── auth.rs      # ログイン（Worker の /auth/device/* を呼ぶ）
├── model.rs     # タスク・プロジェクト・操作の形（src/shared の model.ts・mutations.ts・api.ts と同じ約束）
├── rank.rs      # 並び順キー（fractional index。Worker と同じキーを作る）
├── dates.rs     # 論理日付（午前4時に切り替わる）・日付の入力のパーサー・表示の文言
├── data/        # データ層。画面は Store だけを読み書きする
│   ├── store.rs     # まとめ役：操作の受け付け・送信の列・差分の取得・知らせ
│   ├── actions.rs   # 操作（追加・完了・移動・並べ替え・締切・元に戻す）。業務の決まりはここ
│   ├── replica.rs   # 手元の写し（確定データ＋送信中の操作を重ねた行）
│   ├── undo.rs      # 元に戻す（逆向きの操作を作って積む）
│   ├── lists.rs     # 各リストの中身と並び
│   ├── sort.rs      # 並び方（表示だけ。rank は変えない）
│   ├── local_db.rs  # 手元の控え（SQLite）
│   └── net.rs       # Worker との通信（専用のスレッド。再送とページの続きもここ）
└── ui/          # 画面
    ├── mod.rs       # イベントの列（端末・通信・ログイン）と描き直し
    ├── app.rs       # 画面の状態と、画面ごとの一覧の中身（view）
    ├── keys.rs      # キーの割り当ての一覧と実行
    ├── input.rs     # 入力欄・候補・開いたタスクのキー、検索とコマンドの候補
    ├── commands.rs  # タスクへの操作（選択の移動と「元に戻す」のトースト）
    ├── clipboard.rs # タスクをコピーする形と、端末のクリップボード（OSC 52）
    ├── list.rs      # 一覧の選択（カーソル・範囲選択・列・開閉）と並べ替えの計算
    ├── views.rs     # カレンダーとタイムラインの中身の計算
    ├── login.rs     # ログインの画面
    └── render/      # 描画（サイドバー・一覧・開いたタスク・ボード・カレンダー・タイムライン・候補）
```

決まり：

- データの決まり（どの置き場に入れるか、並び順キーの付け方、進行中なら今日、予定なら日付あり）は `data/actions.rs` に置く。Worker の検証（`src/worker/sync/mutate.ts`）と同じ決まりなので、片方を変えたらもう片方も直す。API の形を変えたら、`src/shared/api.ts` の `API_VERSION` と `tui/src/model.rs` の `API_VERSION` をそろえて上げる
- 1回のユーザー操作は1つのまとまり（1リクエスト）で、Worker は全部成功か全部失敗にする。送信は積んだ順に1つずつ。失敗したら、そのまとまりと後ろに並ぶまとまりをすべて捨てて、表示を戻す
- キーは `ui/keys.rs` の `bindings()` に足す。上から順に、今使える（`can_run`）最初の割り当てが動く。ここに足した割り当ては、そのまま Ctrl+K とショートカットのページに並ぶ。入力欄や候補の中のキーは `ui/input.rs` が直接扱い、説明だけを `field_keys()` に足す
- タスクへの操作は `ui/commands.rs` の `run_op` を通す（選択の移動と「元に戻す」のトーストが、同じ決まりで動く）。一度に扱えるのは 500 件まで
- 並び順キーは、JS の実装（fractional-indexing）と同じキーを作ることを、`tui/src/testdata/rank_golden.json`（JS の実装で作った正解）で確かめている。`rank.rs` を変えたらこのテストが守る
- 色は `ui/theme.rs` から取る。色は意味のあるところにだけ使う（選択は紫、今日来たタスクと優先度「高」と◆は琥珀、赤は締切を過ぎたときだけ）

テストと確かめ：

```sh
cd tui
cargo test                                   # データ層・日付・並び順キー・一覧の選択など
cargo clippy --all-targets -- -D warnings    # CI と同じ
cargo fmt --check
```

画面は、手元の Worker につないで実際に動かして確かめる（`pnpm dev` を動かし、別の端末で `cargo run -- --server http://localhost:5317`）。

## 事前準備（本番に出すまでに1回だけ）

1. GitHub に `myksyut/nagi` を作る（済み。公開のリポジトリ）
2. Cloudflare の workers.dev のサブドメインを確かめる（済み）。サブドメインは `wizard1026miya` で、Worker の URL は `https://nagi.wizard1026miya.workers.dev` になる。プランは、まず無料のまま出す。1回の処理の CPU 時間（10ms）などの制限に当たったら（ダッシュボードやログに「exceeded CPU」のエラーが出る、同期が失敗するなど）、Workers Paid（月 $5）に切り替える
3. M7 の wrangler を Cloudflare に接続する（済み）。M7 には画面がないので、デバイスコードでログインする。権限は nagi のデプロイに要るものだけに絞る

   ```sh
   pnpm exec wrangler login --device --scopes account:read user:read workers:write workers_scripts:write workers_tail:read d1:write
   ```

   表示された URL とコードを Mac のブラウザで入力して承認する。予備の方法として、SSH のポート転送で 8976 番をつないで（`ssh -L 8976:localhost:8976 <M7>`）`pnpm exec wrangler login --browser=false` を実行し、表示された URL を Mac のブラウザで開いてもよい

4. D1 を作り、`wrangler.jsonc` の `database_id` を、出力された ID に差し替える（済み）

   ```sh
   pnpm exec wrangler d1 create nagi --location apac
   ```

   差し替えたあとは、手元の D1 も別のものになるので、`pnpm db:migrate:local` をもう一度実行する

5. GitHub の OAuth App を登録する（GitHub の Settings → Developer settings → OAuth Apps の「nagi」。登録は済み）
   - Homepage URL：`https://nagi.wizard1026miya.workers.dev`
   - Authorization callback URL：`https://nagi.wizard1026miya.workers.dev/auth/callback`（デバイスフローでは使わないが、必須の欄なのでそのまま残す）
   - **「Enable Device Flow」にチェックを入れて「Update application」を押す**。TUI のログインに要る。入れていないと、`/auth/device/start` が 502 `{"error":"github"}` を返し、Worker のログに `device_flow_disabled` が残る
   - Client secret は不要になった（デバイスフローでは使わない。Worker にも渡さない）
6. Worker の設定値を入れる（どれも `wrangler.jsonc` の `vars` に書いてある。シークレットはない）
   - `GITHUB_CLIENT_ID`：OAuth App の Client ID。秘密ではないので Git に入れてよい。ダッシュボードで入れた普通の変数は `wrangler deploy` のたびに上書きされるので、ここに書く
   - `OWNER_GITHUB_USER_ID`・`SIGNUP`・`ALLOWED_GITHUB_USER_IDS`：だれがログインできるか（下の「利用者」）。持ち主に `51072711`（myksyut）を書いてある
   - 以前の Web 版で Cloudflare のダッシュボード（Worker `nagi` の Settings → Variables and Secrets）に入れた Secret `GITHUB_CLIENT_SECRET` は、もう使わないので消してよい

## 手元での動かし方

M7 で Worker を動かす。開発用の OAuth App やシークレットは M7 に置かず、ログインは `AUTH_DISABLED` で外す。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # AUTH_DISABLED=true（シークレットは要らない）
pnpm db:migrate:local            # 手元の D1（.wrangler/state）にマイグレーションを当てる
pnpm dev                         # Worker を http://localhost:5317 で起動する（ポートは 5317 に固定）
```

- `AUTH_DISABLED=true` は、`localhost`・`127.0.0.1`・`[::1]` へのリクエストのときだけ効く（`Authorization` なしで `/api/*` が通る）。本番の URL には効かない
- 新しいマイグレーションを取り込んだら、`pnpm db:migrate:local` をもう一度実行する
- Worker は M7 の `localhost` だけで待ち受ける。Mac から使うときは、SSH のポート転送でつなぐ（`ssh -L 5317:localhost:5317 <M7 のホスト>`）
- curl で書き込みの API（POST）を試すときは、`Content-Type: application/json` を付ける（付けないと 415）。`Origin` は付けなくてよい

  ```sh
  curl http://localhost:5317/api/session
  curl -X POST http://localhost:5317/auth/logout -H 'Content-Type: application/json' -d '{}'
  ```

- `/api/sync` と `/api/mutate` には、さらに `X-Api-Version` を付ける。タスクを作って、差分の取得で取り出す例：

  ```sh
  api() {
    curl -X POST "http://localhost:5317$1" \
      -H 'Content-Type: application/json' -H 'X-Api-Version: 3' -d "$2"
  }
  api /api/mutate '{"id":"0199a000-0000-7000-8000-000000000001","mutations":[{"type":"task.create","task":{"id":"0199a000-0000-7000-8000-000000000002","title":"見積もりの確認","bucket":"inbox","rank":"a0"}}]}'
  api /api/sync '{"cursor":0,"baseCursor":0}'
  ```

- `/auth/device/start` と、正しい形の `/auth/device/token` は、手元の Worker からも本物の GitHub に問い合わせる（`wrangler.jsonc` の Client ID を使う）
- 試すためのデータは、`pnpm dev` を動かしたまま `scripts/seed-local.mjs` で入れる（送り先は localhost の `/api/mutate` だけで、本番の D1 には触らない）

  ```sh
  node scripts/seed-local.mjs today100     # 今日に 100 件、受信箱とあとでに 10 件ずつ、プロジェクト 2 つ
  node scripts/seed-local.mjs fill 20000   # 完了ログを足して、タスクを合計 2 万件に
  ```

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | Worker を手元で起動する（`wrangler dev`。ローカルの D1 を使う。ポート 5317） |
| `pnpm check` | 型チェック（`tsc -b`）と Biome |
| `pnpm format` | Biome で整形と自動修正 |
| `pnpm test` | Vitest。worker と shared の2つの project を回す |
| `pnpm db:generate` | `src/worker/db/schema.ts` から、`migrations/` にマイグレーションを生成する |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | D1 のマイグレーションを、手元 / 本番に適用する |
| `pnpm release` | 本番の D1 にマイグレーション → `wrangler deploy`（ふだんは main へのマージで CD が動かす） |

## テスト

`pnpm test` は、Vitest の projects で2つに分けて回す（設定は `vitest.config.ts`）。

| project | 対象 | 環境 |
| --- | --- | --- |
| worker | `src/worker/**/*.test.ts` | Workers 用テストプール（workerd の中）。D1 込みで、各テストファイルの前に `migrations/` を当てる。GitHub とのやり取りは `fetch` を差し替えて確かめる |
| shared | `src/shared/**/*.test.ts` | Node |

Vitest は Workers 用テストプール（`@cloudflare/vitest-pool-workers` 0.22）に合わせて 4 系に固定している。

GitHub Actions（`.github/workflows/ci.yml`）では、`pnpm check` と `pnpm test` に加えて、`tui/` で `cargo fmt --check`・`cargo clippy --all-targets -- -D warnings`・`cargo test` を回す。

## デプロイ

**Worker**：main にマージすると、GitHub Actions が本番に出す（`.github/workflows/deploy.yml`）。main の CI（Worker と TUI の両方の job）が通ったあとに動き、マイグレーションの前に D1 の Time Travel のブックマークをログに残し、`pnpm release` を実行して、本番の応答（`/api/session` が 401、形の違う本文の `POST /auth/device/token` が 400）を確かめる。Actions の「deploy」を手で動かしても、main をそのまま出し直せる。

使うもの：secret の `CLOUDFLARE_API_TOKEN` と、変数の `CLOUDFLARE_ACCOUNT_ID`。トークンの権限は、このアカウントの Workers のスクリプトと D1 の編集（ほかにアカウントの設定とユーザーの情報の読み取り）で、nagi だけに絞ったものではない。トークンは環境 `production` の secret で、環境は main ブランチからしか使えない（トークンの権限とは別の守り）。出すのは main の最新のコミットだけ（古い CI をやり直しても、古い版で上書きしない）。

手で出すときは、M7 から次の1つで出せる（CD と同時には動かさない）。

```sh
pnpm release
```

中身は `pnpm db:migrate:remote`（本番の D1 にマイグレーション）→ `wrangler deploy`。`pnpm deploy` は pnpm の組み込みコマンドとぶつかるので使わない。

出す前に中身だけ確かめたいときは、`pnpm exec wrangler deploy --dry-run` を実行する（Cloudflare には何も送らない）。

**前の版に戻すとき**：`migrations/0004`（利用者）より前の版の Worker は、いまの D1 では動かない。セッションの表の名前を `user_sessions` に変えてあり、古い版はセッションを読めずに、どの口も 500 になる（古い版は利用者を区別しないので、動いてしまうと全員の行が全員に見える。それを防ぐため）。0004 より前の版へ戻すなら、D1 も Time Travel で 0004 を当てる前へ戻す（そのあとに書いたデータは消える）。0004 を当ててから新しい Worker が出るまでの数秒も、同じ理由で 500 になる。

**TUI**：`tui/` を変えて main にマージすると、GitHub Actions が Mac（Apple シリコン）と Linux（x86_64）でビルドして、GitHub の Releases に出す（`.github/workflows/tui.yml`）。タグは `tui-v0.1.<実行の番号>` で、ファイルは `nagi-aarch64-apple-darwin.tar.gz` と `nagi-x86_64-unknown-linux-gnu.tar.gz`（中身はバイナリ `nagi`）。PR では、`tui/` を変えたときにビルドできるかだけを確かめる。
