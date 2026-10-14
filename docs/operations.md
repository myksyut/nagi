# 運用

本番の D1（`nagi`）のバックアップ、障害の通知、復元の手順。

## バックアップ

- Worker の cron（`wrangler.jsonc` の `triggers.crons` の `37 19 * * *`。毎日 日本時間の 4 時 37 分）が、D1 の全テーブルを SQL にして gzip し、R2 バケット `nagi-backups`（束縛 `BACKUPS`）の `backups/YYYY-MM-DD.sqlgz` に書く。日付は、アプリの時間帯（`APP_TIMEZONE`、日本時間）のもの。同じ日にもう 1 回走ると、同じ名前のファイルが置き換わる。
- 書き込みが成功したあとだけ、日付が 35 日より古い `backups/YYYY-MM-DD.sqlgz` を消す（今日からちょうど 35 日前のものは残す）。名前がこの形でないものは触らない。
- 表の行は、`rowid` の順にページで読む。1 ページは 1 つのクエリで、最大 1000 行、かつ行の大きさ（全部の列の UTF-8 のバイト数の和に 1 KiB を足したもの）の累計が 2 MiB まで（1 行は必ず読む。API が受け付ける最大のタスクは 1 行 680 KB 未満）。SQL は 1 行ずつ作って少しずつ圧縮し、R2 へはマルチパートで流すので、ページ全体の SQL も、ファイル全体も、メモリに持たない。R2 のオブジェクトは、書き終えてはじめて現れる。途中で失敗しても、書きかけのファイルは残らず、同じ日の前のファイルも、古いファイルも減らない。
- 1 回の実行は、D1 へ 900 クエリまで（D1 の上限は 1000）。表の一覧と、表ごとの列の一覧を除いた 890 ほどがページに使える。小さい行なら約 89 万行、文字の量なら約 1.2 GB から 1.8 GB（ページの詰まり方による）、API が受け付ける最大のタスクばかりなら約 4,400 件が目安。超えると失敗する（そのときは、実行を分ける設計に直す）。
- 読み出しはページごとで、D1 の 1 つの時点を切り取ったものではない。書き込みの少ない時間帯（4 時台）に走らせるのはそのため。
- ファイルの形：先頭に `-- nagi backup <時刻>`、続いて表の定義、行、索引・トリガー・ビュー、最後に表ごとの行数の控え（`-- rows <表> <行数>`）。文はどれも「;」と改行で終わり、文の途中に改行はなく、1 文は 90,000 バイト以下（D1 の上限は 100,000 バイト）。行は 1 行 1 文の `INSERT` で、収まらない行は、大きい文字列の列を空にした `INSERT` のあとに、主キーで行を指す `UPDATE … SET 列 = 列 || 断片` を続けて、列を文字の切れ目で分けて足す。NUL か改行を含む文字列は `CAST(X'…' AS TEXT)`（UTF-8 のバイトの 16 進）で書く。
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

## 復元の予行（予行専用の D1 だけ）

いちばん新しいバックアップを、予行専用の D1 に読み込み、表ごとの行数を、バックアップに記録された元の行数と突き合わせる。**予行専用の D1 の中身を、すべて消してから読み込む。** 本番の D1 には何も書かない。

バックアップは本番のユーザーデータそのものなので、テストや侵入テストに共用している staging の D1（`nagi-staging`）には読み込まない。予行の直前に専用の D1 を作り、終わったらすぐ消す。本番のユーザーデータを staging に置いたままにしない。

```sh
wrangler d1 create nagi-staging-restore-$(date +%Y%m%d)   # 出た database_id を控える
export STAGING_D1_ID=<作った D1 の id>
export STAGING_D1_NAME=nagi-staging-restore-YYYYMMDD   # nagi-staging-restore で始まる
export BACKUP_BUCKET=<バックアップの R2 バケット>   # 例：nagi-backups
scripts/restore-rehearsal.sh
wrangler d1 delete nagi-staging-restore-YYYYMMDD   # 結果を確かめたら、すぐ消す
```

- 予行用の D1 の名前は `nagi-staging-restore` で始める。スクリプトは、次の D1 を、何も読まずに、何も書かずに、0 以外で断る。
  - 名前が `nagi-staging-restore` で始まらないもの。共用の `nagi-staging` も断る。
  - `wrangler.jsonc` の最上位の `d1_databases`（今の本番の D1）と、id か名前が同じもの。スクリプトは、手元の `wrangler.jsonc` を読むので、最新の main で走らせる。
  - remote で、`STAGING_D1_NAME` の D1 の実際の id と名前（`wrangler d1 info`）が、`STAGING_D1_ID` と `STAGING_D1_NAME` に合わないもの。
- 断る場合は `scripts/restore-rehearsal.test.sh` で確かめられる（偽の wrangler を使うので、Cloudflare にも手元の D1 にも触れない）。スクリプトを変えたら走らせる。
- 日付を決めたいときは `BACKUP_DATE=YYYY-MM-DD`。なければ、今日（日本時間）から 35 日前へさかのぼって、最初に見つかったファイルを使う。
- 全テーブルの行数が元と合えば `restore rehearsal ok` を出して 0 で終わる。合わないテーブルは `MISMATCH`、バックアップにない表があれば `unexpected table` を出して 1 で終わる。
- 手元の D1・R2 で試すときは、`RESTORE_LOCAL=1`（保存先は `RESTORE_PERSIST_TO`）。手元でも本番の名前（`nagi`）は断るので、`WRANGLER_CONFIG` に、`nagi-staging-restore` で始まる名前の D1 と、バックアップのバケットだけを書いた設定ファイルを渡す。例：`{ "name": "nagi-staging-restore-local", "compatibility_date": "2026-08-15", "d1_databases": [{ "binding": "DB", "database_name": "nagi-staging-restore-local", "database_id": "<適当な UUID>" }], "r2_buckets": [{ "binding": "BACKUPS", "bucket_name": "nagi-backups" }] }`。`wrangler dev --test-scheduled --persist-to <保存先>` で作ったバックアップを、同じ保存先の別の D1 に戻す。
- 道具：`pnpm`（wrangler）、`node`、`gzip`。`wrangler login` 済みで、D1 の作成・削除と R2 の読み取りができるトークンが要る。

## 本番を復元する

障害（データの破損や削除）で、本番の D1 をバックアップから戻すとき。予行と同じファイルを使うが、**予行のスクリプトは予行専用の D1 のためのもので、本番には使わない。**

1. 戻す日付を決める：`wrangler r2 object get nagi-backups/backups/<日付>.sqlgz --remote --file backup.sqlgz`。選んだファイルの日付より新しい変更は失われる（最大で 1 日ぶん）。
2. 壊れた D1 は、消さずに残す。`wrangler d1 create nagi-restore --location apac` で新しい D1 を作る。復元先の名前は `nagi-staging` で始めない（staging の D1 と取り違えないため）。
3. `gzip -dc backup.sqlgz > backup.sql`。末尾の `-- rows <表> <行数>` を控える。
4. `wrangler d1 execute nagi-restore --remote --file backup.sql -y`。
5. 表ごとに `wrangler d1 execute nagi-restore --remote --command 'SELECT count(*) FROM "<表>"'` を回し、手順 3 の行数と合わせる。
6. `wrangler.jsonc` の最上位の `d1_databases[0].database_id` を新しい D1 の id に変えて main に入れ、`wrangler deploy`（`d1_migrations` の表も戻っているので、`pnpm release` の `migrations apply` は、すでに当たったものを飛ばす）。`database_name` は `nagi` のままにする（`package.json` のコマンドがこの名前で指し、wrangler は設定の id で D1 を選ぶ）。予行のスクリプトは、この id を本番として断るので、断る相手も新しい D1 に移る。
7. 動作を確かめる：`curl -s https://api.usenagi.dev/api/session` が 401 を返す。ログインしてタスクが出る。クライアントの同期位置（cursor）が、戻したサーバーの通し番号より進んでいる場合、サーバーは `reset` を返し、クライアントは全件を取り直す（`src/worker/sync/changes.ts`）。
8. 戻ったと確かめてから、壊れた D1 を消す。
