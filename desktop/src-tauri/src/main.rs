// nagi のデスクトップ版。本番の URL を開くだけの窓（中身は tauri.conf.json の app.windows の "main"）。
// 画面は同梱しない（本番に出すたびに、アプリにもそのまま反映される）。画面にネイティブの機能は渡さない
// （capabilities を置かないので、画面から Tauri の API は呼べない。更新の確かめ・リンク・メニューは Rust の側だけで行う）。
// キーは先に画面へ届き、画面が使わなかったキーだけがメニューへ回る（WKWebView の決まり）ので、
// メニューに ⌘Z や ⌘R を置いても、nagi のキーとぶつからない
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{
    Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Runtime, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

/// nagi の窓の名前（tauri.conf.json の app.windows の label）
const MAIN_WINDOW: &str = "main";
/// メニューの「読み込み直す」
const RELOAD_MENU_ID: &str = "reload";

fn main() {
    tauri::Builder::default()
        // 画面のリンクのクリックを横取りする JS は入れない（開くのは on_new_window の1か所だけ）
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .menu(build_menu)
        .on_menu_event(|app, event| {
            if event.id() == RELOAD_MENU_ID {
                if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                    if let Err(error) = window.reload() {
                        eprintln!("読み込み直せませんでした: {error}");
                    }
                }
            }
        })
        .setup(|app| {
            open_main_window(app.handle())?;
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

/// nagi の窓を tauri.conf.json の設定から作る（設定では create: false にして、ここで作る）。
/// 新しい窓を開こうとしたら（メモのリンクの target="_blank"・window.open）、http と https のときだけ既定のブラウザで
/// 開き、窓はどれも開かない（opener は URL の種類を確かめずに OS に渡すので、file: やほかのアプリの URL は渡さない）。
/// 画面の移動（on_navigation）は止めない。wry は埋め込みの枠の移動にも同じ判定を当てるので、止めると
/// GitHub のログインの中の枠まで止めてしまう（nagi の外へのリンクは、どれも新しい窓で開く形）
fn open_main_window<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW)
        .cloned()
        .expect("tauri.conf.json に main の窓がない");
    let opener = app.clone();
    WebviewWindowBuilder::from_config(app, &config)?
        .on_new_window(move |url, _features| {
            if matches!(url.scheme(), "http" | "https") {
                if let Err(error) = opener.opener().open_url(url.as_str(), None::<&str>) {
                    eprintln!("リンクを開けませんでした: {error}");
                }
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// メニュー。編集・ウインドウ・ヘルプ・アプリの項目は macOS の既定と同じもの。「表示」に「読み込み直す（⌘R）」を置く。
/// ウインドウとヘルプは Tauri の決まった ID で作る（macOS がウインドウの一覧とメニューの検索を足すため）
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let app_menu = Submenu::with_items(
        app,
        "nagi",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("nagi について"), None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("サービス"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("nagi を隠す"))?,
            &PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?,
            &PredefinedMenuItem::show_all(app, Some("すべてを表示"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("nagi を終了"))?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("取り消す"))?,
            &PredefinedMenuItem::redo(app, Some("やり直す"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("カット"))?,
            &PredefinedMenuItem::copy(app, Some("コピー"))?,
            &PredefinedMenuItem::paste(app, Some("ペースト"))?,
            &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        app,
        "表示",
        true,
        &[
            &MenuItem::with_id(
                app,
                RELOAD_MENU_ID,
                "読み込み直す",
                true,
                Some("CmdOrCtrl+R"),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, Some("フルスクリーンにする"))?,
        ],
    )?;
    let window_menu = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        "ウインドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("しまう"))?,
            &PredefinedMenuItem::maximize(app, Some("拡大／縮小"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("閉じる"))?,
        ],
    )?;
    let help_menu = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "ヘルプ", true, &[])?;
    Menu::with_items(
        app,
        &[&app_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    )
}

/// 起動のたびに GitHub の Releases の latest.json を見て、新しい版があれば裏で入れ替えておく。
/// 開いている窓は止めない（次に開いたときから新しい版）。署名は tauri.conf.json の公開の鍵で確かめる
async fn install_update(app: AppHandle) -> tauri_plugin_updater::Result<()> {
    if let Some(update) = app.updater()?.check().await? {
        update.download_and_install(|_, _| {}, || {}).await?;
    }
    Ok(())
}
