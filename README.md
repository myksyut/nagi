# nagi

自分専用の TODO Web アプリ。速さを土台に、「Linear のキビキビ感 × Things 3 の上品さ」を目指す。

名前は凪（なぎ）から。慌ただしい仕事のタスクを、静かに片付けていく道具。

## 構成

画面（React 19 + Vite 8 の SPA）と Worker（Hono）を1つのパッケージにまとめ、Cloudflare の Vite プラグインで一緒にビルドする。データは Cloudflare D1。

```text
src/
├── client/      # React の画面（coss ui の部品は components/ui）
├── worker/      # Hono の API（/api/*）とログイン（/auth/*）
└── shared/      # 画面と Worker で共有する型や関数
migrations/      # D1 のマイグレーション（Drizzle で生成し、wrangler で適用）
public/          # そのまま配信するファイル
index.html       # アプリの外枠（最初の表示用の最小限の CSS を直接書く）
wrangler.jsonc   # Worker・D1・静的配信の設定
components.json  # shadcn / coss ui の設定
```

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
| client | `src/client/**/*.test.{ts,tsx}`、`src/shared/**/*.test.ts` | happy-dom と fake-indexeddb。偽のタイマーは各テストで `vi.useFakeTimers()` |

Vitest は Workers 用テストプール（`@cloudflare/vitest-pool-workers` 0.22）に合わせて 4 系に固定している。GitHub Actions でも `pnpm check` と `pnpm test` を回す。

## デプロイ

事前準備が済んでいれば、M7 から次の1つで出せる。

```sh
pnpm release
```

中身は `pnpm build` → `pnpm db:migrate:remote`（本番の D1 にマイグレーション）→ `wrangler deploy`。`pnpm deploy` は pnpm の組み込みコマンドとぶつかるので使わない。

出す前に中身だけ確かめたいときは、`pnpm build` のあと `pnpm exec wrangler deploy --dry-run` を実行する（Cloudflare には何も送らない）。

初回のデプロイのあとは、事前準備の 6 で `GITHUB_CLIENT_SECRET` を入れ、Worker の URL を開いて GitHub でログインできることを確かめる。ログインできていれば、`/api/session` が `{"authenticated":true}` を返す。
