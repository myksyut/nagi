# TUI の出し方

TUI（`nagi`）は、`v<版>` のタグを push したときだけ出る。main にマージしても Release は出ない。版の正本は `tui/Cargo.toml` の `version`（semver）で、タグと違えば `tui.yml` の `check` が失敗する。

## 出す

1. `CHANGELOG.md` に `## [<版>]` の節を足し、`tui/Cargo.toml` の `version`（と `tui/Cargo.lock` の `nagi` の版）を直す PR を作る。節がないと Release は失敗する。
2. マージする。
3. main の先頭で、タグを付けて push する。

   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

`tui.yml` は、まず `source` でタグを commit SHA に一度だけ解決し、`check`・各 `build`・`release`・`tap` はすべてその SHA を checkout する（タグ名では checkout しない）。そのうえで `check`（整形・lint・テスト・版の突き合わせ）と、target ごとのビルドと動作確認（`nagi --version` と、一時的な HOME での `add` / `list --json`）を通し、Release を作る直前にタグがまだその SHA を指すか確かめる（動いていたら失敗する）。そのあと次を行う。

- `SHA256SUMS` と provenance をつけて Release を作る。本文は CHANGELOG のその版の節に、PR の一覧（`.github/release.yml` の label の分け方）が続く
- Homebrew の tap（`vars.TAP_REPOSITORY`。なければ `myksyut/homebrew-tap`）の formula を更新する。secret `TAP_GITHUB_TOKEN` がなければ失敗する

タグに `-` があれば（`v0.3.0-rc.1` など）プレリリースになる。latest にはならず、tap も更新しない。

## 失敗したら

tap の更新だけが失敗したとき（トークンの期限切れなど）は、直してから、Release を作り直さずに `tap` だけをやり直す。Release がもうあるので、どの ref からでも動かせる。

```sh
gh workflow run tui.yml --ref v0.2.0 -f tag=v0.2.0
```

タグの上で動かした `--ref v0.2.0` の形が正式な形で、Release をまだ作っていないタグを手で出すときも同じ。Release がなく、タグ以外の ref（main など）から動かすと、`source` が失敗する（provenance がビルドしたソースと合わなくなるため）。

`check` や `build` が失敗したときは、公開済みのタグを動かさない。直す PR をマージして、新しい patch 版（`v0.2.1` など）を切る。

## 取り消す

```sh
gh release delete v0.2.0 --cleanup-tag
```

あわせて、tap の `nagi 0.2.0` のコミットを revert する（tap のリポジトリで `git revert <sha>` を push する）。

## 確かめる

```sh
gh release download v0.2.0 --repo myksyut/nagi
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify nagi-x86_64-unknown-linux-musl.tar.gz --repo myksyut/nagi
```

以前の `tui-v0.1.<番号>` の Release は、消さずに残してある。
