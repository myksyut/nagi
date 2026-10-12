#!/usr/bin/env bash
# いちばん新しい D1 のバックアップ（R2 の backups/YYYY-MM-DD.sqlgz）を staging の D1 に読み込み、
# 表ごとの行数を、バックアップに記録された元の行数と突き合わせる（docs/operations.md の「復元の予行」）。
#
# staging の D1 の中身を、すべて消してから読み込む。本番の D1 には、何も書かない（本番の id と名前は、最初に断る）。
#
# 必須の環境変数
#   STAGING_D1_ID       staging の D1 の id（UUID）
#   STAGING_D1_NAME     staging の D1 の名前。remote では、この名前の D1 の id が STAGING_D1_ID と同じと確かめてから書く
#   BACKUP_BUCKET       バックアップの R2 バケットの名前
# 任意の環境変数
#   BACKUP_DATE         読み込む日付（YYYY-MM-DD）。なければ、今日から 35 日前へさかのぼって、最初に見つかったもの
#   RESTORE_LOCAL=1     remote ではなく、手元の D1 と R2 を使う（wrangler dev の保存先）。RESTORE_PERSIST_TO で保存先を指す
#   WRANGLER_CONFIG     wrangler の設定ファイル（-c に渡す）
set -euo pipefail

PROD_D1_ID="770a86db-0365-4b58-ab4f-842f1d0684d3"
PROD_D1_NAME="nagi"
RETENTION_DAYS=35

die() {
  echo "restore-rehearsal: $*" >&2
  exit 1
}

# ---- 何かに触れる前の検査（本番と staging 以外の取り違えを、ここで止める） ----
: "${STAGING_D1_ID:?STAGING_D1_ID is required}"
: "${STAGING_D1_NAME:?STAGING_D1_NAME is required}"
: "${BACKUP_BUCKET:?BACKUP_BUCKET is required}"

shopt -s nocasematch
[[ "$STAGING_D1_ID" == "$PROD_D1_ID" ]] && die "refusing: $STAGING_D1_ID is the production database id"
[[ "$STAGING_D1_NAME" == "$PROD_D1_NAME" ]] && die "refusing: '$STAGING_D1_NAME' is the production database name"
[[ "$STAGING_D1_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || die "STAGING_D1_ID is not a UUID: $STAGING_D1_ID"
shopt -u nocasematch
if [[ -n "${BACKUP_DATE:-}" && ! "$BACKUP_DATE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  die "BACKUP_DATE must be YYYY-MM-DD: $BACKUP_DATE"
fi

cd "$(dirname "$0")/.."
WRANGLER=(pnpm exec wrangler)
CONFIG_ARGS=()
[[ -n "${WRANGLER_CONFIG:-}" ]] && CONFIG_ARGS=(-c "$WRANGLER_CONFIG")
STORAGE_ARGS=(--remote)
if [[ "${RESTORE_LOCAL:-}" == "1" ]]; then
  STORAGE_ARGS=(--local)
  [[ -n "${RESTORE_PERSIST_TO:-}" ]] && STORAGE_ARGS+=(--persist-to "$RESTORE_PERSIST_TO")
fi

wr() { "${WRANGLER[@]}" "$@"; }
d1() { wr d1 execute "$STAGING_D1_NAME" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} "${STORAGE_ARGS[@]}" --json -y "$@" </dev/null; }
# d1 の --json の出力（結果の配列）から、行を 1 行ずつ「列1<TAB>列2…」で出す
rows() { node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const start = s.indexOf("[");
    const out = start < 0 ? null : JSON.parse(s.slice(start));
    if (!Array.isArray(out)) {
      console.error(s.trim() || "wrangler returned no output");
      process.exit(1);
    }
    for (const r of out.flatMap((q) => q.results ?? [])) console.log(Object.values(r).join("\t"));
  });'; }

if [[ "${RESTORE_LOCAL:-}" != "1" ]]; then
  actual_id="$(wr d1 info "$STAGING_D1_NAME" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} --json | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const info = JSON.parse(s.slice(s.indexOf("{")));
      console.log(info.uuid ?? info.database_id ?? "");
    });')"
  [[ "$actual_id" == "$STAGING_D1_ID" ]] \
    || die "refusing: database '$STAGING_D1_NAME' has id '$actual_id', not STAGING_D1_ID"
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ---- いちばん新しいバックアップを取る ----
fetch() { wr r2 object get "$BACKUP_BUCKET/backups/$1.sqlgz" ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} "${STORAGE_ARGS[@]}" --file "$work/backup.sqlgz" >/dev/null 2>&1; }

backup_date=""
if [[ -n "${BACKUP_DATE:-}" ]]; then
  fetch "$BACKUP_DATE" || die "no backup for $BACKUP_DATE in $BACKUP_BUCKET"
  backup_date="$BACKUP_DATE"
else
  for ago in $(seq 0 "$RETENTION_DAYS"); do
    day="$(node -e 'const d = new Date(Date.now() - Number(process.argv[1]) * 864e5); console.log(d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }))' "$ago")"
    if fetch "$day"; then backup_date="$day"; break; fi
  done
  [[ -n "$backup_date" ]] || die "no backup in the last $RETENTION_DAYS days in $BACKUP_BUCKET"
fi
echo "backup: backups/$backup_date.sqlgz"

gzip -dc "$work/backup.sqlgz" >"$work/dump.sql" || die "backup is not a valid gzip file"
# 控え（-- rows <表> <行数>）。1 行もなければ、不完全なファイルとして断る
grep '^-- rows ' "$work/dump.sql" | awk '{print $3 "\t" $4}' | sort >"$work/expected.tsv" || true
[[ -s "$work/expected.tsv" ]] || die "backup has no row-count manifest; refusing to restore an incomplete file"

# ---- staging の中身を消して、読み込む ----
d1 --command "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\' ORDER BY type DESC" \
  | rows >"$work/existing.tsv"
{
  echo "PRAGMA defer_foreign_keys = on;"
  while IFS=$'\t' read -r kind name; do
    [[ "$kind" == "view" ]] && echo "DROP VIEW IF EXISTS \"$name\";"
  done <"$work/existing.tsv"
  while IFS=$'\t' read -r kind name; do
    [[ "$kind" == "table" ]] && echo "DROP TABLE IF EXISTS \"$name\";"
  done <"$work/existing.tsv"
} >"$work/wipe.sql"
d1 --file "$work/wipe.sql" >/dev/null
d1 --file "$work/dump.sql" >/dev/null

# ---- 行数の突き合わせ ----
# D1 は 1 つの SELECT に繋げる UNION が 5 つまでなので、表ごとに数える
: >"$work/restored.tsv"
while IFS=$'\t' read -r table _; do
  d1 --command "SELECT count(*) AS n FROM \"$table\"" | rows | sed "s/^/$table\t/" >>"$work/restored.tsv"
done <"$work/expected.tsv"
d1 --command "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\' AND name NOT LIKE '\_cf\_%' ESCAPE '\' ORDER BY name" \
  | rows >"$work/tables.txt"

status=0
printf '%-24s %10s %10s\n' table expected restored
while IFS=$'\t' read -r table expected; do
  restored="$(awk -F'\t' -v t="$table" '$1 == t {print $2}' "$work/restored.tsv")"
  verdict=ok
  [[ "$restored" == "$expected" ]] || { verdict=MISMATCH; status=1; }
  printf '%-24s %10s %10s  %s\n' "$table" "$expected" "${restored:-missing}" "$verdict"
done <"$work/expected.tsv"
while read -r table; do
  grep -q "^$table"$'\t' "$work/expected.tsv" || { echo "unexpected table not in backup: $table"; status=1; }
done <"$work/tables.txt"

[[ $status -eq 0 ]] && echo "restore rehearsal ok" || echo "restore rehearsal FAILED" >&2
exit $status
