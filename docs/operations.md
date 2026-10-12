# 運用

本番の D1（`nagi`）のバックアップ、障害の通知、復元の手順。

## バックアップ

- Worker の cron（`wrangler.jsonc` の `triggers.crons` の `37 19 * * *`。毎日 日本時間の 4 時 37 分）が、D1 の全テーブルを SQL にして gzip し、R2 バケット `nagi-backups`（束縛 `BACKUPS`）の `backups/YYYY-MM-DD.sqlgz` に書く。日付は、アプリの時間帯（`APP_TIMEZONE`、日本時間）のもの。同じ日にもう 1 回走ると、同じ名前のファイルが置き換わる。
- 書き込みが成功したあとだけ、日付が 35 日より古い `backups/YYYY-MM-DD.sqlgz` を消す（今日からちょうど 35 日前のものは残す）。名前がこの形でないものは触らない。
- 表の行は、1 クエリ 500 行ずつ、`rowid` の順に読む。R2 へはマルチパートで流すので、全体をメモリに持たない。R2 のオブジェクトは、書き終えてはじめて現れる。途中で失敗しても、書きかけのファイルは残らず、同じ日の前のファイルも、古いファイルも減らない。
- 1 回の実行は、D1 へ 900 クエリまで（D1 の上限は 1000）。超えると失敗する（約 45 万行。そのときは、実行を分ける設計に直す）。
- 読み出しはページごとで、D1 の 1 つの時点を切り取ったものではない。書き込みの少ない時間帯（4 時台）に走らせるのはそのため。
- ファイルの形：先頭に `-- nagi backup <時刻>`、続いて表の定義、行（1 行 1 文の `INSERT`）、索引・トリガー・ビュー、最後に表ごとの行数の控え（`-- rows <表> <行数>`）。文はどれも「;」と改行で終わる。
- 手で 1 回走らせる（手元）：`pnpm exec wrangler dev --test-scheduled` を起動して、`curl http://localhost:8787/cdn-cgi/handler/scheduled`。`cron` を付けない起動は、セッションの掃除とバックアップの両方が走る。
- バケットは、運用者が一度だけ作る：`wrangler r2 bucket create nagi-backups`。

### バックアップが失敗したとき

失敗した実行は、ログに `backup failed` を出し、Worker の実行を失敗として終える。Cloudflare の Worker のエラー率の通知に載る。ログは `wrangler tail`（本番）か、ダッシュボードの Workers Logs で読む。次の日の実行までに、運用者が原因を直す。直ったら、手で再実行する（同じ日の名前に書かれる）。

## 警告の一覧

| 警告 | 見るもの | 起きたら |
| --- | --- | --- |
| Worker のエラー率 | Cloudflare の通知（Workers の「Worker のエラー率」）。バックアップの失敗もここに載る | `wrangler tail` で例外を読む。直近のデプロイが原因なら、前の版へ戻す（`wrangler rollback`） |
| D1 の容量 | Cloudflare の通知（D1 の使用量） | 容量が上限に近い。古い行を消すか、有料の上限を確かめる |
| 外部の死活監視 | `https://api.usenagi.dev/api/session` を 1 分ごとに見る。ログインしていない呼び出しは、401 が正しい答え。401 以外か、答えがなければ停止とみなす | Cloudflare のステータスと Worker のデプロイを確かめる |
| バックアップのファイルがない | `wrangler r2 object get nagi-backups/backups/<今日>.sqlgz --remote --file /tmp/check.sqlgz` が失敗する | 上の「バックアップが失敗したとき」 |

### だれに連絡が行くか

三つとも、運用者（myksyut）に行く。通知先は、運用者が Cloudflare の通知（Notifications）と外部の監視サービスに設定した、運用者のメールアドレス。ほかの人には行かない。通知の設定（Worker のエラー率、D1 の容量、外部の死活監視）は、運用者がダッシュボード側で行う作業で、このリポジトリには入っていない。設定したら、この節に通知先と監視サービスの名前を書き足す。

## 復元の予行（staging だけ）

いちばん新しいバックアップを staging の D1 に読み込み、表ごとの行数を、バックアップに記録された元の行数と突き合わせる。**staging の D1 の中身を、すべて消してから読み込む。** 本番の D1 には何も書かない。

```sh
export STAGING_D1_ID=<staging の D1 の id>
export STAGING_D1_NAME=<staging の D1 の名前>
export BACKUP_BUCKET=<バックアップの R2 バケット>   # 例：nagi-backups
scripts/restore-rehearsal.sh
```

- 本番の id（`770a86db-0365-4b58-ab4f-842f1d0684d3`）か、本番の名前（`nagi`）を渡すと、何も読まずに、何も書かずに、0 以外で終わる。remote では、`STAGING_D1_NAME` の D1 の id が `STAGING_D1_ID` と同じことも、書く前に確かめる。
- 日付を決めたいときは `BACKUP_DATE=YYYY-MM-DD`。なければ、今日（日本時間）から 35 日前へさかのぼって、最初に見つかったファイルを使う。
- 全テーブルの行数が元と合えば `restore rehearsal ok` を出して 0 で終わる。合わないテーブルは `MISMATCH`、バックアップにない表があれば `unexpected table` を出して 1 で終わる。
- 手元の D1・R2 で試すときは、`RESTORE_LOCAL=1`（保存先は `RESTORE_PERSIST_TO`、設定ファイルは `WRANGLER_CONFIG`）。
- 道具：`pnpm`（wrangler）、`node`、`gzip`。`wrangler login` 済みで、staging の D1 と R2 に触れるトークンが要る。

## 本番を復元する

障害（データの破損や削除）で、本番の D1 をバックアップから戻すとき。予行と同じファイルを使うが、**予行のスクリプトは staging 専用で、本番には使わない。**

1. 戻す日付を決める：`wrangler r2 object get nagi-backups/backups/<日付>.sqlgz --remote --file backup.sqlgz`。選んだファイルの日付より新しい変更は失われる（最大で 1 日ぶん）。
2. 壊れた D1 は、消さずに残す。`wrangler d1 create nagi-restore --location apac` で新しい D1 を作る。
3. `gzip -dc backup.sqlgz > backup.sql`。末尾の `-- rows <表> <行数>` を控える。
4. `wrangler d1 execute nagi-restore --remote --file backup.sql -y`。
5. 表ごとに `wrangler d1 execute nagi-restore --remote --command 'SELECT count(*) FROM "<表>"'` を回し、手順 3 の行数と合わせる。
6. `wrangler.jsonc` の `d1_databases[0].database_id` を新しい D1 の id に変え、`wrangler deploy`（`d1_migrations` の表も戻っているので、`pnpm release` の `migrations apply` は、すでに当たったものを飛ばす）。
7. 動作を確かめる：`curl -s https://api.usenagi.dev/api/session` が 401 を返す。ログインしてタスクが出る。クライアントの同期位置（cursor）が、戻したサーバーの通し番号より進んでいる場合、サーバーは `reset` を返し、クライアントは全件を取り直す（`src/worker/sync/changes.ts`）。
8. 戻ったと確かめてから、壊れた D1 を消す。
