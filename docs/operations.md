# 運用

## 検証用の環境（staging）

本番に出す前に試すための、もう 1 つの Worker。URL は `https://staging.usenagi.dev`（`wrangler.jsonc` の `env.staging`）。

| | 本番 | staging |
| --- | --- | --- |
| Worker | `nagi` | `nagi-staging` |
| D1 | `nagi`（`770a86db-0365-4b58-ab4f-842f1d0684d3`） | `nagi-staging`（`8f5e89a9-19fb-4982-b33a-dc6374731e9e`） |
| URL | `https://api.usenagi.dev`・workers.dev | `https://staging.usenagi.dev`（workers.dev は止めてある） |
| 回数制限の namespace | 1001〜1003 | 2001〜2003 |
| 登録 | `SIGNUP="allowlist"` | `SIGNUP="allowlist"` |

守ること：

- データベース、シークレット、課金のアカウントを、本番と共有しない。Wrangler の環境は bindings・vars を引き継がず、routes・triggers は引き継ぐ（Cloudflare の仕様）。`env.staging` は routes・triggers も含めて全部明示してある。足すときも、本番の値や id をここに写さない
- staging は専用の GitHub OAuth App（デバイスフローを有効にしたもの）を使う。本番と同じ OAuth App だと、staging が出したデバイスコードを本番で引き換えて、本番のセッションを作れてしまう。OAuth App は運用者が作り、その Client ID を `env.staging.vars.GITHUB_CLIENT_ID` に書く
- staging には本番のデータを入れない。入れるのは、下の種（架空の利用者）だけ
- 課金（R19）を入れたあとも、staging の課金の提供元はテストモードのまま。本番の課金のシークレットや変数を、staging の GitHub environment に置かない
- `AUTH_DISABLED` は、staging の `vars` に書かない。`localhost` 以外へのリクエストには、書いてあっても効かない（`src/worker/auth/middleware.ts`）

### 前もって運用者がすること

1. D1 `nagi-staging` を作る（済み）。`wrangler.jsonc` の `env.staging.d1_databases` に id を書いてある
2. GitHub の environment `staging` を作り、secret `CLOUDFLARE_API_TOKEN` を入れる。本番とは別の Cloudflare のトークンにする（権限は Workers Scripts と D1 の Edit、`usenagi.dev` の Workers Routes の Edit）。アカウント ID は、本番のデプロイと同じリポジトリの変数 `CLOUDFLARE_ACCOUNT_ID` を使う
3. `staging.usenagi.dev` を含む `usenagi.dev` の DNS が Cloudflare にあること（Custom Domain は、`wrangler deploy --env staging` が `routes` から作る）

### 配備

`.github/workflows/staging.yml` が、`staging` ブランチへの push と、Actions の「staging」の手での実行で動く。どのブランチからでも手で動かせる（試したい版をそのまま出せる）。

1. staging の D1 にマイグレーションを当てる（`wrangler d1 migrations apply nagi-staging --env staging --remote`）
2. Worker を出す（`wrangler deploy --env staging`）
3. `https://staging.usenagi.dev/api/session` が 401 を返すことを確かめる

動くのは staging の Worker と D1 だけで、本番には触らない。

手元から出すときは、staging 用のトークンを `CLOUDFLARE_API_TOKEN` に入れ、必ず `--env staging` を付ける（付けないと本番の設定になる）。

### 初期化（種を入れる）

`scripts/seed-staging.mjs` が、staging の D1 の行をすべて消して、テスト利用者 3 人とそのタスクを入れる。何度回しても同じ状態に戻る。

```sh
CLOUDFLARE_API_TOKEN=<staging 用のトークン> CLOUDFLARE_ACCOUNT_ID=<アカウント ID> \
  node scripts/seed-staging.mjs
node scripts/seed-staging.mjs --print   # 流す SQL を出すだけ（D1 には触らない）
```

- 流す先は `wrangler d1 execute nagi-staging --env staging --remote`。毎回、検証した `wrangler.jsonc` の絶対パスを `--config` で渡し、その置き場（リポジトリのルート）を cwd にして動かす（呼び出し元の cwd の設定は拾わない）。実行の前に、`env.staging` の D1 が `nagi-staging` と `8f5e89a9-19fb-4982-b33a-dc6374731e9e` の両方に合うことを確かめ、合わなければ何も書かずに止まる。本番の id は名指しで断る
- 消すのは、タスク、プロジェクト、セッション、meta、利用者（持ち主を含む）。持ち主（`owner`）の行は、マイグレーション直後の形（`github_user_id` は NULL）と meta で作り直す。アカウント削除で無くなっていても、ログインで ID が入っていても、同じ状態に戻る
- 入るのは、利用者 3 人（`staging-user-1`〜`3`。GitHub ユーザー ID は架空の 9000000001〜）。タスクの数は人ごとに変えてある（15・9・4 件。ほかにプロジェクトが 2 つずつ）ので、別の人のタスクが見えていれば件数でわかる
- 最後に、利用者ごとの件数を出す。種の状態に戻ったかは、この件数で見る
- 架空の ID ではログインできない。利用者 1 として GitHub でログインするには、`STAGING_TEST_USER_1_GITHUB_ID=<自分の GitHub ユーザー ID>` を付けて回し、同じ ID を `env.staging.vars.ALLOWED_GITHUB_USER_IDS` に足して配備する

### staging につなぐ

```sh
nagi --server https://staging.usenagi.dev
```

`--server` を付けなければ staging には何も送らない（本番のクラウドか、ローカルのまま）。

### バックアップの復元の練習（R20）との関係

復元の練習に、テストに使っている `nagi-staging` を使わない。バックアップは本番のデータなので、`nagi-staging` に読み込むと、staging に本番のデータが残ってしまう。練習は、名前が `nagi-staging-restore` で始まる、使い捨ての D1 に読み込み、行数を数えたらすぐ消す。
