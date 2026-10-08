#!/usr/bin/env bash
# Homebrew の formula（myksyut/homebrew-tap の Formula/nagi.rb）を書き出す。
# 使い方：scripts/homebrew-formula.sh <版> <Mac の tar.gz の sha256> <Linux の tar.gz の sha256>
# Release のワークフロー（tui.yml）が、出すたびにこれで tap を更新する。手で更新するときも同じ
set -euo pipefail
if [ $# -ne 3 ]; then
  echo "使い方: $0 <版> <sha256 (aarch64-apple-darwin)> <sha256 (x86_64-unknown-linux-musl)>" >&2
  exit 2
fi
version=$1 sha_darwin=$2 sha_linux=$3
base="https://github.com/myksyut/nagi/releases/download/tui-v${version}"
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
