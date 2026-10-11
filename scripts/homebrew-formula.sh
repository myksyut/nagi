#!/usr/bin/env bash
# Homebrew の formula（tap の Formula/nagi.rb）を書き出す。
# 使い方：scripts/homebrew-formula.sh <版> <SHA256SUMS のパス>
# ハッシュは SHA256SUMS から、tar.gz の名前（nagi-<target>.tar.gz）で引く。引けない target があれば 2 で終わる。
# Release のワークフロー（tui.yml）が、出すたびにこれで tap を更新する。手で更新するときも同じ。
# URL の取り元は環境変数 NAGI_REPOSITORY（既定 myksyut/nagi。drill では drill のリポジトリを入れる）
set -euo pipefail
if [ $# -ne 2 ]; then
  echo "使い方: $0 <版> <SHA256SUMS のパス>" >&2
  exit 2
fi
version=$1 sums=$2
if [ ! -f "$sums" ]; then
  echo "$sums がない" >&2
  exit 2
fi

sha_of() {
  local hash
  hash=$(awk -v f="nagi-$1.tar.gz" '$2 == f || $2 == "*" f { print $1; exit }' "$sums")
  if [ -z "$hash" ]; then
    echo "$sums に nagi-$1.tar.gz の行がない" >&2
    exit 2
  fi
  printf '%s' "$hash"
}
sha_darwin=$(sha_of aarch64-apple-darwin)
sha_linux=$(sha_of x86_64-unknown-linux-musl)
base="https://github.com/${NAGI_REPOSITORY:-myksyut/nagi}/releases/download/v${version}"
cat <<RUBY
# Release のバイナリを入れる formula（ビルドはしない）。nagi の scripts/homebrew-formula.sh が書き出す
class Nagi < Formula
  desc "Terminal TODO app (TUI and CLI); works offline, syncs to the cloud when logged in"
  homepage "https://github.com/myksyut/nagi"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
      url "${base}/nagi-aarch64-apple-darwin.tar.gz"
      sha256 "${sha_darwin}"
    end
  end

  on_linux do
    on_intel do
      url "${base}/nagi-x86_64-unknown-linux-musl.tar.gz"
      sha256 "${sha_linux}"
    end
  end

  def install
    bin.install "nagi"
  end

  test do
    assert_match "nagi ${version}", shell_output("#{bin}/nagi --version")
  end
end
RUBY
