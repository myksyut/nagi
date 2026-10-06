//! タスクをクリップボードに入れる（y）。形は Web 版の ⇧⌘C と同じ。
//! 端末のクリップボードには、OSC 52 のエスケープシーケンスで入れる（SSH の先からでも、手元の端末に届く）

use std::io::{self, Write};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// 何件かのタスクのあいだにはさむ行（メモの中の空の行と見分けられるように）
const SEPARATOR: &str = "\n\n---\n\n";

/// 空白（全角の空白・ノーブレークスペースも）だけの行を先頭から落とし、末尾の空白も落とす
fn memo_body(memo: &str) -> &str {
    let mut rest = memo;
    while let Some((line, after)) = rest.split_once('\n') {
        if !line.chars().all(char::is_whitespace) {
            break;
        }
        rest = after;
    }
    rest.trim_end()
}

/// タスク（タイトル、メモ）をクリップボードに入れる形。1件ずつ、1行目にタイトル、空の行をはさんでメモ
/// （メモが空ならタイトルだけ）。メモの先頭の空の行と末尾の空白は落とす（最初の行の字下げは残す）。
/// 何件かあるときは、渡した順に並べ、あいだに「---」の行をはさむ
pub fn task_clipboard_text(tasks: &[(String, String)]) -> String {
    tasks
        .iter()
        .map(|(title, memo)| {
            let body = memo_body(memo);
            if body.is_empty() {
                title.trim().to_string()
            } else {
                format!("{}\n\n{body}", title.trim())
            }
        })
        .collect::<Vec<_>>()
        .join(SEPARATOR)
}

/// コピーしたときのトーストの文言
pub fn copied_message(tasks: &[(String, String)]) -> String {
    match tasks {
        [(_, memo)] if memo.trim().is_empty() => "タイトルをコピーしました".to_string(),
        [_] => "タイトルとメモをコピーしました".to_string(),
        _ => format!("{}件のタイトルとメモをコピーしました", tasks.len()),
    }
}

/// クリップボードに入れるエスケープシーケンス（OSC 52）
fn osc52(text: &str) -> String {
    format!("\x1b]52;c;{}\x07", STANDARD.encode(text))
}

/// 端末のクリップボードに入れる。端末が受け取ったかどうかは分からない（端末の設定による）
pub fn write_clipboard(text: &str) -> io::Result<()> {
    let mut out = io::stdout();
    out.write_all(osc52(text).as_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str, memo: &str) -> (String, String) {
        (title.to_string(), memo.to_string())
    }

    #[test]
    fn 一件は_1行目にタイトル_空の行をはさんでメモ() {
        assert_eq!(
            task_clipboard_text(&[task("見積もりを確認", "先方の金額\nhttps://example.com")]),
            "見積もりを確認\n\n先方の金額\nhttps://example.com"
        );
    }

    #[test]
    fn メモが空ならタイトルだけ() {
        assert_eq!(task_clipboard_text(&[task("資料を送る", "")]), "資料を送る");
        assert_eq!(
            task_clipboard_text(&[task("資料を送る", " \n\t\n")]),
            "資料を送る"
        );
    }

    #[test]
    fn 前後の空白と先頭の空の行を落とし_字下げとメモの中の空の行は残す() {
        assert_eq!(
            task_clipboard_text(&[task("  議事録  ", "\n\n  - 決めたこと\n\n  - 宿題\n\n")]),
            "議事録\n\n  - 決めたこと\n\n  - 宿題"
        );
        // 全角の空白・ノーブレークスペース・CR だけの行も落とす
        assert_eq!(
            task_clipboard_text(&[task("議事録", "\u{3000}\n\u{a0}\t\r\n本文")]),
            "議事録\n\n本文"
        );
    }

    #[test]
    fn 何件かは_渡した順に並べて区切りの行をはさむ() {
        assert_eq!(
            task_clipboard_text(&[task("A", "a のメモ"), task("B", ""), task("C", "c1\n\nc2")]),
            "A\n\na のメモ\n\n---\n\nB\n\n---\n\nC\n\nc1\n\nc2"
        );
    }

    #[test]
    fn トーストの文言() {
        assert_eq!(
            copied_message(&[task("", "あり")]),
            "タイトルとメモをコピーしました"
        );
        assert_eq!(
            copied_message(&[task("", "  ")]),
            "タイトルをコピーしました"
        );
        assert_eq!(
            copied_message(&[task("", ""), task("", ""), task("", "x")]),
            "3件のタイトルとメモをコピーしました"
        );
    }

    #[test]
    fn クリップボードへは_base64_で渡す() {
        assert_eq!(osc52("nagi 凪"), "\x1b]52;c;bmFnaSDlh6o=\x07");
    }
}
