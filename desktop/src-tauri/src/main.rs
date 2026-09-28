// nagi のデスクトップ版。本番の URL を開くだけの窓（中身は tauri.conf.json の app.windows）。
// 画面は同梱しない（本番に出すたびに、アプリにもそのまま反映される）。画面にネイティブの機能は渡さない
// （capabilities を置かないので、画面から Tauri の API は呼べない。更新の確かめは Rust の側だけで行う）。
// macOS の既定のメニュー（編集の ⌘Z・⌘C・⌘V など）はそのまま使う。キーは先に画面へ届き、
// 画面が使わなかったキーだけがメニューへ回る（WKWebView の決まり）
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_updater::UpdaterExt;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = install_update(handle).await {
                    eprintln!("新しい版を確かめられませんでした: {error}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("nagi を起動できませんでした");
}

/// 起動のたびに GitHub の Releases の latest.json を見て、新しい版があれば裏で入れ替えておく。
/// 開いている窓は止めない（次に開いたときから新しい版）。署名は tauri.conf.json の公開の鍵で確かめる
async fn install_update(app: tauri::AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}
