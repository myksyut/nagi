#!/usr/bin/env bash
# CHANGELOG.md（標準入力）から、`## [<版>]` の節だけを出す（次の `## ` の手前まで）。
# 使い方：scripts/changelog-section.sh <版> < CHANGELOG.md
# 節がない、または中身が空なら 1 で終わる。Release の本文に使う（tui.yml の release）
set -euo pipefail
if [ $# -ne 1 ]; then
  echo "使い方: $0 <版> < CHANGELOG.md" >&2
  exit 2
fi
# 前後の空行は落とす
section=$(awk -v v="$1" '
  /^## / { if (found) exit; found = (index($0, "## [" v "]") == 1); next }
  found && (n > 0 || NF) { lines[n++] = $0 }
  END { while (n > 0 && lines[n - 1] ~ /^[ \t]*$/) n--; for (i = 0; i < n; i++) print lines[i] }
')
if [ -z "$section" ]; then
  echo "CHANGELOG.md に ## [$1] の節がない（または空）" >&2
  exit 1
fi
printf '%s\n' "$section"
