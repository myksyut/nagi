// nagi のデスクトップ版（試作）。本番の URL を開くだけの窓（中身は tauri.conf.json の app.windows）。
// 画面は同梱しない（本番に出すたびに、アプリにもそのまま反映される）。画面にネイティブの機能は渡さない
// （capabilities を置かないので、画面から Tauri の API は呼べない）。
// macOS の既定のメニュー（編集の ⌘Z・⌘C・⌘V など）はそのまま使う。キーは先に画面へ届き、
// 画面が使わなかったキーだけがメニューへ回る（WKWebView の決まり）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("nagi を起動できませんでした");
}
