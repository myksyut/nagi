# nagi のデスクトップ版（試作）

[Tauri](https://tauri.app/) で作った、本番の URL（https://nagi.wizard1026miya.workers.dev）を開くだけの Mac のアプリ。
画面は同梱しないので、本番に出すたびにアプリにもそのまま反映される。画面にネイティブの機能は渡さない（`capabilities` を置いていない）。

## ビルド

- **GitHub Actions**：`spike/tauri-desktop` に `desktop/` を変えて push するか、Actions の「desktop」を手で動かす。Mac（Apple シリコン）でビルドし、`nagi-macos.zip` を Artifacts に置く
- **手元の Mac**：Rust（rustup）と Xcode の Command Line Tools を入れて、`desktop/` で `npx @tauri-apps/cli@2.12.0 build --bundles app`。できるのは `src-tauri/target/release/bundle/macos/nagi.app`

M7（Linux）からは Mac のアプリは作れない。

## 開き方

Apple の開発者の署名はしていない（その場かぎりの署名だけ）。ダウンロードしたものは、初めて開く前に次のどちらかをする。

- ターミナルで `xattr -dr com.apple.quarantine nagi.app` を実行してから開く
- 開こうとして止められたら、システム設定 → プライバシーとセキュリティ →「このまま開く」

## 覚えておくこと

- ログインは、アプリの中で GitHub にもう一度する（ブラウザとは Cookie が別）。ログインはアプリを閉じても残る
- 中身は Safari と同じエンジン（WKWebView）。キーは先に画面へ届き、画面が使わなかったキーだけが macOS のメニュー（⌘Z の「取り消す」など）へ回る
