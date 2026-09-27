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
public/          # そのまま配信するファイル
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

- Worker が受けるのは `/api/*` と `/auth/*` だけ。それ以外の URL は静的配信が画面を返す（知らない URL も `index.html`）
- `/api/*` はログインが必要（セッションがなければ 401）。画面ファイル自体はログインなしで配信する

## 事前準備（本番に出すまでに1回だけ）

1. GitHub に `myksyut/nagi`（private）を作る（済み）
2. Cloudflare のアカウントを Workers Paid（月 $5）に切り替え、workers.dev のサブドメインを確かめる。Worker の URL は `https://nagi.<サブドメイン>.workers.dev` になる
3. M7 の wrangler を Cloudflare に接続する。M7 には画面がないので、デバイスコードでログインする

   ```sh
   pnpm exec wrangler login --device
   ```

   表示された URL とコードを Mac のブラウザで入力して承認する。予備の方法として、SSH のポート転送で 8976 番をつないで（`ssh -L 8976:localhost:8976 <M7>`）`pnpm exec wrangler login --browser=false` を実行し、表示された URL を Mac のブラウザで開いてもよい

4. D1 を作り、`wrangler.jsonc` の `database_id`（今は仮の `00000000-...`）を、出力された ID に差し替える

   ```sh
   pnpm exec wrangler d1 create nagi --location apac
   ```

   差し替えたあとは、手元の D1 も別のものになるので、`pnpm db:migrate:local` をもう一度実行する

5. GitHub の OAuth App を登録する（GitHub の Settings → Developer settings → OAuth Apps）
   - Homepage URL：`https://nagi.<サブドメイン>.workers.dev`
   - Authorization callback URL：`https://nagi.<サブドメイン>.workers.dev/auth/callback`
6. Worker の設定値を入れる
   - `GITHUB_CLIENT_ID`：OAuth App の Client ID を、`wrangler.jsonc` の `vars` に書く（今は空）。秘密ではないので Git に入れてよい。ダッシュボードで入れた普通の変数は `wrangler deploy` のたびに上書きされるので、ここに書く
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
      -H 'Content-Type: application/json' -H 'X-Api-Version: 1' -d "$2"
  }
  api /api/mutate '{"id":"0199a000-0000-7000-8000-000000000001","mutations":[{"type":"task.create","task":{"id":"0199a000-0000-7000-8000-000000000002","title":"見積もりの確認","bucket":"inbox","rank":"a0"}}]}'
  api /api/sync '{"cursor":0,"baseCursor":0}'
  ```

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
