# nagi のデスクトップ版

[Tauri](https://tauri.app/) で作った、本番の URL（https://nagi.wizard1026miya.workers.dev）を開くだけの Mac のアプリ。
画面は同梱しないので、nagi を本番に出すたびにアプリにもそのまま反映される（開いている窓は、閉じて開き直すと新しい版になる）。画面にネイティブの機能は渡さない（`capabilities` を置いていない）。

## 入れ方（初めての1回だけ）

1. [GitHub の Releases の最新](https://github.com/myksyut/nagi/releases/latest) から `.app.tar.gz` を落とし、展開した `nagi.app` を「アプリケーション」に置く
2. Apple の開発者の署名はしていない（その場かぎりの署名だけ）ので、ターミナルで `xattr -dr com.apple.quarantine /Applications/nagi.app` を実行してから開く
3. アプリの中で GitHub にログインする（ブラウザとは Cookie が別。ログインはアプリを閉じても残る）

## 更新

`desktop/` を変えて main にマージすると、`.github/workflows/desktop.yml` が GitHub の Mac（Apple シリコン）でビルドし、GitHub の Releases に `desktop-v0.1.<実行の番号>` として出す。アプリは起動のたびに `releases/latest/download/latest.json` を見て、新しい版があれば裏で入れ替える（次に開いたときから新しい版）。

- 更新のファイルは、secret の `TAURI_SIGNING_PRIVATE_KEY`（パスワードなし）で署名する。アプリは `tauri.conf.json` の `plugins.updater.pubkey` で確かめる。秘密の鍵の元は、利用者の Mac の `~/.tauri/nagi-updater.key`（M7 には置かない）
- 鍵をなくしたときは、新しい鍵を作って secret と `pubkey` を差し替え、アプリを上の手順で入れ直す（古い鍵で署名した版しか受け付けないため）
- PR では、Mac でビルドできるかだけを確かめる（署名も公開もしない）
- Release は下書きで作り、アプリ・署名・`latest.json` がそろってから公開して latest にする（そろうまでは、アプリは前の版の `latest.json` を見る）
- 出し直すときは、Actions の「desktop」を新しく手で動かす。失敗した実行のやり直し（Re-run）では実行の番号が増えず、同じ版になる
- `releases/latest` はデスクトップ版の更新の入口なので、ほかの用途の Release を latest にしない

## 手元の Mac でビルドする

Rust（rustup）と Xcode の Command Line Tools を入れて、`desktop/` で次を実行する。できるのは `src-tauri/target/release/bundle/macos/nagi.app`。

```sh
npx @tauri-apps/cli@2.12.0 build --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

M7（Linux）からは Mac のアプリは作れない。

## 覚えておくこと

- 中身は Safari と同じエンジン（WKWebView）。キーは先に画面へ届き、画面が使わなかったキーだけが macOS のメニュー（⌘Z の「取り消す」など）へ回る
- ⌘W で窓を閉じると、アプリも終わる（窓が1つだけのため）
