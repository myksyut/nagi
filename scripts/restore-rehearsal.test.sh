#!/usr/bin/env bash
# scripts/restore-rehearsal.sh が、staging でない D1 を、何かに触れる前に断ることを確かめる。
# wrangler の代わりに、呼ばれ方を記録するだけの偽の pnpm を使うので、Cloudflare にも手元の D1 にも触れない。
#   scripts/restore-rehearsal.test.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

STAGING_ID="0b7f6f1e-2d4c-4c1a-9a51-5d6e7f809a1b"
RESTORE_NAME="nagi-staging-restore-20261012"
RECOVERED_ID="5e0c3a2b-8d71-4f6e-b9a4-1c2d3e4f5a6b"
PROD_ID="$(node -e '
  const text = require("node:fs").readFileSync(process.argv[1], "utf8");
  console.log(/"database_id":\s*"([^"]+)"/.exec(text)[1]);' "$root/wrangler.jsonc")"

mkdir -p "$work/bin"
cat >"$work/bin/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "$*" >>"$CALLS"
if [[ "$*" == "exec wrangler d1 info"* ]]; then
  echo "$FAKE_INFO"
  exit 0
fi
exit 1
EOF
chmod +x "$work/bin/pnpm"

failures=0
# run <説明> <wrangler.jsonc> <期待：refuse か proceed> [環境変数=値 ...]
run() {
  local name="$1" config="$2" expect="$3"
  shift 3
  local repo="$work/repo"
  rm -rf "$repo"
  mkdir -p "$repo/scripts"
  cp "$root/scripts/restore-rehearsal.sh" "$repo/scripts/"
  [[ -n "$config" ]] && printf '%s\n' "$config" >"$repo/wrangler.jsonc"
  : >"$work/calls"
  local status=0
  env PATH="$work/bin:$PATH" CALLS="$work/calls" BACKUP_BUCKET=nagi-backups BACKUP_DATE=2026-10-12 \
    FAKE_INFO='{"uuid":"'"$STAGING_ID"'","name":"'"$RESTORE_NAME"'"}' \
    STAGING_D1_ID="$STAGING_ID" STAGING_D1_NAME="$RESTORE_NAME" "$@" \
    bash "$repo/scripts/restore-rehearsal.sh" >"$work/out" 2>&1 || status=$?
  local touched
  touched="$(grep -v '^exec wrangler d1 info ' "$work/calls" || true)"
  if [[ "$expect" == refuse ]]; then
    if [[ $status -ne 0 && -z "$touched" ]] && grep -q 'refusing' "$work/out"; then
      echo "ok - refuses: $name ($(tail -n 1 "$work/out"))"
      return
    fi
  elif [[ "$touched" == "exec wrangler r2 object get"* ]]; then
    echo "ok - proceeds: $name"
    return
  fi
  echo "not ok - $name (exit $status)"
  sed 's/^/  out: /' "$work/out"
  sed 's/^/  call: /' "$work/calls"
  failures=$((failures + 1))
}

prod_config="$(cat "$root/wrangler.jsonc")"
# 復元の手順（docs/operations.md）のあと：本番の D1 は nagi-restore で、wrangler.jsonc の id がそれに変わっている
recovered_config="${prod_config//$PROD_ID/$RECOVERED_ID}"

run "production name" "$prod_config" refuse STAGING_D1_NAME=nagi
run "production id" "$prod_config" refuse STAGING_D1_ID="$PROD_ID"
run "production id in upper case" "$prod_config" refuse STAGING_D1_ID="${PROD_ID^^}"
run "production id, local" "$prod_config" refuse STAGING_D1_ID="$PROD_ID" RESTORE_LOCAL=1
run "restore target named in the runbook" "$recovered_config" refuse STAGING_D1_NAME=nagi-restore \
  STAGING_D1_ID="$RECOVERED_ID"
run "recovered production id under a staging name" "$recovered_config" refuse \
  STAGING_D1_ID="$RECOVERED_ID"
run "production database named like staging" \
  '{ "d1_databases": [{ "binding": "DB", "database_name": "nagi-staging-restore-20261012", "database_id": "'"$RECOVERED_ID"'" }] }' \
  refuse
run "shared staging database (nagi-staging)" "$prod_config" refuse STAGING_D1_NAME=nagi-staging \
  FAKE_INFO='{"uuid":"'"$STAGING_ID"'","name":"nagi-staging"}'
run "shared staging database, local" "$prod_config" refuse STAGING_D1_NAME=nagi-staging RESTORE_LOCAL=1
run "staging prefix without the restore marker" "$prod_config" refuse STAGING_D1_NAME=nagi-staging-e2e
run "restore marker without the hyphen" "$prod_config" refuse STAGING_D1_NAME=nagi-stagingrestore
run "restore name as a suffix" "$prod_config" refuse STAGING_D1_NAME=old-nagi-staging-restore
run "wrangler.jsonc missing" "" refuse
run "wrangler.jsonc without d1_databases" '{ "name": "nagi" }' refuse
run "binding name instead of a database name" "$prod_config" refuse STAGING_D1_NAME=DB
run "not a UUID" "$prod_config" refuse STAGING_D1_ID=nagi-staging
run "remote id differs from STAGING_D1_ID" "$prod_config" refuse \
  FAKE_INFO='{"uuid":"'"$RECOVERED_ID"'","name":"'"$RESTORE_NAME"'"}'
run "remote name differs (config maps the name to another database)" "$prod_config" refuse \
  FAKE_INFO='{"uuid":"'"$STAGING_ID"'","name":"nagi"}'
run "remote resolves to the production database" "$prod_config" refuse \
  STAGING_D1_ID="$STAGING_ID" FAKE_INFO='{"uuid":"'"$PROD_ID"'","name":"nagi"}'
run "restore database (remote)" "$prod_config" proceed
run "restore database after recovery (remote)" "$recovered_config" proceed
run "restore database (local)" "$prod_config" proceed RESTORE_LOCAL=1

if [[ $failures -gt 0 ]]; then
  echo "$failures case(s) failed" >&2
  exit 1
fi
echo "all cases passed"
