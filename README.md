# nagi

自分専用の TODO Web アプリ。速さを土台に、「Linear のキビキビ感 × Things 3 の上品さ」を目指す。

名前は凪（なぎ）から。慌ただしい仕事のタスクを、静かに片付けていく道具。

## 構成

画面（React 19 + Vite 8 の SPA）と Worker（Hono）を1つのパッケージにまとめ、Cloudflare の Vite プラグインで一緒にビルドする。データは Cloudflare D1。

```text
src/
├── client/      # React の画面（coss ui の部品は components/ui）。データ層（ストア・IndexedDB・同期）は client/data
├── worker/      # Hono の API（/api/*）とログイン（/auth/*）。同期の API は worker/sync
└── shared/      # 画面と Worker で共有する型・検証スキーマ・論理日付・並び順キー・API の版
migrations/      # D1 のマイグレーション（Drizzle で生成し、wrangler で適用）
public/          # そのまま配信するファイル（Service Worker・オフライン画面・_headers）
index.html       # アプリの外枠（最初の表示用の最小限の CSS を直接書く）
wrangler.jsonc   # Worker・D1・静的配信の設定
components.json  # shadcn / coss ui の設定
```

画面側（`src/client`）の中の分け方：

| 場所 | 中身 |
| --- | --- |
| `screens/` | リストごとの画面（今日・受信箱・予定・あとで・完了ログ）。一覧の中身（まとまりと追加の行き先）を `useListView` で渡す |
| `tasks/` | 一覧の部品と状態。選択（複数選択を含む）・開いているタスク・追加欄（`list-ui.ts`）、完了や振り分け・並べ替えの操作と「元に戻す」のトースト（`commands.ts`・`reorder.ts`）、ドラッグ（`drag.ts`）、行と開いたタスクの拡張点（`extensions.ts`） |
| `keyboard/` | キーマップ（`keymap.ts`）。キーの割り当ては登録式で、⌘K や `?` の一覧もここから作る。キー操作の状況（`{ store, ui, navigate }`）は `useKeyContext()`（`key-context.tsx`）で受け取れる |
| `features/` | 各機能の登録（キーの割り当て・行の右側の情報・開いたタスクの欄）。`features/<名前>/register.ts(x)` を自動で読み込むので、機能を足すときはフォルダを作るだけでよい |

キーの割り当ての決まり（`registerKeyBindings`）：

- 1つのキーは、1つの場面（`scope`、省略すると既定の場面）に1つの割り当てだけ。同じ場面で同じキーを別の id に割り当てると、開発とテストでは登録のときに例外になる（本番はコンソールに出し、先に登録したほうが動く）。5 と 6 が並行してキーを足すときは、`pnpm test` で重なりに気づける
- 同じキーを場面ごとに使い分けるときだけ、別の `scope` を付け、`when` で同時に効かないようにする
- 入力欄では1文字のキーは効かない（1文字のキーに `allowInInput` を付けると登録で例外）。ポップオーバーなど、アプリのキーを止めたい要素には `data-keymap="off"` を付ける
- 登録した割り当ては、そのまま ⌘K（`features/command-palette`）に名前と先頭のキーで並ぶ（今使えるもの＝`when` が true のものだけ）。⌘K からは `keymap.run(id, context)` で、キーを押したときと同じ `run` を呼ぶ。`?` の一覧は `group` ごとに全部のキーを並べる

タスクへの操作の決まり（7 の複数選択）：

- キーの操作は、選んでいるすべての行（`ui.selectedRows`。上から見えている順）に1つの操作としてかける。`ui.selected` は選択の中のカーソル（↑↓ の起点で、ポップオーバーはこの行から広がる）
- 選択を操作に使うときは `selectionForOperation(ui)`（`tasks/commands.ts`）を通す。500 件（1回の操作の上限）を超えていたら、実行せずに「一度に扱えるのは 500 件まで」と出す。`runTaskOperation` も同じ上限で止める
- ⌥↑↓ とドラッグで並べ替えられるのは、画面が `TaskSection` に `reorderable: true` を付けたまとまりの中だけ（今日、あとでのプロジェクトごと、プロジェクトの画面の「今日」と「あとで」）。書き換えるのは動かした行の rank だけ（`store.actions.reorderTasks`）

最初の表示と、後から読み込む部品（8）：

- 起動に要らない部品は `defer(() => import("…"))`（`lib/deferred.ts`）で最初の JS から外し、部品の中では `useDeferred` で受け取る。今は ⌘K、`?` の一覧、完了ログの一覧、日付の入力（カレンダー）、p の候補、チェックリストの編集、border-beam、Motion の機能一式（`LazyMotion` に渡す。行などは `motion.*` ではなく `m.*` で書く）、カレンダーの画面（小さな追加欄を含む）
- 登録したものは、アプリの外枠が起動のあとの空いた時間にまとめて先読みする（最初のキー操作で読み込みを待たせない）。テストでは各ファイルの最初に読み込んでおく（`test/setup.ts`）
- 後から読み込むモジュールを、起動の道筋（`main.tsx` から静的に import される側）から import しない。import すると最初の JS に戻ってしまう。`pnpm build` の出力で `index-*.js` と一緒に読まれる分を確かめる
- 逆向きにも気を付ける：後から読み込む画面から、それを `defer` している起動側のモジュール（`lazy.tsx` など）を import しない。循環すると、起動側のモジュールが細かいチャンクに分かれて、起動に要る JS が数 KB 増える（13 で見つけた）。起動側の部品を使いたいときは props で渡す（カレンダーの見出しは `LazyCalendarScreen` が `Heading` として渡している）
- 画面の中だけで効くキー（カレンダーの [ ] など）は、画面と一緒に後から読み込むモジュールで登録してよい（先読みのときに登録される）。起動に要る JS を増やさないため

動きの決まり（8）：

- 動かしてよいのは transform と opacity だけ。速さは `lib/motion.ts` の `DURATION`（CSS では `--duration-*`）。ポップオーバーは、出るときは 100ms、消えるときだけ 150ms でフェードする
- `prefers-reduced-motion` のときは、Motion の動き（`lib/reduced-motion.ts`）と CSS の動き（`styles.css` の最後）をすべて止め、色の変化だけを残す。動く飾りを足すときも、この2つで止まることを確かめる

見た目の決まり（9。デザインの方向 A「夜の深み」）：

- 色は `styles.css` の `.dark` のトークンから取り、部品に色の値を直接書かない。リストの色は `--list-*`（アイコンは `shell/list-icons.ts`）、プロジェクトの 8 色は `--project-*`
- すりガラス（`glass`。`backdrop-filter`）は、サイドバーとポップオーバー・ダイアログだけに使う。スクロールする一覧・カード・トーストには使わない（トーストは不透明の `bg-surface`）
- 選んだ行は `row-selected`（紫の淡い背景と輪郭の光）、フォーカスの輪郭は `outline` で別に出す。上からの光は `body::before` に固定して置くだけで動かさない
- プロジェクトの色は `lib/project-color.ts` の `projectColorOf` から取る（中身はデータ層の `store.lists.projectColor(id)`。選んだ色 `color` があればその色、空なら作成順の色）。色の値は `projectColorVar(color)`（`var(--project-<名前>)`）、点は `features/projects/project-dot.tsx` の `ProjectDot`
- 右下の「＋」（`shell/add-button.tsx`）は、キーマップの `task.add`（n）をそのまま呼ぶ（使えない画面では、小さな追加欄の `quickAdd.open`。下の「小さな追加欄」）。完了の光の輪（`tasks/completion-ring.ts`）は、完了にする操作（`completeTasks`）が受け付けられた直後に、丸をタスクの id から引いて（見えている丸を最大 20 個）、その位置へ画面に固定した要素を置いて 300ms で外す。途中で reduced motion に変わったらすぐ外す
- 画面の部品で件数などの変わりやすい値を読まない（完了のたびに画面ごと描き直し、一覧の全行を描き直してしまう）。見出しの件数は `ListScreen` に関数で渡し、見出しの一行の中だけで読む。サイドバーの件数も `NavCountOf` の中だけで読む
- 小さい補助の文字（`--muted-foreground`・`--faint-foreground`）は、地・面・サイドバーの上で 4.5:1 以上を保つ

進行中とプロジェクトの色・小さな詳細（11）：

- s（`features/status`）で、選んでいる未完了の行を進行中にする／やめる。選んだ中に未着手が1つでもあれば未着手のものを進行中にし（`store.actions.startTasks`）、全部が進行中のときだけ未着手に戻す（`stopTasks`）。今日以外の行は今日の一番上へ移り、一覧から抜けたら「「A」を今日へ」、2件以上なら「3件を進行中にしました」「3件を未着手に戻しました」を出す。画面から呼ぶときは `features/status/commands.ts` の `toggleStarted(ui, ids)`・`startTasks`・`stopTasks`（どれも `runTaskOperation` を通す）
- 進行中の印は、完了の丸（`tasks/complete-button.tsx` の `CompleteButton` に `inProgress`）の半分を紫で塗る（`styles.css` の `status-in-progress` と `--in-progress`）。状態は `TaskRow.status`・`isInProgress` で読む（項目ごとの観測）。開いたタスクの一番下の列の先頭に、状態のボタン（未着手・進行中。押すと切り替わる）
- プロジェクトの画面の見出しの色の点（`features/projects/color-palette.tsx`）を押すと、パレットの 8 色が開き、選ぶと `store.actions.updateProject(id, { color })`（⌘Z で戻る）。パレットの中身は後から読み込む
- ⌘Z がほかの画面の変更とぶつかって戻せなかったときは「ほかの画面で先に変更されていたため、元に戻せませんでした」（`tasks/list-ui.ts`。知らせの `discarded` が「元に戻す」の操作だけのとき）
- 開いたタスクの欄の部品（`registerDetailField`）は `DetailFieldProps` を受ける（`view` は小さな詳細では null のことがある）。行の右側（`registerRowMeta`）はこれまでどおり `TaskSlotProps`
- 欄の中の入力欄で Esc（タイトルは Enter も）を押したときは `useDetailSurface().close()`（`tasks/detail-surface.tsx`）で閉じる。一覧の中では開いたタスクを閉じて一覧へ、小さな詳細ではポップオーバーを閉じて押した場所へフォーカスを戻す
- `runTaskOperation` のトーストの `left`（一覧から抜けた行）は、操作の前に一覧にあって、あとにはない行だけ（小さな詳細など、一覧の外のタスクへの操作では入らない）

小さな詳細（`tasks/task-detail-popover.tsx`。カレンダーとタイムラインでタスクを押したときに開く。13・14 がつなぐ）：

```tsx
import { TaskDetailPopoverHost, taskDetailPopoverOf } from "@/tasks/task-detail-popover";

// 画面に1つ置く（画面が消えると、開いていた小さな詳細も閉じる）。view は省略してよい
<TaskDetailPopoverHost />

// タスクを押したとき（ui は useUi()）。押した要素から広がる
<button onClick={(event) => taskDetailPopoverOf(ui).open(task.id, event.currentTarget)}>…</button>
```

- 中身はリストで開く詳細と同じ（完了の丸・タイトル・メモ・チェックリスト・状態・いつやる・締切・プロジェクト）。保存と ⌘Z の決まりもリストと同じ
- Esc で閉じて、押した要素へフォーカスを戻す。外を押すと閉じる（フォーカスは押した先に任せる）。`taskDetailPopoverOf(ui).close()` で閉じる。開いているのは一度に1つで、別のタスクを `open` すると入れ替わる。タスクが削除されたとき・新しいバージョンへ読み込み直すときは閉じる
- 押した要素が画面から消えるとき（日付を変えて別のマスへ移るなど）は、画面の側で新しい要素から `open` し直すか、閉じる
- 中ではアプリの1文字のキーを止める（`data-keymap="off"`）。そのかわり完了の丸は Tab で止まり、Enter・Space で押せる（一覧の行の丸は止まらない）。欄には、効かないキーの案内（状態のボタンの s、日付の入力の t・l）を出さない
- 欄から開く日付の入力と p の候補は、小さな詳細の中に描く（`registerDetachedHost` で、dates と projects が自分の描き方を登録している）。欄からポップオーバーを開く機能を足すときは、`useDetailSurface().detached` を見て、同じように登録する
- 欄の中の要素の id には `useDetailSurface().idScope`（一覧の中は ""、小さな詳細は詳細ごとの接頭辞）を付ける。同じタスクが一覧と小さな詳細の両方に出ても id が重ならず、id で探すフォーカスの移し先が相手の側へ飛ばないように。欄に id を持つ要素を足すときも同じようにする
- 小さな詳細のモジュールは Base UI の Popover を使う。起動の道筋から import せず、後から読み込む画面（カレンダー・タイムライン）から使う

ビュー（13・14）：

- サイドバーの「ビュー」の見出しの下は `navigation.ts` の `VIEWS` を並べる。ビューを足すときは、`VIEWS` に1行（`{ key, path, label }`。`ViewKey` にも足す）、`shell/list-icons.ts` の `VIEW_ICONS` に1行（アイコンと `--list-*` の色）、`app.tsx` にルートを1行足す
- 右の枠の幅の上限（`max-w-3xl`）は、画面の一番外の要素に `data-wide-view` を付けると外れる（`shell/app-shell.tsx`）
- ビューはリストではないので、一覧の状態（`ui.view`）を持たない（`useListView` を使わない）。そのため一覧のキー（↑↓・x など）は効かない。画面の中だけで効くキーは、自分の場面（`scope`）で登録し、`when` で画面が出ているときだけにする
- 「キーマップのすべての割り当てを ⌘K から実行できる」のテスト（`command-palette.test.tsx`）は、場面を分けていない割り当てだけを見る。場面を分けた割り当ては、その画面が出ているときだけ使えるので、その画面のテストで確かめる

カレンダー（13。`features/calendar`）：

- 6 か、サイドバーの「カレンダー」で開く。画面（`calendar-screen.tsx`）・状態と [ ] のキー（`state.ts`）・中身の計算（`model.ts`）は後から読み込み、起動側には 6 の割り当て（`register.ts`）と、読み込みを待つ枠（`lazy.tsx`）だけを置く
- マスの中身は `model.ts` の `entriesByDate`：締切の◆（受信箱・今日・予定・あとでの未完了のタスクの締切の日）が先、そのあとにタスク（今日のマスに今日のタスク、予定の日付のマスに予定のタスク）。予定の日付・締切・プロジェクトは `row.field(key)` で項目ごとに観測する。日ごとの中身は、その日の中身が変わったときだけ知らせる（`CalendarModel.entriesOn`）
- マスに出すのは 3 行まで（超えたら 2 行と「ほか N 件」。押すとその日の一覧）
- ドラッグは、タスクなら `scheduleTasks`、◆なら `setDeadline`（`features/dates/commands.ts`）を呼ぶだけ。タスクは `taskDragOf(ui)` にも載せるので、サイドバーの今日・あとで・プロジェクトにも落とせる
- 小さな詳細を開いた要素がマスから消えたら（日付を変えて別のマスへ移ったなど）、同じもの（タスクか◆）の新しい要素から開き直す（`useFollowDetailAnchor`。表の中の要素の `data-calendar-entry`・`data-calendar-task` で探す）。どこにもなければ閉じる。月を替えたら閉じる

小さな追加欄（13 が作り、14 もつなぐ。`features/quick-add`）：

```tsx
import { QuickAddHost } from "@/features/quick-add/quick-add";
import { quickAddOf } from "@/features/quick-add/state";

// 画面（後から読み込む画面）に1つ置く。置いているあいだだけ、右下の「＋」と n がこの欄につながる。
// projectId を渡すと、追加したタスクにそのプロジェクトを付ける（絞り込みで選んでいるプロジェクトなど）
<QuickAddHost projectId={null} />

// 右下の「＋」と n：何も書かなくてよい（「＋」の上に開き、行き先は「受信箱｜今日」。開くたびに受信箱から）

// その日の予定として追加する欄を、自分で開くとき（カレンダーの日のマスの「＋」）。
// anchor の下に開き、Esc で閉じたら returnFocus（省くと anchor）へフォーカスを戻す。今日か過去の日なら今日へ入る
quickAddOf(ui).open({ kind: "date", on: "2026-10-05" }, anchor, returnFocus);
```

- 右下の「＋」（`shell/add-button.tsx`）は、一覧の追加欄（`task.add`）が使えないときに、小さな追加欄の割り当て（`quickAdd.open`、同じ n、場面 `quick-add`）を呼ぶ。割り当ては `features/quick-add/state.ts` が読み込まれたときに登録する
- Enter で追加して開いたまま続けられ、Esc で閉じる。打った文字は一覧の追加欄と同じ下書き（`ui.addDraft`）に残る（オフライン・保存できずに戻ってきたときも）。追加しても画面に出ないことがある（受信箱など）ので、追加したら「受信箱に追加しました・元に戻す」を出す
- 予定への追加は `store.actions.addTask({ title, bucket: "scheduled", on })`（1つの操作。今日か過去なら今日の一番下へ。⌘Z 1回で消える）
- 開いたら小さな詳細は閉じる。中ではアプリの1文字のキーを止める（`data-keymap="off"`）

オフラインと失敗のとき（8）：

- オフラインのあいだは上部に細い帯を出し、オフラインで操作を止めたら帯の色を少し強める（`shell/status-bar.tsx`）。画面の版が古い（409）ときも同じ帯で「新しいバージョンがあります」と出して読み込み直す
- 追加欄の下書き、戻ってきた追加、保存できなかったタイトルとメモは、localStorage にも残す（`tasks/draft-storage.ts`）。再読み込みやログインのし直しでも消えない
- 操作の側で「保存できませんでした」の文言を決めたいときは `ui.onSaveFailed(operationId, handler)` を使う（汎用の知らせと重ねずに1つだけ出す）
- Service Worker（`public/sw.js`）は、オフラインで開いたときに `offline.html` を出すためだけに使う。キャッシュに置くのは `offline.html` だけで、画面のファイルは置かない。本番のビルドでだけ登録する
- `public/_headers` で `/assets/*`（名前にハッシュが付いたファイル）に `Cache-Control: public, max-age=31536000, immutable` を付ける。`index.html` などは Workers の既定（`max-age=0`）のまま

- Worker が受けるのは `/api/*` と `/auth/*` だけ。それ以外の URL は静的配信が画面を返す（知らない URL も `index.html`）
- `/api/*` はログインが必要（セッションがなければ 401）。画面ファイル自体はログインなしで配信する

## 事前準備（本番に出すまでに1回だけ）

1. GitHub に `myksyut/nagi`（private）を作る（済み）
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

5. GitHub の OAuth App を登録する（済み。GitHub の Settings → Developer settings → OAuth Apps の「nagi」）
   - Homepage URL：`https://nagi.wizard1026miya.workers.dev`
   - Authorization callback URL：`https://nagi.wizard1026miya.workers.dev/auth/callback`
6. Worker の設定値を入れる
   - `GITHUB_CLIENT_ID`：OAuth App の Client ID を、`wrangler.jsonc` の `vars` に書く（済み）。秘密ではないので Git に入れてよい。ダッシュボードで入れた普通の変数は `wrangler deploy` のたびに上書きされるので、ここに書く
   - `ALLOWED_GITHUB_USER_ID`：ログインを許可する GitHub ユーザー ID。`wrangler.jsonc` に `51072711`（myksyut）を書いてある
   - `GITHUB_CLIENT_SECRET`：OAuth App の Client secret。これだけはシークレットにする。初回のデプロイ（`pnpm release`）で Worker ができたあと、Mac のブラウザで Cloudflare のダッシュボードを開き、Worker `nagi` の Settings → Variables and Secrets に Secret として入れる。M7 には置かない

## 手元での動かし方

M7 で開発サーバーを動かし、Mac のブラウザから SSH のポート転送で `localhost` として開く。開発用の OAuth App やシークレットは M7 に置かず、ログインは `AUTH_DISABLED` で外す。

```sh
pnpm install
cp .dev.vars.example .dev.vars   # AUTH_DISABLED=true（本物のシークレットは入れない）
pnpm db:migrate:local            # 手元の D1（.wrangler/state）にマイグレーションを当てる
pnpm dev                         # http://localhost:5317 で起動する（ポートは 5317 に固定）
```

Mac では、別のターミナルでポート転送をつないでから、ブラウザで <http://localhost:5317> を開く。

```sh
ssh -L 5317:localhost:5317 <M7 のホスト>
```

- `AUTH_DISABLED=true` は、`localhost`・`127.0.0.1`・`[::1]` へのリクエストのときだけ効く。本番の URL には効かない
- 新しいマイグレーションを取り込んだら、`pnpm db:migrate:local` をもう一度実行する
- curl で書き込みの API（POST）を試すときは、`Origin` と `Content-Type: application/json` を付ける（付けないと 403 / 415）

  ```sh
  curl -X POST http://localhost:5317/auth/logout \
    -H 'Origin: http://localhost:5317' -H 'Content-Type: application/json' -d '{}'
  ```

- `/api/sync` と `/api/mutate` には、さらに `X-Api-Version`（`src/shared/api.ts` の `API_VERSION`）を付ける（違えば 409）。タスクを作って、差分の取得で取り出す例：

  ```sh
  api() {
    curl -X POST "http://localhost:5317$1" -H 'Origin: http://localhost:5317' \
      -H 'Content-Type: application/json' -H 'X-Api-Version: 2' -d "$2"
  }
  api /api/mutate '{"id":"0199a000-0000-7000-8000-000000000001","mutations":[{"type":"task.create","task":{"id":"0199a000-0000-7000-8000-000000000002","title":"見積もりの確認","bucket":"inbox","rank":"a0"}}]}'
  api /api/sync '{"cursor":0,"baseCursor":0}'
  ```

### 速さの確認

技術計画の「速さの目安」は、本番に近いビルドを Mac のブラウザで開いて測る（開発サーバーは遅いので使わない）。

```sh
cp .dev.vars.example .dev.vars   # AUTH_DISABLED=true
pnpm db:migrate:local
pnpm build && pnpm preview       # http://localhost:5317（Mac からはポート転送で開く）
node scripts/seed-local.mjs today100     # 今日に 100 件など
node scripts/seed-local.mjs fill 20000   # 完了ログを足して、タスクを合計 2 万件に
```

- データは手元の D1 にだけ入れる（送り先は localhost の `/api/mutate`）
- 起動の時間は、画面が付ける印 `nagi:local-loaded`・`nagi:list-ready`・`nagi:first-sync`（`src/client/startup-marks.ts`）を `performance.getEntriesByType("mark")` で読む。キーを押してから画面が変わるまでは、Event Timing API（`PerformanceObserver` の `event`）か、keydown から次のフレームまでを `requestAnimationFrame` で測る

## コマンド

| コマンド | 内容 |
| --- | --- |
| `pnpm dev` | 画面と Worker を手元で起動する（ローカルの D1 を使う。ポート 5317） |
| `pnpm build` | 画面と Worker をビルドする（`dist/`） |
| `pnpm preview` | ビルドしたものを手元の workerd で動かす（ポート 5317） |
| `pnpm check` | 型チェック（`tsc -b`）と Biome |
| `pnpm format` | Biome で整形と自動修正 |
| `pnpm test` | Vitest。worker と client の2つの project を回す |
| `pnpm db:generate` | `src/worker/db/schema.ts` から、`migrations/` にマイグレーションを生成する |
| `pnpm db:migrate:local` / `pnpm db:migrate:remote` | D1 のマイグレーションを、手元 / 本番に適用する |
| `pnpm release` | ビルド → 本番の D1 にマイグレーション → `wrangler deploy` |

## テスト

`pnpm test` は、Vitest の projects で2つに分けて回す（設定は `vitest.config.ts`）。

| project | 対象 | 環境 |
| --- | --- | --- |
| worker | `src/worker/**/*.test.ts` | Workers 用テストプール（workerd の中）。D1 込みで、各テストファイルの前に `migrations/` を当てる。GitHub とのやり取りは `fetch` を差し替えて確かめる |
| client | `src/client/**/*.test.{ts,tsx}`、`src/shared/**/*.test.ts` | happy-dom と fake-indexeddb。偽のタイマーは各テストで `vi.useFakeTimers()`。同期のテストは `src/client/test/fake-server.ts`（`src/shared` の約束どおりに動く偽のサーバー）を `fetch` に渡す。fake-indexeddb は setImmediate で動くので、IndexedDB と偽のタイマーを一緒に使うときは `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })` にする |

Vitest は Workers 用テストプール（`@cloudflare/vitest-pool-workers` 0.22）に合わせて 4 系に固定している。GitHub Actions でも `pnpm check` と `pnpm test` を回す。

## デプロイ

事前準備が済んでいれば、M7 から次の1つで出せる。

```sh
pnpm release
```

中身は `pnpm build` → `pnpm db:migrate:remote`（本番の D1 にマイグレーション）→ `wrangler deploy`。`pnpm deploy` は pnpm の組み込みコマンドとぶつかるので使わない。

出す前に中身だけ確かめたいときは、`pnpm build` のあと `pnpm exec wrangler deploy --dry-run` を実行する（Cloudflare には何も送らない）。

初回のデプロイのあとは、事前準備の 6 で `GITHUB_CLIENT_SECRET` を入れ、Worker の URL を開いて GitHub でログインできることを確かめる。ログインできていれば、`/api/session` が `{"authenticated":true}` を返す。
