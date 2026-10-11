//! nagi の更新のしかた。入れ方（Homebrew か、Release から手で置いたか）で、案内するコマンドを変える

use std::path::Path;
use std::sync::LazyLock;

use crate::data::{StopReason, Store};
use crate::i18n::{Msg, fill, t};

const BREW_UPGRADE: &str = "brew upgrade nagi";
const RELEASES_URL: &str = "https://github.com/myksyut/nagi/releases/latest";

/// この nagi を更新するコマンド（または入手先の URL）。実行しているファイルの実際の場所で決める
/// （下の欄は毎回描き直すので、一度だけ調べる）
static UPGRADE_COMMAND: LazyLock<&'static str> = LazyLock::new(|| {
    // シンボリックリンク（Homebrew の bin/nagi など）は、たどった先で見る
    match std::env::current_exe().and_then(|path| path.canonicalize()) {
        Ok(path) => command_for(&path),
        Err(_) => RELEASES_URL,
    }
});

pub fn upgrade_command() -> &'static str {
    *UPGRADE_COMMAND
}

fn command_for(exe: &Path) -> &'static str {
    if exe.to_string_lossy().contains("/Cellar/") {
        BREW_UPGRADE
    } else {
        RELEASES_URL
    }
}

/// nagi の更新を求める文（数の変わらない知らせ。送っていない変更の数は下の欄に出す）
pub fn upgrade_hint() -> String {
    fill(Msg::UpgradeHint, &[&upgrade_command()])
}

/// nagi の更新を待って止まっているときの文。下の欄と CLI で同じ文にする
pub fn upgrade_message(store: &Store) -> String {
    let hint = upgrade_hint();
    let message = match unsent_note(store) {
        Some(note) => fill(Msg::UpgradeHintWithNote, &[&hint, &note]),
        None => hint,
    };
    if store.stopped_by == Some(StopReason::UnreadablePending) {
        fill(Msg::UpgradeUnreadablePending, &[&message])
    } else {
        message
    }
}

/// Worker の更新を待っているときの文（この nagi のほうが新しい）
pub fn waiting_message(store: &Store) -> String {
    match unsent_note(store) {
        Some(note) => fill(Msg::WaitingForWorkerWithNote, &[&note]),
        None => t(Msg::WaitingForWorker).to_string(),
    }
}

/// 送らずに持っている変更が、閉じても残るか
fn unsent_note(store: &Store) -> Option<String> {
    match store.pending_count() {
        0 => None,
        count if store.unsent_kept() => Some(fill(Msg::UnsentKept, &[&count])),
        count => Some(fill(Msg::UnsentNotSaved, &[&count])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn homebrew_で入れたら_brew_upgrade_それ以外は_release_の_url() {
        assert_eq!(
            command_for(Path::new("/opt/homebrew/Cellar/nagi/1.0.0/bin/nagi")),
            "brew upgrade nagi"
        );
        assert_eq!(
            command_for(Path::new("/home/u/bin/nagi")),
            "https://github.com/myksyut/nagi/releases/latest"
        );
    }
}
