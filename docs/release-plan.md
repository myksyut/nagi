# nagi 本格リリースの計画

nagi を、作者以外の人が入れて使える製品にする。ローカルは誰でも無料、クラウド同期は月額の有料にする。
対象は日本語と英語を話す人。Mac（Apple シリコンと Intel）、Linux（x64 と arm64）、Windows で動かす。
守る決まりは一つ。どの PR も、実際の画面か実際の応答で確かめてからマージする。
クラウドを開く前に、攻撃者の視点で侵入テストをし、重い穴をすべてふさぐ。
PR の順は R00 から R24。依存は各節の Depends on に書く。

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `skills/poteto-mode/playbooks/orchestrate.md`. 実行はこのセッションの root が受け持つ。マージは運用者がする。運用者の判断が要る PR（R03、R05、R07、R10、R11、R13、R19、R23、R24）は merge-ready で止め、画面と動画を見せてから運用者が押す。ドメインの購入、決済の会社と値段、Workers Paid への切り替え、`TAP_GITHUB_TOKEN` の作成、TAURI の secret の削除は、運用者の手で行う。

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on her explicit go.
- [ ] On her go, adopt the run objective with this exact text. "Run docs/release-plan.md from R00 to R24 in dependency order. Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. The operator merges every PR. Done when R24 is merged, 1.0.0 is published, and cloud sign-up is open behind billing."
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show origin/main:docs/release-plan.md`
  - [ ] `git show origin/main:README.md`
  - [ ] `git show origin/main:.github/workflows/tui.yml`
  - [ ] `git show origin/main:wrangler.jsonc`
  - [ ] Read `skills/poteto-mode/playbooks/orchestrate.md`, `skills/swarm/SKILL.md`, and `skills/poteto-mode/playbooks/opening-a-pr.md` from the installed poteto-pi package.
- [ ] Arm the 30-minute audit tick as a bash polling loop with an explicit iteration cap of 96. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk and the run objective. Audit the operation against both and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then send the operator a status message, whether or not anything changed, with the queue table of PR, owner, state, and head SHA, the verdicts since the last tick, what merged, open operator gates, and blockers."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.

### Run owner passes

- [ ] Run one owner pass per PR with the full lifecycle the execution playbook names. Code owners run on the `pstack-feature` role with the model from `~/.omp/agent/pstack/models.md`, each in its own git worktree.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges.
  - [ ] R00, R01, R02, R14, R15, R16 are independent and first. All branch from `main`.
  - [ ] R03 after R00 and R01. R04 after R03. R05 after R04. R22 after R03.
  - [ ] R06 after R02. R17 and R18 after R06.
  - [ ] R07 after R00. R08 after R07. R09 after R00. R10 after R09. R11 after R07 and R10.
  - [ ] R12 after the operator buys the domain. R13 after R07, R10, and R12. R21 after R12.
  - [ ] R19 after R12, R13, R14, R15, and the operator's billing choice. R20 after R14.
  - [ ] R23 after R14 through R22. R24 after every other PR.
- [ ] Hold the file boundaries. R09 and R10 own every user-facing string under `tui/src`. Other PRs that add strings add them through the R09 catalog once R09 merges. R07 and R08 own `tui/src/ui/theme.rs` and `tui/src/ui/render/logo.rs`. Worker PRs touch only `src/`, `migrations/`, and `wrangler.jsonc`.
- [ ] Hold the review gate. R03, R05, R07, R10, R11, R13, R19, R23, and R24 wait for the operator's review in chat with screenshots and a video before merge.
- [ ] Number new D1 migrations at merge time. R16 plans `0005` and R19 plans `0006`. The PR that merges second renumbers if the order changes.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve the repository, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, with `gh pr create --base main`.
- [ ] Run `pnpm check`, `pnpm test`, and in `tui/` run `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, and `cargo test` once before the PR-facing push. Push with hooks on.
- [ ] Run `/unslop` over the diff before each commit and `/no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `skills/poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before babysit and again before the merge-ready report.

### Verdict and merge, for every PR

- [ ] At the merge-ready head SHA, run the swarm per `skills/swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's **Verify, live** block. The perf lane from its **Verify, perf** block. One audit lane that reads the diff and the receipts and distrusts the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner. A new head gets a fresh swarm and a fresh verdict.
- [ ] The operator squash-merges each PR after the clean verdict. Before the merge, check that `git patch-id` of the verified head equals the patch-id of the head being merged, per `skills/poteto-mode/playbooks/shipping.md`.

### Boot recipe, for every live lane

Each live lane runs at the PR head in its own git worktree. Drive the surface through the bash-driven harness, `scripts/tui-shot.py` for the TUI and CLI, and curl for the Worker.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>`.
- [ ] Build the TUI with `cargo build --release` in `tui/`. For Worker lanes, run `pnpm install` and `pnpm dev`, then wait until `curl -s localhost:5317/api/session` answers 401.
- [ ] Deliver input only through `scripts/tui-shot.py` (keys at set times, terminal size, temporary HOME) or curl. Read-only diagnostics are `nagi list --json`, `sqlite3` on the temporary `local.db`, and `wrangler d1 execute --local`.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## TUI を PTY で動かして画面を PNG に撮る道具を足す (R00)

**Depends on.** None.

**Files.**
- [ ] Create `scripts/tui-shot.py`. 先頭に `#!/usr/bin/env -S uv run --script` と、PEP 723 の依存の宣言（`pyte`、`pillow`）を置く。
- [ ] Create `scripts/test_tui_shot.py`. キーの台本の読み取り、キー名からバイト列への変換、色の変換、幅 2 の文字の描画を確かめる。
- [ ] `README.md` の `## テスト` に、`scripts/tui-shot.py` の使い方を 10 行以内で足す。

**Build.**
- [ ] 起動の形を `scripts/tui-shot.py [--bin PATH | --cmd "<shell command>"] [--size 120x36] [--keys SCRIPT] [--shot SLUG] [--out-dir DIR] [--home DIR] [--cwd DIR] [--env NAME=VALUE] [--unset NAME] [--timeout 30] [--font PATH] [-- ARGS]` にする。`--bin` の既定は `tui/target/release/nagi`。
- [ ] `--cmd "<shell command>"` を足す。`bash -c` で、nagi と同じ PTY、同じ大きさ、同じ隔離した環境でコマンドを動かす（curl、nagi の CLI、sqlite3、gh など）。終わったら最後の画面を `--shot SLUG` の名前で撮る。`--bin` と一緒には使えない。
- [ ] `--home` がなければ、`tempfile.mkdtemp()` で一時的な HOME を作る。`XDG_CONFIG_HOME` と `XDG_DATA_HOME` はその下に置く。終わったら消す。
- [ ] 子の環境から `NAGI_TOKEN` と `NAGI_SERVER` を外す。足すのは `--env` で渡したものだけ。`--unset` で HOME なども外せる。`TERM=xterm-256color`、`COLORTERM=truecolor`、`TZ=Asia/Tokyo`、`LANG=C.UTF-8` に固定する。
- [ ] `pty.fork()` で子を起動し、`TIOCSWINSZ` で `--size` の大きさにする。出力は `pyte.ByteStream` と `pyte.Screen` に流す。作業のフォルダは `--cwd`。なければ今のフォルダ。
- [ ] キーの台本は `;` 区切りの文字か、1 行 1 手順の `@PATH` のファイル。手順は 7 種。`sleep S`、`type TEXT`、`key NAME`、`shot SLUG`、`resize COLSxROWS`、`run SHELL`、`wait-exit S`。`run` は子と同じ環境で、PTY の外でコマンドを動かす。
- [ ] `key` は `Enter`、`Esc`、`Tab`、`Up`、`Down`、`ctrl+k`、`ctrl+r`、`alt+up` などを xterm のバイト列に変える。
- [ ] `shot SLUG` で `<out-dir>/<SLUG>.png` と `<out-dir>/<SLUG>.txt`（画面の文字）を書く。PNG は Pillow でセルの格子に描く。描くものは 24 ビットの色、xterm の 256 色、太字、反転、幅 2 の文字、カーソル。子が終わったあとの `shot` は、最後の画面を撮る。
- [ ] 字形は `--font` のもの。なければ `fc-match -f '%{file}' 'monospace:lang=ja'` の結果を使う。
- [ ] 終わったら `<out-dir>/run.json` を書く。中身は終了コード、実時間、`first_output_ms`（起動から最初の出力まで）、`writes_per_sec`（子の出力を読んだ回数の 1 秒ごとの数）、出力のバイト数、撮った画像の一覧、1 枚ごとの `render_ms`。
- [ ] `--timeout` を過ぎたら、子のプロセスグループを `SIGKILL` で止める。`run.json` に `timed_out: true` を書き、道具は 124 で終わる。

**You see.**
- [ ] `scripts/tui-shot.py --keys 'sleep 1; shot home; key q'` を打つと、`home.png` に nagi のローカルの最初の画面が出る。
- [ ] `scripts/tui-shot.py --cmd "tui/target/release/nagi list --json" --shot list` で、コマンドの出力が `list.png` と `list.txt` になる。Worker と CLI の lane は、これで PNG を作る。
- [ ] 運用者の `~/.local/share/nagi/local.db` には触らない。
- [ ] `run.json` で、終了コードと毎秒の書き出し回数が読める。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `uv run --with pytest pytest scripts/test_tui_shot.py` が通る。
- [ ] `key ctrl+k` が `\x0b`、`key alt+up` が `\x1b[1;3A`、`key Enter` が `\r` になる。
- [ ] 地が `#2e4670` のセルは、PNG でもその色の画素になる。
- [ ] `牛乳` の 2 文字が 4 セルを占め、次の文字が 5 セル目から始まる。
- [ ] `;` 区切りと `@PATH` のファイルで、同じ手順の列になる。
- [ ] `cd tui && cargo test` が trunk と同じ件数で通る（nagi は変えていない）。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. trunk の nagi は `/tmp/trunk/tui/target/release/nagi`、head の nagi は `tui/target/release/nagi`。画像は `/tmp/swarm-R00/worker-<n>/` に置く。
- [ ] Lane 1. Regression lane against trunk. trunk には `scripts/tui-shot.py` がない。そのことを記録する。head の道具で、trunk の nagi と head の nagi を同じ台本 `sleep 1; key n; type 牛乳を買う; key Enter; key Esc; sleep 0.5; shot add; key q` で撮る。Save `add.png`. Pass when 二つの `add.txt` が一字も違わず、どちらの `run.json` も終了コード 0 を示す.
- [ ] Lane 2. 空の HOME で head の nagi を起動し、1 秒待って撮る。Save `first-launch.png`. Pass when 画面の一番下に「ローカル」が出て、`first-launch.txt` にも「ローカル」がある.
- [ ] Lane 3. タスク `牛乳を買う` を足して撮る。Save `wide-chars.png`. Pass when PNG で 5 文字がちょうど 10 セルに収まり、隣のセルに字形がはみ出さない.
- [ ] Lane 4. タスクを一つ足し、カーソルをその行に置いて撮る。Save `cursor-row.png`. Pass when カーソルの行の地の画素が `#2e4670` で、`tui/src/ui/theme.rs` の `CURSOR_BG` と一致する.
- [ ] Lane 5. `key ?` でショートカットの一覧を開いて撮る。Save `shortcuts.png`. Pass when ポップアップの地の画素が `#181c28`（`SURFACE`）で、`shortcuts.txt` に「終了」の行がある.
- [ ] Lane 6. `--size 40x12` で起動し、`shot small; resize 100x30; sleep 0.5; shot resize; key q` で撮る。Save `resize.png`. Pass when `resize.png` が 100x30 セルの大きさで描かれ、`small.png` が 40x12 セルで、終了コードが 0.
- [ ] Lane 7. `--cmd` で、一つの PTY の中で三つのコマンドを続けて動かす。`tui/target/release/nagi add 資料を送る && tui/target/release/nagi list --json && sqlite3 "$XDG_DATA_HOME/nagi/local.db" 'SELECT COUNT(*) FROM tasks' && curl -s -o /dev/null -w '%{http_code}' https://nagi.wizard1026miya.workers.dev/api/session`。Save `cmd.png`. Pass when `cmd.txt` に `資料を送る` を含む JSON、件数の `1`、`401` が出て、`sqlite3` が開いたファイルが一時的な HOME の下にある.
- [ ] Lane 8. lane 2 から 7 の前と後で `sha256sum ~/.local/share/nagi/local.db` を `--cmd` で撮る（なければ `ls` の結果を撮る）。Save `isolation.png`. Pass when 前と後の sha256 が同じで（なければ、後もない）、`/tmp` に道具の一時的な HOME が残っていない.
- [ ] Lane 9. 何も押さずに 10 秒待つ台本 `sleep 10; shot idle; key q` を、`--bin strace -- -qq -f -e trace=write -o /tmp/swarm-R00/worker-9/strace.log tui/target/release/nagi` で動かす。Save `idle.png`. Pass when `writes_per_sec` に 10 個以上の値があり、合計が 1 以上で、`strace.log` の `write(1,` の行の数を超えない.
- [ ] Lane 10. `--cmd 'sleep 100' --timeout 2 --keys 'sleep 1; shot timeout'` で動かす。Save `timeout.png`. Pass when 道具が 124 で終わり、`run.json` に `timed_out: true` があり、`pgrep -f 'sleep 100'` が何も返さない.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 1 回の撮影で、台本の待ち時間を除いた道具の実時間と、1 枚あたりの `render_ms`。
- [ ] Probe. 台本 `sleep 1; shot home; key q` を 10 回動かす。`run.json` の実時間から 1 秒を引いた値と、`render_ms` の中央値を取る。
- [ ] Baseline. 比べる trunk の道具はない。下限として、`/usr/bin/time -f %e tui/target/release/nagi --version` の実時間を記録する。
- [ ] Rule. 待ち時間を除いた実時間の中央値が 1.5 秒以下で、`render_ms` の中央値が 300 ms 以下。超えたら直してから進む。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## CI の同時実行の枠を PR と main で分ける (R01)

**Depends on.** None.

**Files.**
- [ ] `.github/workflows/ci.yml` の `concurrency.group`。
- [ ] `.github/workflows/tui.yml` の `build` の `concurrency.group`。

**Build.**
- [ ] PR #27 の branch `ci-concurrency-per-pr` を今の main に rebase する。新しい PR は作らず、#27 をそのまま使う。
- [ ] `ci.yml` の枠を `ci-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}` にする。#27 の 3 行のコメントも残す。
- [ ] `tui.yml` の衝突は、main の側を残して解く（`x86_64-unknown-linux-musl` と `musl-tools` の step）。変えるのは枠だけで、`tui-build-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref }}-${{ matrix.target }}` にする。
- [ ] #27 の本文に、rebase で `x86_64-unknown-linux-gnu` の行を捨てたことを書き足す。
- [ ] 検証用のリポジトリを `gh repo create myksyut/nagi-ci-drill --public` で作る。R03 の brew の lane で、Release の成果物を認証なしで落とせるように public にする。secret は入れない。R03、R04、R05 の lane もこれを使う。

**You see.**
- [ ] PR を作ってすぐマージしても、main の CI が `success` で終わり、deploy が動く。
- [ ] PR に続けて push すると、止まるのはその PR の古い実行だけ。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `actionlint .github/workflows/ci.yml .github/workflows/tui.yml` が 0 件。
- [ ] `git diff origin/main -- .github/workflows/tui.yml` が `concurrency.group` の 1 行とコメントだけ。
- [ ] `cd tui && cargo test` と `pnpm test` が通る（ワークフローのほかは変えていない）。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. drill の main は `git push --force drill <sha>:main` で、trunk か PR の head にする。`gh` の出力は `scripts/tui-shot.py --size 160x50 --env GH_TOKEN="$(gh auth token)" --cmd '<gh のコマンド>' --shot <slug>` で撮る。
- [ ] Lane 1. Regression lane against trunk. drill の main を trunk にし、docs だけを変える PR を作って 5 秒後に `gh pr merge --squash` する。次に main を head にして同じことをする。再現しなければ、それぞれ 3 回まで繰り返して全部を記録する。`gh run list --repo myksyut/nagi-ci-drill --workflow ci.yml --branch main --event push --limit 10` を撮る。Save `merge-race.png`. Pass when head の回の main の CI がすべて `success` で、trunk の回に `cancelled` が 1 件以上あれば、それも記録されている.
- [ ] Lane 2. head の drill で、一つの PR に 10 秒あけて 2 回 push する。Save `pr-double-push.png`. Pass when その PR の 1 回目の実行が `cancelled` で、2 回目が `success`.
- [ ] Lane 3. 二つの PR を同時に push する。Save `two-prs.png`. Pass when 二つの PR の実行がどちらも `success` で、互いに止めていない.
- [ ] Lane 4. 二つの PR を 20 秒以内に続けて main にマージする。Save `main-back-to-back.png`. Pass when 新しいほうのマージの main の CI が `success` で、そのコミットの SHA で deploy の run が始まっている.
- [ ] Lane 5. lane 1 の head の回の deploy の run を `gh run view <run id> --repo myksyut/nagi-ci-drill --log` で撮る。Save `deploy-after-race.png`. Pass when deploy の job が `skipped` でなく、「main の最新か確かめる」の step のログで、出す候補と main の最新が同じ SHA（Cloudflare の secret が drill にないので、その後の step の失敗は判定に入れない）.
- [ ] Lane 6. `tui/` を変える PR を作り、5 秒後にマージする。Save `tui-build-race.png`. Pass when main の `tui` の build が二つの target とも `success` で、drill に `tui-v0.1.<番号>` の Release ができる.
- [ ] Lane 7. `tui/` を変える一つの PR に、10 秒あけて 2 回 push する。Save `tui-pr-double-push.png`. Pass when target ごとに、1 回目の build が `cancelled` で 2 回目が `success`.
- [ ] Lane 8. 本物のリポジトリで `gh pr checks 27 --repo myksyut/nagi` を撮る。Save `pr27-checks.png`. Pass when `check-and-test`、`tui`、`build (aarch64-apple-darwin)`、`build (x86_64-unknown-linux-musl)` がすべて `pass`.
- [ ] Lane 9. `gh pr create` の直後に、待たずに `gh pr merge --squash` を打つ。Save `merge-zero-delay.png`. Pass when main の CI が `success` で、PR の実行のどれも main の実行を止めていない.
- [ ] Lane 10. lane 1 から 9 のあと、`gh run list --repo myksyut/nagi-ci-drill --branch main --event push --status cancelled` を撮る。Save `main-cancelled.png`. Pass when 一覧にあるのが、lane 4 で古いほうを止めた 1 件と、lane 1 の trunk の回の分だけ.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. drill の main への push の CI が `success` で終わる割合と、その実行の時間の中央値。
- [ ] Probe. `gh run list --repo myksyut/nagi-ci-drill --workflow ci.yml --branch main --event push --json conclusion,createdAt,updatedAt --limit 30` を `jq` で集計する。
- [ ] Baseline. 同じ drill で trunk の `ci.yml` を使った main の実行（lane 1 の trunk の回）。時間は、本物のリポジトリの `gh run list --repo myksyut/nagi --workflow ci.yml --branch main --limit 10` の中央値も控える。
- [ ] Rule. head では、lane 4 で止めた 1 件のほかは main の実行がすべて `success`。時間の中央値は baseline の 110% 以下。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.
- [ ] Delete the branch `ci-concurrency-per-pr` after the merge. Keep `myksyut/nagi-ci-drill` for R03 to R05.

## 手元のデータの形を移す処理を入れる (R02)

**Depends on.** None.

**Files.**
- [ ] `tui/src/data/device.rs` の `FORMAT_VERSION`、`DeviceDb::open`、`DeviceDb::prepare` と、`mod tests` の `新しい版の保存形式は_開かずに断る`。
- [ ] Create `tui/src/testdata/device-v1.sql`. trunk の nagi で作った v1 の `local.db` を `sqlite3 local.db .dump` で書き出す。受信箱、今日、予定、あとで、完了、削除済みのタスクと、二つのプロジェクト（一つはアーカイブ）を入れる。
- [ ] `tui/src/main.rs` の `VERSION`（`device.rs` から `crate::VERSION` で読む）。
- [ ] `README.md` の `### ローカルとクラウド` に、形を移す前に取る控え `local.db.v<N>.bak` のことを書く。

**Build.**
- [ ] `prepare` を二つに分ける。`create_v1` は今の `version == 0` の処理。`migrate` は v1 から先へ移す。
- [ ] `type Migration = fn(&Transaction) -> rusqlite::Result<()>` と `const MIGRATIONS: &[Migration] = &[]` を置く。`MIGRATIONS[i]` は版 `i + 1` を版 `i + 2` に移す。
- [ ] `const _: () = assert!(FORMAT_VERSION == 1 + MIGRATIONS.len() as i64);` を置く。版と移す処理の数がずれたら、ビルドで止まる。
- [ ] `open` は版で三つに分ける。`FORMAT_VERSION` より大きければ断る。小さければ移す。同じならそのまま開く。今の `version != FORMAT_VERSION` の一つの枝はなくす。
- [ ] 移す前に、`VACUUM INTO '<path>.v<元の版>.bak'` で控えを取る。控えが取れなければ、移さずに断る。
- [ ] 移す処理は全部を一つの `BEGIN IMMEDIATE` の中で動かし、最後に `PRAGMA user_version` を上げる。版はトランザクションの中で読み直す（画面と CLI が同時に開いても、二重に移さない）。
- [ ] 失敗したら ROLLBACK し、控えのパスを含む文言を返す。
- [ ] `meta` に `written_by`（その nagi の `VERSION`）を書く `stamp_written_by` を足す。値が今と同じなら書かずに `false` を返す（開くたびには書き込まない）。
- [ ] 新しい版のファイルを断る文言に、`written_by` の版を入れる。例「この端末のデータは nagi 0.9.0 で作られました。nagi を 0.9.0 以降に更新してください」。`written_by` がなければ、今の文言のまま。
- [ ] `FORMAT_VERSION` は 1 のままにする。形はまだ変えない。v1 のデータが利用者の手元に入る前に、この先のどの版も v1 を開けるようにしておく。

**You see.**
- [ ] 今の利用者には何も変わらない。今の `local.db` はそのまま開く。
- [ ] 新しい nagi で作ったファイルを古い nagi で開くと、要る版の番号が出る。
- [ ] 形を変える版が出たときは、移す前の控えが `local.db` の隣に残る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `device-v1.sql` を一時的なファイルに読み込んで `DeviceDb::open` で開くと、`sync(0)` の行が fixture の未削除の行と一致する。
- [ ] テストだけで使う二つの移す処理（v1 から v3）を `migrate` に渡すと、順に動き、版が 3 になる。`.v1.bak` は v1 のまま開ける。
- [ ] 二つ目の処理が失敗すると、版は 1 のまま行も変わらず、`.v1.bak` が残る。文言には控えのパスが入る。
- [ ] 版が `FORMAT_VERSION + 1` のファイルは、開く前と後で sha256 が変わらない。文言には `written_by` の版が入る。
- [ ] 同じ nagi で二回開くと、二回目の `stamp_written_by` は `false` を返す。
- [ ] `cd tui && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. trunk の nagi は `/tmp/trunk/tui/target/release/nagi`、head の nagi は `tui/target/release/nagi`。撮るのは `scripts/tui-shot.py`、ファイルを調べるのは `--cmd` の `sqlite3` と `sha256sum`。
- [ ] Lane 1. Regression lane against trunk. `--home /tmp/swarm-R02/home-a` で、trunk の CLI で 30 件を `nagi add` する。trunk と head の画面を同じ台本 `sleep 1; key 1; shot inbox; key q` で撮る。Save `inbox.png`. Pass when 二つの `inbox.txt` が同じで、head で開いたあとも `PRAGMA user_version` が 1.
- [ ] Lane 2. `sqlite3 local.db "PRAGMA user_version = 2; INSERT OR REPLACE INTO meta VALUES ('written_by', '0.9.0');"` のあと、head を起動して撮る。Save `newer-refused.png`. Pass when 画面ではなく文言が出て、文言に `0.9.0` が入り、終了コードが 1 で、`local.db` の sha256 が前と同じ.
- [ ] Lane 3. head の CLI で `nagi add 後から足した` を打ち、trunk の画面で開く。Save `trunk-reads-head.png`. Pass when trunk の画面に `後から足した` が出る（形を変えていないので、古い nagi に戻しても開ける）.
- [ ] Lane 4. head で一回開いたあと、`--cmd` で `sqlite3 "$XDG_DATA_HOME/nagi/local.db" "SELECT value FROM meta WHERE key = 'written_by'"` を撮る。Save `written-by.png`. Pass when head の `nagi --version` と同じ版が出る.
- [ ] Lane 5. head で `nagi list --json` を二回打つ。二回目の前と後で `local.db` の sha256 を撮る。Save `no-write.png`. Pass when 二回目の前後で sha256 が同じ.
- [ ] Lane 6. 空の HOME で head を初めて起動する。Save `fresh.png`. Pass when 空の受信箱が出て、`PRAGMA user_version` が 1 で、`written_by` が head の版.
- [ ] Lane 7. `head -c 4096 /dev/urandom > local.db` のあと、head を起動する。Save `corrupt.png`. Pass when 「開けませんでした」の文言が出て終了コードが 1、`local.db.v*.bak` ができず、`local.db` の sha256 が前と同じ.
- [ ] Lane 8. head の画面を開いたまま、`run seq 20 | xargs -P 20 -I{} tui/target/release/nagi add 同時{}` を流し、`key ctrl+r` のあとに撮る。Save `concurrent.png`. Pass when 画面に `同時1` から `同時20` の 20 件が出て、`nagi.log` に `database is locked` がない.
- [ ] Lane 9. 空の HOME の `local.db` に `sqlite3 local.db < tui/src/testdata/device-v1.sql` で fixture を入れ、head で開いて受信箱を撮る。Save `fixture-inbox.png`. Pass when `nagi list --json | jq length` が fixture の未完了で未削除のタスクの数と同じで、受信箱に fixture のタイトルが出る.
- [ ] Lane 10. trunk の CLI で 10,000 件を足した `local.db` を head で開く。Save `ten-thousand.png`. Pass when `nagi list --json | jq length` が 10000 で、`run.json` の `first_output_ms` が 2000 以下.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 10,000 件の `local.db` で、`nagi list --json > /dev/null` の実時間（開く処理を含む）。
- [ ] Probe. `for i in $(seq 20); do /usr/bin/time -f %e tui/target/release/nagi list --json > /dev/null; done` の中央値を取る。
- [ ] Baseline. 同じファイルで、trunk の nagi で同じ測り方をした中央値。
- [ ] Rule. head の中央値が trunk の中央値の 105% に 5 ms を足した値以下。開くだけで `local.db` が書き換わらないこと（lane 5）。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 版の付け方と出し方を決める (R03)

**Depends on.** R00, R01.

**Files.**
- [ ] `.github/workflows/tui.yml` の `on`、`build`、`release`、`tap` と、Create する `check` の job。
- [ ] `scripts/homebrew-formula.sh` の引数と URL。
- [ ] Create `scripts/changelog-section.sh`.
- [ ] Create `CHANGELOG.md`.
- [ ] Create `.github/release.yml`.
- [ ] Create `docs/releasing.md`.
- [ ] `tui/Cargo.toml` の `version` と、`tui/Cargo.lock` の `nagi` の版。
- [ ] `tui/src/main.rs` の `VERSION`。
- [ ] `README.md` の `### 入れ方`。

**Build.**
- [ ] Stop until the operator creates the fine-grained PAT `TAP_GITHUB_TOKEN`. 権限は `myksyut/homebrew-tap` と `myksyut/homebrew-tap-drill` の Contents の読み書きだけにする。運用者は public の `myksyut/homebrew-tap-drill` を作り、PAT を `myksyut/nagi` と `myksyut/nagi-ci-drill` の secret に入れる。
- [ ] 版の正本は `tui/Cargo.toml` の `version` にする。`0.1.0` を `0.2.0` にする。tap の今の `0.1.22` より大きいので、`brew upgrade` で上がる。
- [ ] `main.rs` の `VERSION` を `env!("CARGO_PKG_VERSION")` だけにする。`NAGI_VERSION` と、`github.run_number` で付ける版を、ワークフローとコメントから消す。
- [ ] `tui.yml` の `on` を三つにする。`pull_request`（今の `paths` のまま）、`push` の `tags: ["v*.*.*"]`、`workflow_dispatch`（入力 `tag` は必須）。main への push では出さない。
- [ ] `check` の job を足す。出すときだけ動き、`tui` で `cargo fmt --check`、`cargo clippy --all-targets -- -D warnings`、`cargo test` を回す。`release` は `needs: [check, build]` にする。
- [ ] `check` の最初の step で、タグと版を比べる。`cargo pkgid --manifest-path tui/Cargo.toml` の `@` より後ろと、タグから `v` を除いたものが違えば失敗する。
- [ ] `build` は target ごとに、作ったバイナリをその runner で動かす。`nagi --version` が `nagi <版>` を出すこと。一時的な HOME で `nagi add smoke` のあと、`nagi list --json` が `smoke` を 1 件返すこと。
- [ ] `release` で `sha256sum nagi-*.tar.gz > SHA256SUMS` を作り、一緒に載せる。
- [ ] `release` で `actions/attest-build-provenance` を `subject-path: dist/*` で動かす。job の `permissions` に `id-token: write` と `attestations: write` を足す。ほかの `actions/*` と同じく、major のタグで固定する。
- [ ] 本文は二つをつなぐ。`scripts/changelog-section.sh <版> < CHANGELOG.md` の出力を `--notes-file` で渡し、`--generate-notes` で PR の一覧を後ろに足す。CHANGELOG にその版の節がなければ失敗する。
- [ ] タグに `-` があれば（`v0.3.0-rc.1` など）、`--prerelease` を付けて `--latest` を付けず、`tap` は動かさない。
- [ ] `workflow_dispatch` は、入力のタグを checkout して同じ流れを動かす。Release がもうあれば、作り直さずに `tap` へ進む（tap の更新が失敗したときのやり直しに使う）。
- [ ] `tap` は `TAP_GITHUB_TOKEN` がなければ、飛ばさずに失敗させる。書き込む先は `vars.TAP_REPOSITORY`、なければ `myksyut/homebrew-tap`。drill には `myksyut/homebrew-tap-drill` を入れる。
- [ ] `homebrew-formula.sh` の引数を `<版> <SHA256SUMS のパス>` にし、ハッシュはファイルから target の名前で引く。URL は `https://github.com/${NAGI_REPOSITORY:-myksyut/nagi}/releases/download/v${version}` にする。引けない target があれば 2 で終わる。
- [ ] `.github/release.yml` で、自動で作る一覧を label で分ける。`breaking`、`feature`、`fix`、それ以外の四つ。`dependencies` の label は一覧から外す。
- [ ] `CHANGELOG.md` は Keep a Changelog の形にする。`## [Unreleased]` と `## [0.2.0]` を置き、0.2.0 には「版を semver のタグで付けるようにした」と「SHA256SUMS と provenance を載せるようにした」を書く。
- [ ] `docs/releasing.md` に出し方を書く。CHANGELOG と `Cargo.toml` を直す PR、マージ、`git tag v0.2.0 && git push origin v0.2.0`。失敗したら `gh workflow run tui.yml -f tag=v0.2.0`。取り消すときは `gh release delete v0.2.0 --cleanup-tag` と、tap のコミットの revert。
- [ ] `README.md` の `### 入れ方` から、`tui-v0.1.<番号>` の話と、`TAP_GITHUB_TOKEN` がないときに手で更新する話を消す。代わりに `v<版>` のタグ、`sha256sum -c SHA256SUMS --ignore-missing`、`gh attestation verify` を書く。
- [ ] 前の `tui-v0.1.*` の Release は消さずに残す。

**You see.**
- [ ] main にマージしても Release は出ない。出るのは `v` のタグを push したときだけ。
- [ ] Release の本文に、CHANGELOG の節と、入った PR の一覧が出る。
- [ ] Release に `SHA256SUMS` と provenance があり、`gh attestation verify` で確かめられる。
- [ ] Homebrew の tap が、手で触らなくても新しい版になる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `actionlint .github/workflows/tui.yml` が 0 件。
- [ ] `scripts/changelog-section.sh 0.2.0 < CHANGELOG.md` は 0.2.0 の節だけを出す。`scripts/changelog-section.sh 9.9.9 < CHANGELOG.md` は 1 で終わる。
- [ ] 二つの target を書いた `SHA256SUMS` で、`scripts/homebrew-formula.sh 0.2.0 SHA256SUMS | ruby -c` が `Syntax OK` を出す。一行を消すと 2 で終わる。
- [ ] `cd tui && cargo test` が通り、`cargo run --release -- --version` が `nagi 0.2.0` を出す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. drill の main を `git push --force drill <sha>:main` で PR の head にし、drill の `vars.TAP_REPOSITORY` を `myksyut/homebrew-tap-drill` にする。`gh` の出力は `scripts/tui-shot.py --size 160x50 --env GH_TOKEN="$(gh auth token)" --cmd '<gh のコマンド>' --shot <slug>` で撮る。
- [ ] Lane 1. Regression lane against trunk. drill の main を trunk にして、`tui/` を変えるコミットを push する。次に main を head にして、同じ変更のコミットを push する。`gh release list --repo myksyut/nagi-ci-drill` を撮る。Save `main-push-no-release.png`. Pass when trunk の回では `tui-v0.1.<番号>` の Release が一つ増え、head の回では増えない.
- [ ] Lane 2. `Cargo.toml` が `0.2.0` の head で、`git tag v0.2.0 && git push drill v0.2.0` を打つ。`gh release view v0.2.0 --repo myksyut/nagi-ci-drill` を撮る。Save `release-v0.2.0.png`. Pass when 二つの `tar.gz` と `SHA256SUMS` があり、本文が CHANGELOG の 0.2.0 の節で始まって PR の一覧が続き、latest になっている.
- [ ] Lane 3. 同じコミットに `v0.2.1` のタグを付けて push する（`Cargo.toml` は `0.2.0` のまま）。Save `version-mismatch.png`. Pass when `check` の版を比べる step が失敗し、`v0.2.1` の Release ができない.
- [ ] Lane 4. drill だけのコミットで、テストを一つ `assert!(false)` にして落とす。版を `0.2.2` にし、CHANGELOG に節を足し、`v0.2.2` を push する。Save `test-blocks-release.png`. Pass when `check` が失敗し、`release` と `tap` が `skipped` で、`v0.2.2` の Release ができない.
- [ ] Lane 5. lane 2 の run で、target ごとの smoke の step のログを撮る。Save `smoke-logs.png`. Pass when 二つの target のログに `nagi 0.2.0` が出て、`nagi list --json` の出力に `smoke` がある.
- [ ] Lane 6. `gh release download v0.2.0 --repo myksyut/nagi-ci-drill` のあと、`sha256sum -c SHA256SUMS` を撮る。Save `checksums.png`. Pass when すべての行が `OK`.
- [ ] Lane 7. 二つの `tar.gz` に `gh attestation verify <file> --repo myksyut/nagi-ci-drill` を打つ。Save `provenance.png`. Pass when 二つとも通り、作ったワークフローが `tui.yml` で、`refs/tags/v0.2.0` を指している.
- [ ] Lane 8. `myksyut/homebrew-tap-drill` の `git log -1` と `Formula/nagi.rb` を撮る。そのあと `docker run --rm homebrew/brew sh -c 'brew install myksyut/tap-drill/nagi && nagi --version'` を撮る。Save `tap-drill.png`. Pass when tap に `nagi 0.2.0` のコミットがあり、formula の sha256 が `SHA256SUMS` と同じで、`nagi --version` が `nagi 0.2.0` を出す.
- [ ] Lane 9. 版と CHANGELOG を `0.3.0-rc.1` にしたコミットで、`v0.3.0-rc.1` を push する。Save `prerelease.png`. Pass when Release が `Pre-release` で、latest は `v0.2.0` のまま、`tap` の job は `skipped`、tap-drill に新しいコミットがない.
- [ ] Lane 10. drill の secret `TAP_GITHUB_TOKEN` を消し、版と節を足したコミットで `v0.2.3` を出す。secret を戻して `gh workflow run tui.yml --repo myksyut/nagi-ci-drill -f tag=v0.2.3` を打つ。Save `tap-retry.png`. Pass when 一回目の `tap` が `failure` で、やり直しの run は Release を作り直さずに `tap` を `success` で終え、tap-drill に `nagi 0.2.3` のコミットができる.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. タグを push してから、tap に formula のコミットが入るまでの実時間。
- [ ] Probe. lane 2 の run を `gh run view <run id> --repo myksyut/nagi-ci-drill --json createdAt,updatedAt` で見て、tap-drill の `git log -1 --format=%cI` と比べる。
- [ ] Baseline. 本物のリポジトリの trunk で、main への push から Release ができるまでの時間。`gh run list --repo myksyut/nagi --workflow tui.yml --branch main --limit 5 --json createdAt,updatedAt` の中央値。
- [ ] Rule. head の実時間が baseline に 6 分を足した値以下。`check` は `build` と並んで動き、直列にならない。

**Review gate.**
- [ ] Copy the lane 2 screenshot into `docs/review/R03-review-release.png`.
- [ ] Record a 30 to 60 second video of the tag push, the drill release page, and the `brew install` in the container. Save it as `docs/review/R03-review.mp4`.
- [ ] Post the screenshot and the video in chat for the operator. Stop at merge-ready.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.
- [ ] Delete the drill releases and tags from lanes 2 to 10 with `gh release delete <tag> --repo myksyut/nagi-ci-drill --cleanup-tag`.

## Intel の Mac と arm64 の Linux 向けを作る (R04)

**Depends on.** R03.

**Files.**
- [ ] `.github/workflows/tui.yml` の `build` の matrix と smoke と、Create する `verify` の job。
- [ ] `scripts/homebrew-formula.sh` の `on_macos` と `on_linux`。
- [ ] Create `.github/workflows/tui-shots.yml`.
- [ ] `README.md` の `### 入れ方` と、`docs/releasing.md` の target の一覧。

**Build.**
- [ ] matrix に二つを足す。`os: macos-15-intel` で `target: x86_64-apple-darwin`。`os: ubuntu-24.04-arm` で `target: aarch64-unknown-linux-musl`。どちらも GitHub が用意する runner で、運用者の機械は使わない。
- [ ] 今の二つの runner も固定する。`macos-latest` は `macos-15`、`ubuntu-latest` は `ubuntu-24.04` にする（image が黙って変わらないように）。
- [ ] `musl-tools` の step は、`runner.os == 'Linux'` のままで arm でも動く。arm の `musl-gcc` で SQLite が組めることは、その runner の build で確かめる。
- [ ] R03 の smoke の step に、`file nagi` の確かめを足す。Intel の Mac は `Mach-O 64-bit executable x86_64` を含むこと。arm の Linux は `ARM aarch64` と `statically linked` を含むこと。
- [ ] `homebrew-formula.sh` に、`on_macos` の中の `on_intel` と、`on_linux` の中の `on_arm` を足す。ハッシュは R03 と同じく `SHA256SUMS` から引く。
- [ ] `verify` の job を足す。`tap` のあとに、四つの runner で Release から自分の target を落とす。`sha256sum -c SHA256SUMS --ignore-missing`（Mac は `shasum -a 256 -c`）、`gh attestation verify`、`nagi --version` を動かす。`macos-15`、`macos-15-intel`、`ubuntu-24.04` では `brew install` でも入れる。`ubuntu-24.04-arm` では Homebrew を使わず、落としたものを動かすだけにする。
- [ ] `tui-shots.yml` を作る。`workflow_dispatch` の入力は `runner`、`ref`、`keys`、`cmd`、`size`。その ref で nagi を組み、`cmd` があれば `scripts/tui-shot.py --cmd`、なければ `--keys` で撮る。撮ったものは artifact `shots-<runner>` に載せる。Linux では `fonts-noto-cjk` を入れる。
- [ ] `README.md` の入れ方に、Intel の Mac と arm64 の Linux を足す。

**You see.**
- [ ] Release に `nagi-x86_64-apple-darwin.tar.gz` と `nagi-aarch64-unknown-linux-musl.tar.gz` が増える。
- [ ] Intel の Mac でも `brew install myksyut/tap/nagi` で入る。
- [ ] arm64 の Linux では、落として展開した `nagi` がそのまま動く。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `actionlint .github/workflows/tui.yml .github/workflows/tui-shots.yml` が 0 件。
- [ ] 四つの target を書いた `SHA256SUMS` で、`scripts/homebrew-formula.sh 0.2.1 SHA256SUMS | ruby -c` が `Syntax OK` を出し、出力に `url` が四つある。
- [ ] target を一つ消した `SHA256SUMS` では 2 で終わる。
- [ ] `cd tui && cargo test` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. drill の main を PR の head にして、版と CHANGELOG を `0.2.1` にしたコミットで `v0.2.1` を出す。runner の上の撮影は `gh workflow run tui-shots.yml --repo myksyut/nagi-ci-drill` で動かし、`gh run download` で `/tmp/swarm-R04/worker-<n>/` に落とす。
- [ ] Lane 1. Regression lane against trunk. trunk の formula には、Intel の Mac の `url` がない。`tui-shots.yml` を `runner=macos-15-intel` と `cmd='brew install myksyut/tap/nagi'` で動かす（本物の tap、trunk の版）。次に `cmd='brew install myksyut/tap-drill/nagi && nagi --version'` で動かす。Save `intel-brew.png`. Pass when 一回目は Homebrew のエラーで入らず、二回目は `nagi 0.2.1` が出る.
- [ ] Lane 2. `v0.2.1` の run の `build (x86_64-apple-darwin)` の smoke のログを撮る。Save `intel-smoke.png`. Pass when `file` の行に `x86_64` があり、`nagi 0.2.1` と `smoke` が出る.
- [ ] Lane 3. `build (aarch64-unknown-linux-musl)` の smoke のログを撮る。Save `arm-smoke.png`. Pass when `ARM aarch64` と `statically linked` があり、`nagi 0.2.1` と `smoke` が出る.
- [ ] Lane 4. `tui-shots.yml` を `runner=macos-15-intel` と `keys='sleep 1; key n; type 牛乳を買う; key Enter; key Esc; sleep 0.5; shot intel-add; key q'` で動かす。Save `intel-add.png`. Pass when 受信箱に `牛乳を買う` が出て、`run.json` の終了コードが 0.
- [ ] Lane 5. 同じ台本を `runner=ubuntu-24.04-arm` で動かす（shot の名前は `arm-add`）。Save `arm-add.png`. Pass when 受信箱に `牛乳を買う` が出て、`arm-add.txt` が lane 4 の `intel-add.txt` と同じ.
- [ ] Lane 6. `v0.2.1` の run の `verify` の四つの job を撮る。Save `verify-matrix.png`. Pass when 四つの runner すべてで、checksum、attestation、`nagi --version` の step が `success`.
- [ ] Lane 7. `tui-shots.yml` を `runner=ubuntu-24.04-arm` と `cmd='gh release download v0.2.1 --repo myksyut/nagi-ci-drill -p nagi-aarch64-unknown-linux-musl.tar.gz && tar xzf nagi-*.tar.gz && docker run --rm -v "$PWD":/w alpine:3 /w/nagi --version'` で動かす。Save `arm-alpine.png`. Pass when glibc のない Alpine で `nagi 0.2.1` が出る.
- [ ] Lane 8. `docker run --rm homebrew/brew` の中で tap-drill を 0.2.0 のコミットに戻して `brew install myksyut/tap-drill/nagi` を打ち、0.2.1 のコミットに進めて `brew upgrade nagi` を打つ。Save `x64-upgrade.png`. Pass when `nagi --version` が `nagi 0.2.0` から `nagi 0.2.1` に変わる.
- [ ] Lane 9. lane 4 の台本を `runner=macos-15` で、trunk の ref と head の ref の二回動かす。Save `apple-silicon-add.png`. Pass when 二つの `.txt` が同じ（Apple シリコンの扱いは変わらない）.
- [ ] Lane 10. drill だけのコミットで、`tui/src/main.rs` に `#[cfg(target_arch = "aarch64")] compile_error!("drill");` を足し、版と節を足して `v0.2.9` を出す。Save `one-target-fails.png`. Pass when `build (aarch64-unknown-linux-musl)` と `build (aarch64-apple-darwin)` が失敗し、`release` と `tap` が `skipped` で、`v0.2.9` の Release ができない.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. タグを push してから `verify` が終わるまでの実時間と、四つの `tar.gz` の大きさ。
- [ ] Probe. `gh run view <run id> --repo myksyut/nagi-ci-drill --json createdAt,updatedAt` と、`gh release view v0.2.1 --repo myksyut/nagi-ci-drill --json assets --jq '.assets[] | [.name, .size]'`。
- [ ] Baseline. R03 の lane 2 の run（target は二つ）の実時間と、`v0.2.0` の二つの `tar.gz` の大きさ。
- [ ] Rule. 実時間が baseline に 10 分を足した値以下。新しい `tar.gz` の大きさが、同じ OS の今の target の ±25% 以内。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## Windows に対応する (R05)

**Depends on.** R04.

**Files.**
- [ ] `tui/src/config.rs` の `home`、`base_dir`、`Config::new` と、`#[cfg(not(unix))]` の `write_private`。
- [ ] `tui/src/ui/clipboard.rs` の `write_clipboard` の説明。
- [ ] `.github/workflows/tui.yml` の matrix、smoke、`release`、`verify` と、Create する `scoop` の job。
- [ ] `.github/workflows/ci.yml` の `tui` の job の matrix。
- [ ] `.github/workflows/tui-shots.yml` の `runner` の選択肢。
- [ ] `scripts/tui-shot.py` の ConPTY の経路。
- [ ] Create `scripts/scoop-manifest.sh`.
- [ ] `README.md` の `### 入れ方` と、`docs/releasing.md`。

**Build.**
- [ ] Stop until the operator creates the public repositories `myksyut/scoop-bucket` and `myksyut/scoop-bucket-drill` and adds both to the `TAP_GITHUB_TOKEN` PAT with Contents read and write.
- [ ] 配り方は zip の成果物と scoop の bucket にする。winget は、版ごとに `microsoft/winget-pkgs` への PR と審査を待つので、この PR では入れない。scoop なら tap と同じ PAT で自動で更新できる。
- [ ] matrix に二つを足す。`os: windows-2025` で `target: x86_64-pc-windows-msvc`。`os: windows-11-arm` で `target: aarch64-pc-windows-msvc`。
- [ ] `aarch64-pc-windows-msvc` で `ring` を組むには clang が要る。`windows-11-arm` の image の LLVM を PATH に置く step を足し、ログに `clang --version` を出す。
- [ ] Windows の成果物は、`nagi.exe` を入れた `nagi-<target>.zip`。PowerShell の `Compress-Archive` で作る。`SHA256SUMS` に zip も入れる。
- [ ] Windows の smoke は `pwsh` で動かす。`nagi.exe --version` と、一時的な `APPDATA` と `LOCALAPPDATA` での `nagi.exe add smoke` と `nagi.exe list --json`。
- [ ] 置き場の決め方を、環境変数を引く関数を受け取る `resolve_dirs` にする。テストから環境を書き換えずに確かめるため。R06 が先に入っていれば、R06 の `resolve_dirs` に Windows の枝を足す。
- [ ] Windows では、`XDG_CONFIG_HOME` がなければ `%APPDATA%\nagi`、`XDG_DATA_HOME` がなければ `%LOCALAPPDATA%\nagi` に置く。どちらの変数もなければ、`.` に落とさずに理由の文言で止める。
- [ ] Windows の `write_private` は `fs::write` のまま。`%APPDATA%` の下のファイルは、継承する ACL で本人と SYSTEM と Administrators しか読めない。そのことを関数の説明に書き、lane 6 で `icacls` を撮って確かめる。
- [ ] `clipboard.rs` は OSC 52 のまま。Windows Terminal は OSC 52 に応じ、古い conhost は応じない。Microsoft の文書で確かめてから、`write_clipboard` の説明と README に書く。
- [ ] Windows ではキーを離したときにもイベントが届く。`input.rs` の `handle_key` はもう `KeyEventKind::Release` を捨てている（`input.rs` の 90 行目）。1 回押せば 1 回だけ動くことを lane 8 で確かめる。
- [ ] `scripts/tui-shot.py` に、`os.name == "nt"` のときの経路を足す。PTY の代わりに `pywinpty` の `PtyProcess` を使い、PEP 723 の依存に `pywinpty; sys_platform == 'win32'` を足す。隔離は、一時的な `APPDATA`、`LOCALAPPDATA`、`USERPROFILE` を渡し、`HOME` と `XDG_*` を外して行う。`--cmd` と `run` は `pwsh -NoProfile -Command` で動かす。字形の既定は `C:\Windows\Fonts\msgothic.ttc`。
- [ ] `scripts/scoop-manifest.sh <版> <SHA256SUMS のパス>` を作る。`bucket/nagi.json` に `version`、`architecture` の `64bit` と `arm64` の `url` と `hash`、`bin` の `nagi.exe`、`checkver`、`autoupdate` を書く。
- [ ] `scoop` の job を足す。prerelease でなければ、`vars.SCOOP_REPOSITORY`（なければ `myksyut/scoop-bucket`）に `bucket/nagi.json` を push する。PAT がなければ失敗させる。
- [ ] `verify` に `windows-2025` と `windows-11-arm` を足す。zip を落として `Get-FileHash` で `SHA256SUMS` と比べ、`gh attestation verify` と `nagi.exe --version` を動かす。`windows-2025` では `scoop install` でも入れる。
- [ ] `ci.yml` の `tui` を `ubuntu-latest` と `windows-2025` の matrix にし、`cargo test` を Windows でも回す。
- [ ] `tui-shots.yml` の `runner` に `windows-2025` と `windows-11-arm` を足す。
- [ ] README に Windows のことを書く。Windows Terminal で使うこと、署名していないので SmartScreen の警告が出ること、`scoop bucket add nagi https://github.com/myksyut/scoop-bucket` と `scoop install nagi/nagi`、置き場 `%LOCALAPPDATA%\nagi\local.db`。

**You see.**
- [ ] Windows の x64 と arm64 で、`scoop install nagi/nagi` のあと、Windows Terminal で `nagi` が開く。
- [ ] データは `%LOCALAPPDATA%\nagi\local.db`、ログインは `%APPDATA%\nagi` に置かれる。今いるフォルダには何も作らない。
- [ ] Release に二つの zip が増える。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `resolve_dirs` のテストを足す。`APPDATA` と `LOCALAPPDATA` を渡したときの `device_db_path` と `session_path`、両方がないときの文言、unix の今の結果が変わらないこと。
- [ ] `windows-2025` の `ci.yml` の `tui` で `cargo test` が通る。
- [ ] `scripts/scoop-manifest.sh 0.2.2 SHA256SUMS | jq .` が通り、`architecture.64bit.hash` が `SHA256SUMS` の値と同じ。
- [ ] `actionlint .github/workflows/*.yml` が 0 件。
- [ ] Linux で `uv run --with pytest pytest scripts/test_tui_shot.py` が通る（ConPTY の経路は lane で確かめる）。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. drill の main を PR の head にし、`vars.SCOOP_REPOSITORY` を `myksyut/scoop-bucket-drill` にして `v0.2.2` を出す。runner の上の撮影は `gh workflow run tui-shots.yml --repo myksyut/nagi-ci-drill` で動かし、`gh run download` で `/tmp/swarm-R05/worker-<n>/` に落とす。
- [ ] Lane 1. Regression lane against trunk. trunk には Windows の成果物がない。そのことを記録する。`runner=windows-2025` で、trunk の ref と head の ref の両方に `keys='sleep 2; key n; type a; key Enter; key q'` と、作業のフォルダと `$env:LOCALAPPDATA` を並べる `cmd` を動かす。Save `win-data-place.png`. Pass when trunk の回は作業のフォルダに `.local` ができ、head の回は `%LOCALAPPDATA%\nagi\local.db` だけができて、作業のフォルダは空のまま.
- [ ] Lane 2. `runner=windows-2025` で初めて起動し、2 秒後に撮る。Save `win-first.png`. Pass when 一番下に「ローカル」が出て、`win-first.txt` が R04 の Linux の最初の画面と同じ.
- [ ] Lane 3. `runner=windows-2025` で R04 の lane 4 の台本を動かす（shot の名前は `win-add`）。Save `win-add.png`. Pass when 受信箱に `牛乳を買う` が出て、`win-add.txt` が R04 の `arm-add.txt` と同じ.
- [ ] Lane 4. `runner=windows-2025` と `cmd='nagi.exe add 資料を送る; nagi.exe list --json | ConvertFrom-Json | Select-Object title'` で動かす。Save `win-cli.png`. Pass when `ConvertFrom-Json` が通り、タイトルが `資料を送る` のまま出る.
- [ ] Lane 5. lane 3 の台本を `runner=windows-11-arm` で動かす（shot の名前は `win-arm-add`）。Save `win-arm-add.png`. Pass when `win-arm-add.txt` が lane 3 の `win-add.txt` と同じ.
- [ ] Lane 6. 一回起動したあと、`cmd='icacls "$env:APPDATA\nagi"; icacls "$env:LOCALAPPDATA\nagi\local.db"'` を撮る。Save `win-acl.png`. Pass when `Everyone` と `BUILTIN\Users` の行がない.
- [ ] Lane 7. `runner=windows-2025` と `cmd='scoop bucket add nagi https://github.com/myksyut/scoop-bucket-drill; scoop install nagi/nagi; nagi --version'` で動かす。Save `win-scoop.png`. Pass when `nagi 0.2.2` が出る.
- [ ] Lane 8. 三件を足したあと、`key Up; key Up; key Down` を送って撮る。Save `win-key-once.png`. Pass when カーソルが 2 行目にあり、1 行目や 3 行目にない（離したときのイベントで二度動いていない）.
- [ ] Lane 9. `--size 120x36` で起動し、`resize 80x24` のあとに撮る。Save `win-resize.png`. Pass when 80x24 の画像になり、`win-resize.txt` が Linux の同じ大きさの `.txt` と同じ.
- [ ] Lane 10. `runner=windows-2025` で、`cmd` が `.dev.vars.example` を `.dev.vars` に写し、`pnpm db:migrate:local` と `Start-Process pnpm dev` を動かす。そのあと `--env NAGI_SERVER=http://localhost:5317` で nagi を起動し、`同期の確認` を足して撮る。最後に `curl.exe -s -X POST http://localhost:5317/api/sync -H 'Content-Type: application/json' -H 'X-Api-Version: 3' -d '{"cursor":0,"baseCursor":0}'` を撮る。Save `win-cloud.png`. Pass when 画面の一番下に「オフライン」が出ず、`/api/sync` の応答に `同期の確認` が入る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 起動から最初の出力までの `first_output_ms` と、何もしない 10 秒の `writes_per_sec` の平均。
- [ ] Probe. `tui-shots.yml` で `keys='sleep 10; shot idle; key q'` を、`windows-2025` と `ubuntu-24.04` でそれぞれ 5 回動かす。
- [ ] Baseline. `ubuntu-24.04` の 5 回の中央値。
- [ ] Rule. Windows の `first_output_ms` の中央値が Linux の 3 倍以下で、かつ 1500 ms 以下。`writes_per_sec` の平均は Linux に 1 を足した値以下。

**Review gate.**
- [ ] Copy the lane 3 and lane 7 screenshots into `docs/review/R05-review-windows.png`, side by side.
- [ ] Record a 30 to 60 second video. On `windows-2025`, take a shot every 0.5 seconds while running the lane 3 script, then join the shots with `ffmpeg -framerate 2`. Save it as `docs/review/R05-review.mp4`.
- [ ] Post the screenshot and the video in chat for the operator. Stop at merge-ready.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 手元のデータを書き出せるようにし、置き場所とログを安全にする (R06)

**Depends on.** R02.

**Files.**
- [ ] `tui/src/cli.rs` の `Command`、`HELP`、`parse`、`run` と、Create する `ExportArgs`。
- [ ] `tui/src/data/device.rs` と、そこに Create する `DeviceDb::export`。
- [ ] `tui/src/config.rs` の `home`、`base_dir`、`Config::new`、`save_prefs` と、Create する `resolve_dirs` と `Config::prepare_dirs`。
- [ ] `tui/src/main.rs` の `Command::Help` と、`Config::new` を呼ぶ二か所。
- [ ] `tui/src/log.rs` の `init`。
- [ ] `tui/src/data/store.rs` の 438 行目と 553 行目の `log::error`。
- [ ] `tui/src/model.rs` と、そこに Create する `Mutation::summary`。
- [ ] `README.md` の `### ローカルとクラウド` と `### ログインと同期`。

**Build.**
- [ ] `nagi export [--out <ファイル>]` を足す。ログインしているかどうかにかかわらず、この端末のデータ（`local.db`）を書き出す。ログイン中は、そのことを stderr に一行出す。
- [ ] 形は一つの JSON の値。`format` は `"nagi-export"`、`formatVersion` は 1。ほかに `exportedAt`、`app`（`nagi <版>`）、`projects`、`tasks`。行は、`tasks` と `projects` の表の `json` の列のまま、`seq` の順に並べる。削除済み（`deleted_at` がある行）は入れない。完了したタスクとアーカイブしたプロジェクトは入れる。
- [ ] `DeviceDb::export` は、一つの読み取りのトランザクションで両方の表を読む（画面と CLI が書いていても、表のあいだでずれない）。
- [ ] `--out` は、同じフォルダの一時ファイルに 0600 で書いてから `rename` で置き換える。stdout に出すときは `cli::emit` を使う。
- [ ] `local.db` がまだなければ、作らずに「書き出すデータがありません」を出して 1 で終わる。
- [ ] 置き場の決め方を、環境変数を引く関数を受け取る `resolve_dirs` にする。`HOME` がなければ `.` に落とさず `Err` を返す。`Config::new` は `Result<Config, String>` を返し、`main.rs` は文言を出して 1 で終わる。
- [ ] `Config::new` からフォルダを作る処理を外し、`Config::prepare_dirs` に移す。unix ではフォルダを 0700 で作る。`Command::Help` はフォルダを作らない。
- [ ] `local.db` がなければ、0600 の空のファイルを置いてから `Connection::open` する。`save_prefs` も `write_private` で書く。
- [ ] `nagi --help` の最後に、データ、ログイン、記録の置き場を、今の環境で解いたパスで出す。
- [ ] `log::init` は 0600 で開く。開く前に 1 MiB を超えていれば、`nagi.log.1` に名前を変える（世代は一つだけ）。
- [ ] `store.rs` の 438 行目と 553 行目は、操作の中身ではなく `Mutation::summary`（操作の種類と行の ID）だけを書く。タイトル、メモ、チェックリストの文字は書かない。
- [ ] `README.md` に、`nagi export`、置き場の権限、記録の世代を書く。「控えを取るなら、`local.db` を写せばよい」は `nagi export` に置き換える。

**You see.**
- [ ] `nagi export > nagi.json` で、すべてのタスクとプロジェクトが一つの JSON になる。
- [ ] `nagi --help` に、データの置き場が出る。
- [ ] `HOME` がない環境で、今いるフォルダに `.local` ができない。
- [ ] `nagi.log` にタスクの文字が残らず、1 MiB を超えて育たない。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cli.rs` のテストに、`export` と `export --out x.json` の読み取りを足す。
- [ ] `DeviceDb::export` は、未完了、完了、アーカイブしたプロジェクト、削除済みの行が入った DB から、削除済みだけを除いた行を `seq` の順に返す。
- [ ] 改行、全角の空白、絵文字を含むメモが、JSON を読み戻すと同じ文字になる。
- [ ] `Mutation::summary` の出力に、タイトルとメモの文字が入らない。
- [ ] 1 MiB を超えた `nagi.log` を `nagi.log.1` にし、前の `nagi.log.1` を上書きする。
- [ ] `HOME` のない環境を渡した `resolve_dirs` が `Err` を返す。
- [ ] `cd tui && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe. trunk の nagi は `/tmp/trunk/tui/target/release/nagi`、head の nagi は `tui/target/release/nagi`。CLI とファイルの確かめは `scripts/tui-shot.py --cmd` で撮る。
- [ ] Lane 1. Regression lane against trunk. trunk には `nagi export` がない。trunk と head で `--cmd '<nagi> export; echo exit=$?'` を撮る。Save `export-cmd.png`. Pass when trunk は使い方の誤りの文言を出して `exit=2`、head は `"format": "nagi-export"` を含む JSON を出して `exit=0`.
- [ ] Lane 2. 空の HOME の `local.db` に `tui/src/testdata/device-v1.sql` を入れて `nagi export > out.json` を打つ。`jq '.projects|length, .tasks|length' out.json` と、`sqlite3` で数えた未削除の行の数を撮る。Save `export-counts.png`. Pass when 二つの数が、`sqlite3` の `deleted_at IS NULL` の行の数と同じ.
- [ ] Lane 3. `nagi export --out out.json` を二回打つ。二回目の前に `out.json` へ `old` と書いておく。`stat -c '%a' out.json` と `head -c 20 out.json` を撮る。Save `export-out.png`. Pass when 権限が `600` で、中身が `{` で始まり `old` が残っていない.
- [ ] Lane 4. head の画面でタスクを一件ずつ足しながら、あいだに `run tui/target/release/nagi export --out /tmp/swarm-R06/worker-4/mid.json` を流す。Save `export-during-tui.png`. Pass when `mid.json` が `jq` で読め、件数が、その前と後の `nagi list --json` の件数のあいだにある.
- [ ] Lane 5. `--unset HOME --unset XDG_DATA_HOME --unset XDG_CONFIG_HOME --cwd /tmp/swarm-R06/worker-5/cwd` で、trunk と head の `nagi list` を撮る。そのあと `find /tmp/swarm-R06/worker-5/cwd` も撮る。Save `no-home.png`. Pass when trunk の回は作業のフォルダに `.local/share/nagi/local.db` ができ、head の回は文言を出して 1 で終わり、作業のフォルダが空のまま.
- [ ] Lane 6. 空の HOME で head の画面を開き、一件足して終える。`stat -c '%a %n'` でフォルダとファイルを撮る。trunk でも同じことをする。Save `perms.png`. Pass when head では二つの `nagi` のフォルダが `700`、`local.db` と `nagi.log` が `600` で、trunk では `755` と `644` だったことも記録されている.
- [ ] Lane 7. `--env XDG_DATA_HOME=/tmp/swarm-R06/worker-7/data -- --help` で撮り、そのあと `ls /tmp/swarm-R06/worker-7/data` を撮る。Save `help-paths.png`. Pass when 最後の行に `/tmp/swarm-R06/worker-7/data/nagi/local.db` と `nagi.log` のパスが出て、`ls` がそのフォルダはないと答える.
- [ ] Lane 8. head の画面で `SECRET-TITLE-7` を足す。`run sqlite3 "$XDG_DATA_HOME/nagi/local.db" 'DELETE FROM tasks'` のあと `key x` を送り、`nagi.log` を撮る。trunk でも同じことをする。Save `log-redaction.png`. Pass when head の `nagi.log` に `task_not_found` の行があり、`grep -c SECRET-TITLE-7` が 0 で、trunk の `nagi.log` では 1 以上.
- [ ] Lane 9. `head -c 1100000 /dev/zero | tr '\0' a > nagi.log` で記録を大きくしてから、head を二回起動する。`ls -l` で `nagi.log*` を撮る。Save `log-rotate.png`. Pass when `nagi.log.1` が 1100000 バイトで、`nagi.log` が 1 KiB 未満で、`nagi.log.2` がない.
- [ ] Lane 10. 改行、全角の空白、絵文字を含む `memo.txt` を作り、`nagi add 議事録 --memo-file memo.txt` を打つ。`nagi export | jq '.tasks[0].memo'` と `nagi show <ID> --json | jq '.memo'` を撮る。Save `memo-roundtrip.png`. Pass when 二つの出力が一字も違わない.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 10,000 件の `local.db` での、`nagi export > /dev/null` の実時間と最大の常駐メモリ。
- [ ] Probe. `/usr/bin/time -f '%e %M' tui/target/release/nagi export > /dev/null` を 10 回打ち、中央値を取る。
- [ ] Baseline. 同じファイルで trunk の `nagi list --json > /dev/null` を同じ測り方で測る（今いちばん近い、全件を読む道）。
- [ ] Rule. export の実時間とメモリの中央値が、どちらも baseline の 1.5 倍以下。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## ロゴとアプリの配色を一つにする (R07)

**Depends on.** R00.

**Files.**
- [ ] `tui/src/ui/theme.rs` を変える。ブランドの色を `BRAND_SUN_TOP`、`BRAND_SUN_BOTTOM`、`BRAND_HORIZON`、`BRAND_WATER_TOP`、`BRAND_WATER_BOTTOM`、`BRAND_GROUND` の定数で持つ。`ACCENT`、`IN_PROGRESS`、`SELECTED_BG`、`CURSOR_BG`、`SURFACE`、`BORDER` を選んだ案の値にする。テストを 3 つ足す。
- [ ] `tui/src/ui/render/logo.rs` を変える。`SUN_TOP`、`SUN_BOTTOM`、`HORIZON`、`WATER_TOP`、`WATER_BOTTOM`、`TERMINAL_RGB` を消し、`theme::BRAND_*` を読む。
- [ ] `assets/logo-dark.svg`、`assets/logo-light.svg`、`assets/icon.svg` を変える。`sun`、`dot`、`water`、`horizon` のグラデーションの `stop-color` を選んだ案にする。字の線（`#EEF0F5`、`#16203A`）とアイコンの地（`#0D1424`）も案に合わせる。形と座標は変えない。
- [ ] Create `docs/brand.md`。
- [ ] `README.md` の 10 行目（ロゴの説明の文）を新しい配色に合わせる。
- [ ] Create `docs/review/R07-palettes.png`、`docs/review/R07-palettes.mp4`、`docs/review/R07-review-palette.png`、`docs/review/R07-review.mp4`。

**Build.**
- [ ] Stop until the operator picks palette A, B, or C. 選ぶ前に、次の使い捨ての試作を作って見せる。
  - [ ] 試作の枝 `proto/R07-palette` を切る。main には入れない。`theme.rs` と `logo.rs` の定数だけを変えた commit を案ごとに 1 つ作る。それぞれ `cd tui && cargo build --release` し、`/tmp/swarm-R07/proto/nagi-a`、`nagi-b`、`nagi-c` に写す。
  - [ ] 案 A は夕焼けに寄せる。ロゴは今のまま。アプリの `ACCENT` と `IN_PROGRESS` を `#FF8A5C`、`ATTENTION` を `#FFD47A`、`DANGER` を `#FF5C7A` にする。地の 3 色を赤みの暗い色にする（`SELECTED_BG` は `#3A2A2E`、`CURSOR_BG` は `#4A3036`、`SURFACE` は `#1C1820`）。
  - [ ] 案 B は凪の海に寄せる。アプリは今の青 `#60A5FA` のまま。ロゴの太陽を `#FDE68A` から `#F5B971`、水平線を `#93C5FD`、水面を `#60A5FA` から `#3B4CCA` にする。
  - [ ] 案 C は夜明けで両方をつなぐ。ロゴの太陽を `#FFD47A` から `#FF8A65`、水平線を `#FFC9A3`、水面を `#A5B4FC` から `#60A5FA` にする。アプリの `ACCENT` と `IN_PROGRESS` を `#7C9CFF` にする。
  - [ ] 3 案の SVG を `/tmp/swarm-R07/proto/<a|b|c>/` に書く。`nix shell nixpkgs#librsvg -c rsvg-convert -w 720` で PNG にする。
  - [ ] 3 つのバイナリを `scripts/tui-shot.py` で 120x36 に起動する。受信箱、ログインの画面、カレンダーを撮る。データは同じ一時 HOME に `nagi add` で入れる（締切を過ぎた 1 件、今日 2 件、ふつう 2 件）。
  - [ ] Pillow で 3 列の一覧 `docs/review/R07-palettes.png` を作る。各列はロゴ 2 種、アイコン、3 つの画面。日の出の 3 秒を 3 案並べた動画を `ffmpeg` で `docs/review/R07-palettes.mp4` にする。
  - [ ] 一覧と動画を operator に見せ、A、B、C の返事を待つ。選んだ案を PR の本文に書く。選んだあと `proto/R07-palette` を消す。
- [ ] 選んだ案の 6 つのブランドの色を `theme.rs` の `BRAND_*` に入れる。`logo.rs` はそれを読む。色の値を書く場所を `theme.rs` の 1 か所にする。
- [ ] アプリの色を選んだ案の値にする。`ATTENTION` と `DANGER` は、下の `semantic_colors_stay_apart` が通るときだけ今の値を残す。
- [ ] SVG 3 つの色を `BRAND_*` と同じ 16 進にする。
- [ ] `docs/brand.md` を書く。色の表を置く（名前、16 進、役目、Rust の定数）。ロゴの使い分けを書く（`logo-dark.svg` は暗い地、`logo-light.svg` は明るい地、`icon.svg` は正方形の場所）。余白はロゴの四方に太陽の半径と同じ幅にする。最小の大きさはアイコン 16 px、字の入ったロゴは幅 120 px にする。してはいけないことを書く（色を変える、縦横を伸ばす、影を付ける、写真の上に置く、締切切れにアクセントの色を使う）。

**You see.**
- [ ] 起動すると、サイドバーのロゴと選んでいる行のアクセントが同じ配色に見える。
- [ ] ログインの画面で、太陽が選んだ案の色で昇る。
- [ ] GitHub の README の先頭のロゴが、暗い表示でも明るい表示でも選んだ案の色で出る。
- [ ] `docs/brand.md` を読むと、色の 16 進とロゴの置き方が分かる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cd tui && cargo test` が通る。
- [ ] `theme.rs` の新しいテスト `brand_colors_match_svgs` が通る。`include_str!` で `assets/` の 3 つの SVG を読む。`BRAND_*` の 16 進がどの SVG にもあることを確かめる。ほかの 16 進がないことも確かめる（字の線とアイコンの地は除く）。
- [ ] `semantic_colors_stay_apart` が通る。`ACCENT`、`ATTENTION`、`DANGER` の Lab の距離（CIE76）が、どの 2 つでも 25 以上。
- [ ] `text_contrast_on_grounds` が通る。`ACCENT`、`MUTED`、`ATTENTION`、`DANGER` と `SURFACE`、`BRAND_GROUND` の WCAG のコントラスト比が 4.5 以上。`FAINT` は 3.0 以上。
- [ ] `logo.rs` の `どの時点でも24桁10行になる` が、変えずに通る。
- [ ] `cargo clippy --all-targets -- -D warnings`、`cargo fmt --check`、`xmllint --noout assets/*.svg` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.
- [ ] Lane 1. Regression lane against trunk. trunk と head のバイナリを、同じ一時 HOME（締切を過ぎた 1 件、今日 2 件、ふつう 2 件）で 120x36 に起動し、`J` で 2 行を選んで 3 秒後の受信箱を撮る。Save `inbox-trunk-head.png`. Pass when 文字と並びが trunk と同じで、違う画素がアクセント、カーソルの行、選んだ行、サイドバーの地、ロゴの 24x10 のセルの中だけにある.
- [ ] Lane 2. Ctrl+K で「ログイン」を選び、ログインの画面を 3 秒後に撮る。Save `login-logo.png`. Pass when 太陽の中心のセルの色が `BRAND_SUN_TOP` と `BRAND_SUN_BOTTOM` を結ぶ線の上（各成分 8 以内）にあり、水平線のまん中のセルが `BRAND_HORIZON` と各成分 8 以内.
- [ ] Lane 3. 120x36 で起動し、3 秒後のサイドバーの上のロゴを撮る。Save `sidebar-logo.png`. Pass when ロゴのまわりのセルの地が `SURFACE` と同じ色で、ロゴの範囲に `SURFACE` より暗い四角が出ない.
- [ ] Lane 4. ログインの画面を 0.5 秒、1.5 秒、2.5 秒で撮り、3 枚を横に並べる。Save `sunrise-steps.png`. Pass when 太陽が 3 枚で下から上へ動き、どの枚でも色のあるセルが 24x10 の外に出ない.
- [ ] Lane 5. 今日の画面（`2`）で 1 件に `s` を押して進行中にし、`v` でボードにして撮る。Save `board-in-progress.png`. Pass when 進行中の印 ◐ の色が新しい `IN_PROGRESS` と同じで、カーソルの行の地が新しい `CURSOR_BG` と同じ.
- [ ] Lane 6. カレンダー（`6`）で、今日の日、締切が今日の◆、締切を過ぎた◆が同じ月に見える状態を撮る。Save `calendar-semantics.png`. Pass when 画素から測ったアクセント、注意、締切切れの 3 色の Lab の距離が、どの 2 つでも 25 以上.
- [ ] Lane 7. Ctrl+K でコマンドの一覧を開き、ポップアップの地と枠を撮る。Save `palette-surface.png`. Pass when 補助の文字とポップアップの地を画素から測ったコントラスト比が 4.5 以上で、枠の色が新しい `BORDER` と同じ.
- [ ] Lane 8. `N` でプロジェクトを 8 つ作り（作った順に `PROJECT_COLORS` の 8 色が付く）、サイドバーを撮る。Save `project-colors.png`. Pass when 8 色が互いに違い、どれも新しい `ACCENT` と Lab の距離が 15 以上離れている.
- [ ] Lane 9. `rsvg-convert` で `assets/logo-dark.svg` を `#0D1117` の地に、`assets/logo-light.svg` を `#FFFFFF` の地に描く。`assets/icon.svg` は 16、32、512 px で描き、1 枚に並べる。Save `svg-assets.png`. Pass when 3 つの SVG の太陽の中心の画素が同じ色で、16 px のアイコンでも太陽と水面の画素の Lab の距離が 20 以上あり、字の線と地のコントラスト比が 4.5 以上.
- [ ] Lane 10. 80x24 で起動し、`\` でサイドバーを畳んで撮る。Save `narrow-rail.png`. Pass when ロゴのセルが 1 つも描かれず、今いる画面の印と帯の上の `凪` が新しい `ACCENT` で出る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 毎秒の書き出し回数。起動から 2.5 秒の日の出のあいだと、そのあとの 10 秒を分けて測る。
- [ ] Probe. `scripts/tui-shot.py` で 120x36 に起動し、キーを送らずに 12.5 秒置く。5 回の中央値を取る。
- [ ] Baseline. trunk のバイナリで同じ probe を 5 回取る。`animation_tick` の値から、日の出のあいだは毎秒 20 回前後、そのあとは毎秒 10 回前後になるはず。
- [ ] Rule. head の 2 つの値が、どちらも trunk の 1.1 倍以下。色の値を変えるだけなので、増えたら原因を直してから出す。

**Review gate.**
- [ ] Copy lane 1, lane 2, and lane 9 screenshots into `docs/review/R07-review-palette.png`.
- [ ] Record a 30 to 60 second video of the change and save it as `docs/review/R07-review.mp4`. ログインの日の出、サイドバー、カレンダー、コマンドの一覧の順に、tui-shot のコマを `ffmpeg` でつなぐ。
- [ ] Post the screenshot and the video in chat for the operator. Stop at merge-ready.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.
- [ ] `gh pr close 36` で、ロゴ案の下書きの PR を閉じる。この PR へのリンクを添える。

## 24 ビット色のないターミナルと明るい背景で読めるようにする (R08)

**Depends on.** R07.

**Files.**
- [ ] Create `tui/src/ui/color.rs`。`ColorDepth`、`Background`、`detect_depth`、`query_background`、`parse_osc11`、`to_256`、`to_16` を置く。
- [ ] `tui/src/ui/theme.rs` を変える。定数をやめ、`Copy` の構造体 `Theme` にする。暗い地と明るい地の 2 組を持ち、`theme::set` と、`theme::accent()`、`theme::cursor_bg()` などの関数を持たせる。
- [ ] `tui/src/ui/render/board.rs`、`calendar.rs`、`detail.rs`、`list.rs`、`mod.rs`、`overlay.rs`、`timeline.rs` を変える。`theme::CURSOR_BG`、`SELECTED_BG`、`SURFACE`、`BORDER`、`ATTENTION`、`DANGER`、`IN_PROGRESS` の定数を関数の呼び出しに移す。
- [ ] `tui/src/ui/render/logo.rs` を変える。`TERMINAL_GROUND` を消し、地の色を `theme` から受け取る。
- [ ] `tui/src/ui/mod.rs` の `run` を変える。端末に問い合わせてから、イベントを読むスレッドを起こす。
- [ ] `tui/src/ui/keys.rs` と `tui/src/ui/app.rs` を変える。`Action::Theme` を足す。
- [ ] `tui/src/cli.rs`、`tui/src/main.rs`、`tui/src/config.rs` を変える。`--theme` と `Prefs.theme` を足す。
- [ ] `scripts/tui-shot.py` を変える。`--bg <hex>`、`--fg <hex>`、`--silent` を足す。
- [ ] `README.md` と `docs/brand.md` を変える。

**Build.**
- [ ] `color.rs` に `ColorDepth`（`TrueColor`、`Ansi256`、`Ansi16`、`NoColor`）を作る。`detect_depth` は環境変数を引数の関数から読む（テストで差し替えるため）。`NO_COLOR` が空でなければ `NoColor` にする。`COLORTERM` が `truecolor` か `24bit` なら `TrueColor` にする。`TERM` が `dumb` なら `NoColor` にする。`TERM` が `256color` を含めば `Ansi256` にする。ほかは `Ansi16` にする。
- [ ] `to_256` を作る。xterm の 16 番から 255 番の色から、RGB の距離が一番近い番号を選ぶ。`to_16` は近さで選ばず、役目の表で決める。アクセントは R07 の色相に近い ANSI の色、注意は `Yellow`、締切切れは `Red`、補助は `Gray`、控えめは `DarkGray` にする。
- [ ] 16 色と色なしでは、カーソルの行の地の色をやめ、`Modifier::REVERSED` にする。16 色の選んだ行は `DarkGray` の地（明るい地では `Gray`）にする。色なしでは前景の色も付けない。締切切れは今と同じ「N日超過」の文字で分かる。
- [ ] `Background`（`Dark`、`Light`）を決める。順は `--theme auto|dark|light`、`Prefs.theme`、端末への問い合わせ、`COLORFGBG`、最後に `Dark`。
- [ ] 問い合わせは `ui::run` の中で、`ratatui::init()` のあと、`event::read` のスレッドを起こす前にする（先に起こすと、そのスレッドが答えを読んでしまう）。`/dev/tty` に `\x1b]11;?\x07` と DA1 の `\x1b[c` を書き、DA1 の答えが来るか 150 ms たつまで読む。`parse_osc11` は `rgb:RRRR/GGGG/BBBB` と 2 桁の形を読み、BEL と ST の終わりを受ける。相対輝度が 0.5 より上なら `Light` にする。Windows では問い合わせない。
- [ ] `COLORFGBG` は最後の番号を背景として読む。7 と 9 から 15 は `Light`、ほかは `Dark` にする。
- [ ] `theme.rs` に明るい組を作る。`SURFACE` は `#F4F6FA`、`SELECTED_BG` は `#E3ECFB`、`CURSOR_BG` は `#CFE0FA`、`BORDER` は `#B8C4D6`、`MUTED` は `#5B6478`、`FAINT` は `#8A93A6` から始める。アクセント、注意、締切切れは R07 の色相のまま、白地で 4.5 以上になるまで暗くする。
- [ ] `theme::set(Theme)` は `thread_local!` の `Cell<Theme>` に入れる。色の関数は、深さに合わせて写した色を返す。写すのは `set` のときに 1 回だけにする。
- [ ] ロゴの地を合わせる。ログインの画面には `theme::ground()` を渡す（問い合わせで分かった背景色、なければ暗い組の `#0D1117` か明るい組の `#FFFFFF`）。サイドバーには `theme::surface()` を渡す。混ぜたあとの色を深さに合わせて写す。色なしでは、ロゴの形だけを既定の色で描く。
- [ ] Ctrl+K に「配色を自動にする」「暗い背景にする」「明るい背景にする」を足す（`Action::Theme`）。選ぶとすぐ描き直し、`Prefs.theme` に `auto`、`dark`、`light` を保存する。
- [ ] `cli.rs` の `VALUE_FLAGS` に `theme` を足し（14 から 15）、`Invocation` に `theme` を持たせて `ui::run` に渡す。画面を開くときだけ使える。ほかのコマンドに付けたら終了コード 2 で断る。`HELP` に 1 行足す。
- [ ] `scripts/tui-shot.py` に `--bg` と `--fg` を足す。描くときの既定の色にし、OSC 11 には `--bg` の色で答える。`--silent` を付けると OSC 11 にも DA1 にも答えない。
- [ ] `README.md` の「ローカルとクラウド」のあとに、`--theme`、`NO_COLOR`、24 ビット色のない端末での見え方を書く。`docs/brand.md` に明るい組の表を足す。

**You see.**
- [ ] macOS の Terminal.app のように `COLORTERM` のない端末でも、色が 256 色の近い色で出て、崩れない。
- [ ] `NO_COLOR=1` で起動すると色が消え、カーソルの行は反転で分かる。
- [ ] 明るい背景の端末では、何も指定しなくても明るい組で描き、ロゴのまわりに暗い四角が出ない。
- [ ] `nagi --theme light` と Ctrl+K の配色の項目で、自分で選べる。選んだものは次の起動でも残る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cd tui && cargo test` が通る。
- [ ] `detect_depth` の表のテストを足す。`NO_COLOR=1` と `COLORTERM=truecolor` なら `NoColor`。空の `NO_COLOR` は見ない。`COLORTERM=24bit` なら `TrueColor`。`TERM=xterm-256color` と `TERM=tmux-256color` なら `Ansi256`。`TERM=xterm` か `TERM` なしなら `Ansi16`。`TERM=dumb` なら `NoColor`。
- [ ] `to_256` のテストを足す。`#60A5FA` は 75、`#0D1117` は 233 になる。
- [ ] `parse_osc11` のテストを足す。`rgb:ffff/ffff/ffff` は `Light`、`rgb:0d0d/1111/1717` は `Dark`、`rgb:ff/ff/ff` も読む。BEL と ST の両方の終わりを受ける。壊れた答えは `None` になる。`COLORFGBG` の `15;0` は `Dark`、`0;15` は `Light` になる。
- [ ] R07 の `text_contrast_on_grounds` を明るい組にも回す。白地と明るい `SURFACE` で 4.5 以上（`FAINT` は 3.0 以上）。
- [ ] `--theme` の順のテストを足す。指定が覚え書きに勝ち、覚え書きが問い合わせに勝つ。`cli::parse` は `--theme blue` と `nagi list --theme light` を断る。
- [ ] `cargo clippy --all-targets -- -D warnings` と `cargo fmt --check` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.
- [ ] Lane 1. Regression lane against trunk. `COLORTERM=truecolor` と `TERM=xterm-256color` で trunk と head を 120x36 に起動し、R07 の lane 1 と同じデータの受信箱を 3 秒後に撮る。Save `truecolor-trunk-head.png`. Pass when ロゴの 24x10 のセルの外で、trunk と違う画素が 0.
- [ ] Lane 2. `TERM=xterm-256color` で `COLORTERM` を消して起動し（Terminal.app と同じ）、受信箱を撮る。Save `ansi256.png`. Pass when どの画素の色も、xterm の 256 色の表の色か、tui-shot の既定の前景と背景の色.
- [ ] Lane 3. `TERM=xterm` で `COLORTERM` を消して起動し、`J` で 2 行を選んで撮る。Save `ansi16.png`. Pass when 色が 16 色の表と既定の色だけで、カーソルの行が反転し、選んだ行が `DarkGray` の地で見分けられる.
- [ ] Lane 4. `NO_COLOR=1` と `COLORTERM=truecolor` で起動し、締切を過ぎたタスクにカーソルを置いて撮る。Save `no-color.png`. Pass when 既定の前景と背景のほかの色が画面になく、カーソルの行が反転で分かり、締切を過ぎた行に「N日超過」が出る.
- [ ] Lane 5. tui-shot を `--bg ffffff --fg 1f2328` にして、指定なしで起動して撮る。Save `light-auto.png`. Pass when サイドバーの地が `#F4F6FA` で、題の文字と地のコントラスト比が 4.5 以上.
- [ ] Lane 6. 暗い地（`--bg 0d1117`）の tui-shot で `nagi --theme light` を起動して撮る。Save `light-forced.png`. Pass when 問い合わせの答えは暗いのに、サイドバーの地が `#F4F6FA` になる.
- [ ] Lane 7. Ctrl+K で「明るい背景にする」を選び、`q` で終える。指定なしで起動し直して撮る。Save `prefs-theme.png`. Pass when 一時 HOME の `prefs.json` に `"theme": "light"` があり、起動し直した画面が明るい組.
- [ ] Lane 8. `--bg ffffff` の tui-shot で Ctrl+K から「ログイン」を開き、3 秒後に撮る。Save `login-light-logo.png`. Pass when ロゴのまわりのセルが白い地と同じ色で、ロゴの範囲に暗い四角がなく、太陽の中心のセルが R07 の太陽の色の線の上にある.
- [ ] Lane 9. tui-shot を `--silent` にして起動し、最初の画面までの時間を取る。次に `COLORFGBG=0;15` を足して同じことをする。Save `no-answer.png`. Pass when 1 回目は暗い組、2 回目は明るい組で、どちらも最初の画面が trunk より 200 ms 以内の遅れで出る.
- [ ] Lane 10. 一時 HOME で `NO_COLOR=1 TERM=dumb nagi list` と `nagi list --theme light` を打って撮る。Save `cli-theme.png`. Pass when `nagi list` の出力が trunk とバイト単位で同じで、`--theme` 付きは終了コード 2 で断る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 起動から最初の画面までの時間と、何もしないときの毎秒の書き出し回数。
- [ ] Probe. `scripts/tui-shot.py` で 120x36 に 20 回起動する。`--theme dark`、答える端末での自動、`--silent` での自動の 3 通りで、それぞれ中央値を取る。
- [ ] Baseline. trunk のバイナリで同じ probe を 20 回取る。trunk は問い合わせをしない。
- [ ] Rule. `--theme dark` と答える端末では、trunk より 10 ms 以内の遅れにする。`--silent` では 200 ms 以内にする。書き出し回数は trunk 以下にする。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 画面と CLI の文字を翻訳の表に移す (R09)

**Depends on.** R00.

**Files.**
- [ ] Create `tui/src/i18n/mod.rs`。`Lang`、`resolve_lang`、`init`、`t`、`fill` を置く。
- [ ] Create `tui/src/i18n/messages.rs`。`messages!` のマクロと、すべての文言の表を置く。
- [ ] `tui/src/main.rs`、`tui/src/cli.rs`、`tui/src/config.rs`、`tui/src/auth.rs`、`tui/src/dates.rs`、`tui/src/model.rs` の画面と CLI に出る文字を表に移す。
- [ ] `tui/src/data/` の利用者に見せる文字を表に移す（`actions.rs`、`store.rs`、`device.rs`、`net.rs` の誤りと知らせ）。
- [ ] `tui/src/ui/` の文字を表に移す（`app.rs`、`keys.rs`、`commands.rs`、`input.rs`、`list.rs`、`login.rs`、`views.rs`、`theme.rs`、`clipboard.rs`）。
- [ ] `tui/src/ui/render/` の文字を表に移す（`board.rs`、`calendar.rs`、`detail.rs`、`list.rs`、`mod.rs`、`overlay.rs`、`timeline.rs`）。
- [ ] `README.md` の「`tui/` の中」に `i18n/` を足す。

**Build.**
- [ ] 仕組みを決め、理由を PR の本文に書く。自前の表にする。言語は 2 つだけで、文はビルドのときに決まる。鍵を enum にすると、書き忘れた鍵はビルドで落ちる。`rust-i18n` は鍵が文字列なので、打ち間違いが実行のときまで分からない。`fluent` は実行のときに文を読むので、バイナリと起動が重くなる。`gettext` は実行のときに `.mo` のファイルが要り、musl の 1 つのバイナリで配る今の形に合わない。自前なら依存が増えず、文は `&'static str` のままで、割り当てが増えない。
- [ ] `messages!` のマクロを作る。`Key => "日本語",` の形で書き、`enum Msg`、`Msg::ALL`、`fn ja(self) -> &'static str` を作る。
- [ ] 値の入る文は `{0}`、`{1}` の番号の穴で書き、`i18n::fill(Msg, &[&dyn Display]) -> String` で埋める。言語で語順が変わっても書けるように、番号で指す。
- [ ] 言語を決める `resolve_lang` を作る。`--lang`、`Prefs.lang`、`LC_ALL`、`LC_MESSAGES`、`LANG` の順に見て、最初の空でない値を使う。`ja` で始まる値は日本語になる。この PR の言語は日本語だけなので、どの値でも日本語になる。`--lang` の値は `ja` だけを受け、ほかの値は終了コード 2 で断る。
- [ ] `main.rs` で、`cli::parse` の前に言語を決めて `i18n::init` する（引数の誤りの文も表を通すため）。`--lang` は引数を先に見て拾う。`Prefs.lang` は `XDG_CONFIG_HOME` の下の `nagi/prefs.json` から読む。`cli.rs` の `VALUE_FLAGS` に `lang` を足し、`HELP` に 1 行足す。
- [ ] 文字を移す。日本語を含む文字列リテラルは約 775 個、38 ファイル（テストのデータを含む）。テストの外のものを全部、表の鍵に置き換える。`cli::HELP`、`keys.rs` の `bindings` の名前、`at` の場所の名前、`field_keys`、`Group::label`、`Priority::label`、`TaskSort::label`、`ValueKind::label`、`Column::label`、`project_color_label` も移す。
- [ ] `dates.rs` の表示の関数（`weekday_label`、`format_short_date_with_weekday`、`format_long_date`、`format_day_heading`、`deadline_status`、`schedule_heading`）の文を表に移す。`WEEKDAYS` は入力を読むためだけに残す。
- [ ] 移さないものを決めて残す。入力の語（`dates.rs` の `relative_days`、`WEEKDAY`、`OFFSET`、`SUFFIX` の語と、`cli.rs` の `list_name` の「受信箱」など）は読むための語なので、今の場所に残す。`--json` の出力、`log.rs` の記録、テストのデータも移さない。
- [ ] 振る舞いを変えない。どの画面も、どの出力も、trunk と同じ文字と同じ幅で出す。

**You see.**
- [ ] 画面も CLI も、trunk と同じ日本語で、同じ並びで出る。
- [ ] `nagi --lang ja` が使える。`nagi --lang fr` は、使える値 `ja` を示して終わる。
- [ ] 文言を直すときは `tui/src/i18n/messages.rs` の 1 か所を見ればよい。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cd tui && cargo test` が通る。今のテストが期待する文字は 1 つも書き換えない。`git diff origin/main...HEAD -U0 -- tui/src | grep '^-.*assert'` が何も出さない。
- [ ] 新しいテスト `no_user_literal_outside_catalog` が通る。`CARGO_MANIFEST_DIR` から `src/` の `.rs` を読み、日本語を含む文字列リテラルの行を探す。`//` のコメント、`#[cfg(test)]` から後ろ、`src/data/tests.rs`、`src/i18n/` と、上で決めた入力の語の場所は飛ばす。見つかれば落ちる。
- [ ] 新しいテスト `every_message_has_japanese` が通る。`Msg::ALL` のどの鍵も空でない。`{0}` からの番号の穴が、抜けなしで続いている。
- [ ] `resolve_lang` の順のテストが通る。`--lang` が覚え書きに勝つ。覚え書きが `LC_ALL` に勝つ。`LC_ALL` が `LC_MESSAGES` に勝つ。`LC_MESSAGES` が `LANG` に勝つ。空の値は飛ばす。
- [ ] `cargo clippy --all-targets -- -D warnings` と `cargo fmt --check` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.
- [ ] Lane 1. Regression lane against trunk. R07 の lane 1 と同じデータで trunk と head を 120x36 に起動し、受信箱を 3 秒後に撮る。Save `inbox-golden.png`. Pass when ロゴの 24x10 のセルの外で、trunk と違う画素が 0.
- [ ] Lane 2. `nagi --help`、`nagi add --help`、タイトルのない `nagi add`、`nagi list foo`、`nagi --bogus` を trunk と head で打ち、端末を撮る。Save `cli-help-errors.png`. Pass when 5 つの標準出力、標準エラー、終了コードが trunk とバイト単位で同じ（`--help` に足した `--lang` の 1 行だけを除く）.
- [ ] Lane 3. `?` でショートカットのページを開いて撮り、「完了」と打って絞り込んだ画面も撮る。Save `shortcuts-golden.png`. Pass when 2 枚とも trunk と違う画素が 0.
- [ ] Lane 4. Ctrl+K でコマンドの一覧を開いて撮り、「ログ」と打って絞り込んだ画面も撮る。Save `palette-golden.png`. Pass when 2 枚とも trunk と違う画素が 0.
- [ ] Lane 5. カレンダー（`6`）とタイムライン（`7`）を撮る。Save `calendar-timeline-golden.png`. Pass when 年月の見出し、曜日、「今日」、「ほか N 件」、「1 週前から 8 週先まで」を含め、trunk と違う画素が 0.
- [ ] Lane 6. 1 件を `Enter` で開いてメモとチェックリストの欄を出し、`P` で優先度の候補を開いて撮る。続けて `Esc` と `x` で完了にし、1 秒以内にトーストを撮る。Save `detail-toast-golden.png`. Pass when 2 枚とも trunk と違う画素が 0.
- [ ] Lane 7. `d` で日付の欄を開き、「金曜」と打った画面と「あさってx」と打った画面を撮る。Save `date-input-golden.png`. Pass when 読みの行と「日付として読めません」の行が、trunk と違う画素 0 で出る.
- [ ] Lane 8. Ctrl+K から「ログイン」を開いて最初の画面を撮る。次に `--server http://127.0.0.1:9` で起動し、Enter を押して失敗の文を撮る。Save `login-golden.png`. Pass when 2 枚ともロゴの外で trunk と違う画素が 0 で、失敗の文が「Worker に接続できませんでした」.
- [ ] Lane 9. 同じ `local.db` を写した 2 つの一時 HOME で、`nagi list`、`nagi list all --json`、`nagi show <ID>`、`nagi show <ID> --json`、`nagi projects` を trunk と head で打つ。Save `cli-output-golden.png`. Pass when 5 つの出力がバイト単位で同じ.
- [ ] Lane 10. `LANG=en_US.UTF-8`、`LC_ALL=C`、`LC_MESSAGES=ja_JP.UTF-8`、`--lang ja` の 4 通りで受信箱を撮り、`nagi --lang fr` も打つ。Save `locale-inputs.png`. Pass when 4 通りとも lane 1 の head の画面と違う画素が 0 で、`--lang fr` は終了コード 2 で使える値 `ja` を示す.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. release のバイナリの大きさ、起動から最初の画面までの時間、`nagi list --json` の時間。
- [ ] Probe. `cd tui && cargo build --release` のあと `stat -c %s target/release/nagi` で大きさを取る。`scripts/tui-shot.py` で受信箱を 20 回開いて中央値を取る。1000 件の一時 HOME で `nix shell nixpkgs#hyperfine -c hyperfine 'nagi list --json'` を回す。
- [ ] Baseline. trunk で同じ 3 つを取る。
- [ ] Rule. 大きさは trunk + 32 KiB 以下。最初の画面は trunk + 5 ms 以下。`nagi list --json` は trunk の 1.05 倍以下。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 英語の文字と日付の入力と help を足す (R10)

**Depends on.** R09.

**Files.**
- [ ] `tui/src/i18n/messages.rs` を変える。すべての鍵に英語の列を足す。
- [ ] `tui/src/i18n/mod.rs` を変える。`Lang::En` を足し、`resolve_lang` を英語に対応させる。テストを足す。
- [ ] `tui/src/dates.rs` を変える。英語の日付の入力と表示を足す。
- [ ] `tui/src/cli.rs` を変える。英語の `HELP` を足し、`--lang` に `en` を足す。
- [ ] `tui/src/ui/keys.rs`、`tui/src/ui/app.rs`、`tui/src/config.rs` を変える。Ctrl+K に言語の項目を足し、`Prefs.lang` に保存する。
- [ ] `tui/src/ui/render/calendar.rs`、`tui/src/ui/render/mod.rs`、`tui/src/ui/render/timeline.rs` を変える。英語の幅に合わせる。
- [ ] `README.md` を変える。`--lang` と英語の日付の行を足す。
- [ ] Create `docs/review/R10-review-en.png` と `docs/review/R10-review.mp4`。

**Build.**
- [ ] `messages!` を 2 列にする（`Key => ("日本語", "English"),`）。英語のない鍵があると、ビルドが通らない。
- [ ] `resolve_lang` を変える。`ja` で始まる値は日本語にする。`en` で始まる値、`C`、`POSIX`、ほかの言語、値がないときは英語にする。日本語の端末（`LANG=ja_JP.UTF-8`）の利用者は、今までどおり日本語で見る。`--lang` は `ja` と `en` を受ける。
- [ ] 英語の文を書く。数で形が変わる文は鍵を分ける（`DaysLeftOne` と `DaysLeftMany`、`DaysOverdueOne` と `DaysOverdueMany`、件数の文）。
- [ ] 英語の日付の表示を書く。曜日つきの短い形は `Fri 10/2`、長い形は `Mon, Oct 5`（年が違えば `Mon, Jan 4, 2027`）、見出しは `Monday, September 28` にする。締切は `due 10/2`、`3 days left`、`due today`、`2 days overdue`、予定の見出しは `Today`、`Tomorrow` にする。
- [ ] 英語の日付の入力を `dates.rs` に足す。`parse_date_input` は日本語の読みが外れたら `parse_english` を呼ぶ。英語は小文字にし、空白を 1 つにまとめてから読む（今の `normalize` は空白を消すので、英語には使わない）。
- [ ] `parse_english` が読む語は、`today`、`tomorrow`、曜日（`mon` から `sun` と `monday` から `sunday`）、`next <曜日>`、`in N day(s)`、`in N week(s)` にする。曜日だけなら今日より後の一番近い日。`next <曜日>` は日本語の `来週<曜日>` と同じ日にする。`in N` の上限は `MAX_OFFSET_DAYS` にする。ISO の `2026-10-09` は今の `FULL` が読む。`10/3` は今と同じく月/日。UI の言語に関係なく、両方の言語の入力を読む。
- [ ] 英語の `HELP` を書く。`--lang <ja|en>`、`--theme`、英語の日付の例を入れる。
- [ ] Ctrl+K に「言語」（英語では `Language`）を足す。選ぶとすぐ描き直し、`Prefs.lang` に `ja` か `en` を保存する。
- [ ] 英語の幅に合わせて直す。カレンダーの「今日」の欄、サイドバーの `label_width`、一番下のキーの案内を、80x24 で語の途中で切れない幅にする。
- [ ] `README.md` の日付の書き方の行に英語の例を足し、`--lang` を書く。全体の書き直しは R11 でする。

**You see.**
- [ ] `LANG=en_US.UTF-8` の端末では、画面、CLI、`--help` が英語で出る。
- [ ] 日本語の端末では、今までと同じ日本語で出る。
- [ ] 日付の欄に `tomorrow`、`fri`、`next monday`、`in 3 days`、`2026-12-24` と打てる。日本語の語も、どちらの言語でも読める。
- [ ] `--lang` か Ctrl+K の言語の項目で、言語を選べる。選んだものは次の起動でも残る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cd tui && cargo test` が通る。
- [ ] 新しいテスト `every_message_has_both_languages` が通る。`Msg::ALL` のどの鍵も、日本語と英語の両方が空でない。英語にかなと漢字がない。日本語と英語で、番号の穴の組が同じ。
- [ ] 英語の日付のテストが通る。今日を 2026-10-12（月曜）にする。`today` は 2026-10-12、`tomorrow` は 10-13、`fri` と `Friday` は 10-16、`monday` は 10-19 になる。`next monday` は 10-19 で、`来週月曜` と同じ。`next friday` は 10-23 で、`来週金曜` と同じ。`in 3 days` は 10-15、`in 2 weeks` は 10-26、`In  3   Days` は 10-15、`2026-12-24` はそのままになる。`in 3661 days`、`next`、`nextday` は `None` になる。
- [ ] 今の日本語の日付のテストが、変えずに通る。
- [ ] 新しいテスト `help_lists_every_flag` が通る。日本語と英語の `HELP` に、`VALUE_FLAGS` と `SWITCHES` のすべての名前が `--<名前>` の形で出る。
- [ ] `--json` の出力が言語で変わらないことをテストで確かめる。`cargo clippy --all-targets -- -D warnings` と `cargo fmt --check` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.
- [ ] Lane 1. Regression lane against trunk. `LANG=ja_JP.UTF-8` で trunk と head を起動し、R07 の lane 1 と同じデータの受信箱を撮る。Save `ja-unchanged.png`. Pass when ロゴのセルの外で trunk と違う画素が 0 で、英語を足しても日本語の利用者の画面が変わらない.
- [ ] Lane 2. `LANG=en_US.UTF-8` の一時 HOME で初めて起動し、空の受信箱を撮る。`LC_ALL=C` と、`LANG=ja_JP.UTF-8 LC_ALL=en_US.UTF-8` でも撮る。Save `en-first-run.png`. Pass when 3 枚とも、tui-shot が描く pyte の画面の文字にかなと漢字がなく、サイドバーに `Inbox`、`Today`、`Upcoming`、`Later`、`Logbook`、`Calendar`、`Timeline` が出る.
- [ ] Lane 3. 英語の画面で 1 件を選び、`d` を押して `next monday` と打った読みを撮る。同じ回で `来週月曜` とも打って撮る。Save `en-next-monday.png`. Pass when 2 つの読みが同じ日付で、Enter のあと行に `Mon 10/19` の形の日付が出る.
- [ ] Lane 4. `d` の欄に `tomorrow`、`fri`、`in 3 days`、`in 2 weeks`、`2026-12-24`、`next` を順に打ち、1 つずつ撮って 1 枚に並べる。Save `en-date-words.png`. Pass when 前の 5 つがその日の今日から正しく計算した日付を出し、`next` だけが注意の色で `Not a date` を出す.
- [ ] Lane 5. `nagi --lang en add "Write report" --to tomorrow --deadline fri` と `nagi --lang en list upcoming` を打つ。同じ HOME で `nagi --lang ja show <ID> --json` と `nagi --lang en show <ID> --json` も打つ。Save `en-cli.png`. Pass when add が終了コード 0 で、一覧の日付と締切が英語の形で出て、2 つの JSON がバイト単位で同じ.
- [ ] Lane 6. 100x40 の端末で `nagi --help --lang en` と `LANG=en_US.UTF-8 nagi --help` を打って撮る。Save `en-help.png`. Pass when 2 つの出力が同じで、かなと漢字がなく、すべての指定が `--<名前>` で出て、100 桁を超える行がない.
- [ ] Lane 7. `LANG=en_US.UTF-8` で 80x24 に起動し、受信箱、今日のボード（`2` と `v`）、カレンダー（`6`）を撮る。Save `en-80x24.png`. Pass when 一番下のキーの案内、サイドバーの名前、カレンダーの欄が語の途中で切れず、切るときは `…` で終わる.
- [ ] Lane 8. 英語の画面で `?` のショートカットのページを撮り、Ctrl+K の一覧で `comp` と打って撮る。Save `en-palette.png`. Pass when 2 つの画面がすべて英語で、`comp` で絞り込んだ候補に `Complete` で始まる項目がある.
- [ ] Lane 9. `LANG=en_US.UTF-8` で起動し、Ctrl+K の `Language` で日本語を選んで `q` で終える。同じ環境で起動し直して撮り、`--lang en` でも起動して撮る。Save `lang-prefs.png`. Pass when `prefs.json` に `"lang": "ja"` があり、起動し直した画面が日本語で、`--lang en` の画面が英語.
- [ ] Lane 10. 英語の画面のために、締切が 2 日後、1 日後、今日、1 日前、2 日前のタスクを `nagi add --deadline` で入れ、受信箱とカレンダーを撮る。Save `en-deadlines.png`. Pass when 行に `2 days left`、`1 day left`、`due today`、`1 day overdue`、`2 days overdue` が出て、カレンダーの見出しが `October 2026` の形（月の名前と西暦）.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. release のバイナリの大きさ、起動から最初の画面までの時間、`nagi list` の時間。
- [ ] Probe. `cd tui && cargo build --release` のあと `stat -c %s target/release/nagi` を取る。`scripts/tui-shot.py` で英語と日本語の受信箱を 20 回ずつ開いて中央値を取る。1000 件の一時 HOME で `nix shell nixpkgs#hyperfine -c hyperfine 'nagi list'` を回す。
- [ ] Baseline. trunk（R09 のあと）で同じ 3 つを取る。
- [ ] Rule. 大きさは trunk + 48 KiB 以下。最初の画面はどちらの言語でも trunk + 5 ms 以下。`nagi list` は trunk の 1.05 倍以下。

**Review gate.**
- [ ] Copy lane 2, lane 4, and lane 7 screenshots into `docs/review/R10-review-en.png`.
- [ ] Record a 30 to 60 second video of the change and save it as `docs/review/R10-review.mp4`. 英語の画面で、追加、`next monday` の入力、完了、Ctrl+K の言語の切り替えまでを、tui-shot のコマを `ffmpeg` でつないで作る。
- [ ] Post the screenshot and the video in chat for the operator, with the full English string table as a file. Stop at merge-ready.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## README と GitHub の顔を使う人向けにする (R11)

**Depends on.** R07, R10.

**Files.**
- [ ] `README.md` を英語で書き直す。
- [ ] Create `README.ja.md`。
- [ ] Create `docs/operations.md` と `docs/development.md`。今の `README.md` の運用者向けの節を移す。
- [ ] Create `SECURITY.md`。
- [ ] Create `.github/ISSUE_TEMPLATE/bug_report.yml`、`.github/ISSUE_TEMPLATE/feature_request.yml`、`.github/ISSUE_TEMPLATE/config.yml`。
- [ ] Create `assets/social-preview.svg` と `assets/social-preview.png`。
- [ ] Create `scripts/demo-gif.py`、`assets/demo.gif`、`assets/demo-ja.gif`。
- [ ] Create `docs/review/R11-review-readme.png` と `docs/review/R11-review.mp4`。

**Build.**
- [ ] 決めたことを PR の本文に書く。`README.md` を英語、`README.ja.md` を日本語にする。GitHub は `README.md` を先に見せる。Homebrew の formula の `desc` も英語。日本語を読まない人が最初に来る場所なので、英語を先にする。2 つの先頭で、互いにリンクする。
- [ ] `README.md` を使う人の順に書く。ロゴ、1 段落の説明、デモの GIF、入れ方（`brew install myksyut/tap/nagi`、Releases、`cargo install --path tui`）、Quick start、画面とキー、スクリプトとエージェントのための CLI（全部は `nagi --help`）、ローカルとクラウド、データの置き場と控えの取り方、言語と配色（`--lang`、`--theme`、`NO_COLOR`）、文書へのリンク、Security、License の順にする。入れ方には、PR の head の `.github/workflows/tui.yml` が作るターゲットだけを書く。クラウドは今の招待制のとおりに書く。
- [ ] `README.ja.md` を同じ節の順で日本語で書く。Quick start の出力の例は、日本語の画面と CLI の実際の出力にする。
- [ ] `docs/operations.md` に運用者向けの節を移す。今の `README.md` の 12 から 84 行（構成、利用者、ログイン）、241 から 270 行（事前準備）、336 から 355 行（デプロイ）を移す。日本語のままにする。
- [ ] `docs/development.md` に開発の節を移す。今の `README.md` の 187 から 240 行（`tui/` の中）、271 から 322 行（手元での動かし方、コマンド）、323 から 335 行（テスト）を移す。
- [ ] 公開に要らない文を消す。`M7`（101、245、251、273、284、342 行）は「開発の機械」の書き方に直すか消す。`### Web 版との違い`（180 から 185 行）は消す。
- [ ] `SECURITY.md` を書く。報告は GitHub の非公開の報告（`https://github.com/myksyut/nagi/security/advisories/new`）で受ける。直すのは最新の Release だけにする。7 日以内に返事をする。調べてよい範囲と、調べてはいけないこと（ほかの利用者のデータ、本番への負荷）を書く。
- [ ] `gh api -X PUT repos/myksyut/nagi/private-vulnerability-reporting` で、非公開の報告を有効にする。
- [ ] issue の書式を作る。`bug_report.yml` では `nagi --version`、OS、端末の名前、`TERM`、`COLORTERM`、ローカルかクラウドか、言語、手順、期待と実際を聞く。`feature_request.yml` も作る。`config.yml` は `blank_issues_enabled: false` にし、脆弱性は `SECURITY.md` へ案内する。
- [ ] `assets/social-preview.svg` を 1280x640 で作る。R07 のロゴ、`BRAND_GROUND` の地、英語の 1 行の説明を置く。`rsvg-convert -w 1280 -h 640` で `assets/social-preview.png` にする。
- [ ] `scripts/demo-gif.py` を作る。`scripts/tui-shot.py` で 100x30 に起動し、決めたキーを送る（`n` で `Write release notes` を追加、`d` で `tomorrow`、`2` で今日、`x` で完了、`6` でカレンダー）。100 ms ごとのコマを Pillow で GIF にする（`save_all=True`、`loop=0`）。`--lang en` で `assets/demo.gif` を、`--lang ja` で `assets/demo-ja.gif` を作る。データは一時 HOME の種だけにする。
- [ ] `gh repo edit myksyut/nagi --description 'Calm terminal TODO app. Keyboard-only TUI and CLI, local-first, optional cloud sync.'` を打つ。`--add-topic` で `todo`、`tui`、`cli`、`terminal`、`rust`、`ratatui`、`productivity`、`task-manager`、`local-first`、`cloudflare-workers` を足す。
- [ ] Social preview は API で上げられない。operator に Settings > General > Social preview で `assets/social-preview.png` を上げてもらう。

**You see.**
- [ ] GitHub のリポジトリを開くと、英語の README の最初の画面にロゴ、説明、デモ、`brew install` が見える。
- [ ] 日本語の README へは先頭のリンクで行ける。
- [ ] リポジトリの説明と話題が、今の製品（ターミナルの TODO アプリ）を表す。リンクを貼ると新しいブランドの絵が出る。
- [ ] 不具合は書式で報告でき、脆弱性は非公開で報告できる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `cd tui && cargo test` が通る（コードは変えないので、変わらないことを確かめる）。
- [ ] `nix shell nixpkgs#lychee -c lychee --offline README.md README.ja.md SECURITY.md docs/*.md` が、手元のリンクで切れたものを 0 と出す。
- [ ] `python3 -c "import yaml,sys; [yaml.safe_load(open(p)) for p in sys.argv[1:]]" .github/ISSUE_TEMPLATE/*.yml` が通る。
- [ ] `file assets/social-preview.png` が `1280 x 640` を出す。`xmllint --noout assets/social-preview.svg` が通る。
- [ ] `rg -n 'M7|Web 版' README.md README.ja.md docs/` が 0 件。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.
- [ ] Lane 1. Regression lane against trunk. trunk と head の `README.md` を `gh api markdown -f mode=gfm -f context=myksyut/nagi -F text=@README.md` で HTML にし、`nix shell nixpkgs#chromium -c chromium --headless --window-size=1280,900 --screenshot` で最初の画面を撮る。Save `readme-first-view.png`. Pass when head の最初の画面に `brew install myksyut/tap/nagi` とデモの GIF があり、trunk にはない（trunk では 91 行目まで下がる）ことを記録し、head の README に `M7` と `Web 版` がない.
- [ ] Lane 2. 何も入っていない一時 HOME と head のバイナリで、`README.md` の Quick start のコマンドを上から順にそのまま打ち、最後の `nagi` の画面を撮る。Save `readme-quickstart.png`. Pass when どのコマンドも終了コード 0 で、README に書いた出力の例が実際の出力と同じ.
- [ ] Lane 3. `README.ja.md` の Quick start を `LANG=ja_JP.UTF-8` で同じように打って撮る。Save `readme-ja-quickstart.png`. Pass when どのコマンドも終了コード 0 で、日本語の出力の例が実際の出力と同じ.
- [ ] Lane 4. `nix shell nixpkgs#lychee -c lychee README.md README.ja.md SECURITY.md docs/*.md` を外へのリンクも含めて打ち、出力を撮る。Save `links.png`. Pass when 切れたリンクが 0 で、`README.md` と `README.ja.md` が先頭で互いをリンクしている.
- [ ] Lane 5. `assets/demo.gif` と `assets/demo-ja.gif` を Pillow で開き、1 秒ごとのコマを並べた一覧を作る。Save `demo-frames.png`. Pass when 2 つとも 20 秒以内で 3 MiB 以下、追加、日付（英語は `tomorrow`、日本語は `明日`）、完了、カレンダーの順に見え、種のデータのほかの名前や HOME のパスが写らない.
- [ ] Lane 6. operator が Social preview を上げたあと、`gh api graphql -f query='{repository(owner:"myksyut",name:"nagi"){usesCustomOpenGraphImage openGraphImageUrl}}'` を打ち、`openGraphImageUrl` を curl で落として撮る。Save `social-preview.png`. Pass when `usesCustomOpenGraphImage` が true で、落とした絵が `assets/social-preview.png` と同じ絵柄で、元の PNG が 1280x640 で 1 MB 未満.
- [ ] Lane 7. `gh repo view myksyut/nagi --json description,repositoryTopics` を打ち、`https://github.com/myksyut/nagi` を headless chromium で撮る。Save `repo-face.png`. Pass when 説明が PR の本文に書いた英語の 1 文と同じで、話題が 10 個あり、「Web アプリ」が説明にない.
- [ ] Lane 8. `nix shell nixpkgs#check-jsonschema -c check-jsonschema --schemafile https://json.schemastore.org/github-issue-forms.json .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml` を打って撮る。Save `issue-forms.png`. Pass when 2 つとも schema に合い、bug の書式が `nagi --version`、OS、端末、`TERM`、`COLORTERM`、ローカルかクラウドか、言語を聞く.
- [ ] Lane 9. `gh api repos/myksyut/nagi/private-vulnerability-reporting` を打ち、`SECURITY.md` を lane 1 と同じ方法で描いて撮る。Save `security.png`. Pass when 応答が `{"enabled":true}` で、`SECURITY.md` の報告のリンクが curl で 200 か、ログインへの 302 を返す.
- [ ] Lane 10. trunk の `README.md` の見出しを全部出し、head の `README.md`、`README.ja.md`、`docs/operations.md`、`docs/development.md` の見出しと突き合わせた表を作って撮る。Save `moved-sections.png`. Pass when 消すと決めた `Web 版との違い` を除いて、trunk の見出しがどれも head のどこかにある.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. README から読み込む絵の重さ（`assets/demo.gif`、`assets/demo-ja.gif`、`assets/social-preview.png` のバイト数）と、README の最初の画面で読む量。
- [ ] Probe. `stat -c %s assets/demo.gif assets/demo-ja.gif assets/social-preview.png` を取る。lane 1 の headless chromium に `--enable-logging` を付けて、最初の画面で落とすバイト数を取る。
- [ ] Baseline. trunk の README が読む絵は `assets/logo-dark.svg` と `assets/logo-light.svg`（どちらも約 1.9 KB）だけ。
- [ ] Rule. GIF は 1 つ 3 MiB 以下。Social preview は 1 MB 未満（GitHub の上限）。README の最初の画面で落とす量は 4 MB 以下。

**Review gate.**
- [ ] Copy lane 1, lane 3, and lane 6 screenshots into `docs/review/R11-review-readme.png`.
- [ ] Record a 30 to 60 second video of the change and save it as `docs/review/R11-review.mp4`. headless chromium で README を上から下まで送り、デモの GIF が動くところと日本語の README へのリンクを見せる。
- [ ] Post the screenshot and the video in chat for the operator, with the English README text for a wording check. Stop at merge-ready.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.
- [ ] マージのあと、`https://github.com/myksyut/nagi/issues/new/choose` を開き、Bug report、Feature request、Security の案内の 3 つが出ることを確かめる。

## Worker を独自ドメインに移し、TUI の接続先を移す (R12)

**Depends on.** None. 運用者のドメイン購入を、Build の最初のボックスで待つ。

**Files.**
- [ ] `wrangler.jsonc` に `routes`（`api.usenagi.dev` の custom domain）と `"workers_dev": true` を足す。
- [ ] `tui/src/config.rs` の `DEFAULT_SERVER` を `https://api.usenagi.dev` に変える。`LEGACY_DEFAULT_SERVER` と `Config::migrate_legacy_files` を足し、`mod tests` にテストを足す。
- [ ] `.github/workflows/deploy.yml` の `environment.url` と「本番の応答を確かめる」の `base` を新しい URL にし、古い URL にも同じ確かめを回す。
- [ ] `README.md` の `## 事前準備` の 2 と 5、`### ログインと同期`、`## デプロイ` の URL を直し、古い URL を残す理由を書く。

**Build.**
- [x] Stop until the operator picks `usenagi.dev` and buys it. 運用者が 2026-10-11 に Cloudflare Registrar で買った。RDAP で登録日 2026-10-11T13:46:06Z、期限 2027-10-11、ネームサーバーが `cecelia.ns.cloudflare.com` と `conrad.ns.cloudflare.com` であることを確かめた。
- [ ] 運用者が Cloudflare のダッシュボードで、`api.usenagi.dev` を今の Worker `nagi` の Custom Domain に足す。lane はこの URL を使う。マージ後の `wrangler deploy` は `wrangler.jsonc` の同じ設定でこれを保つ。
- [ ] 運用者が GitHub の OAuth App「nagi」の Homepage URL を `https://usenagi.dev` に変える。デバイスフローは callback を使わないので、ログインの流れは変わらない。
- [ ] `wrangler.jsonc` に `"routes": [{ "pattern": "api.usenagi.dev", "custom_domain": true }]` を書き、`"workers_dev": true` を明示する。更新していない nagi は `https://nagi.wizard1026miya.workers.dev` を見続けるので、この URL は止めない。
- [ ] `pnpm exec wrangler deploy --dry-run` の出力に、custom domain と workers.dev の両方が出ることを確かめる。
- [ ] `Config::new` は、`--server` も `NAGI_SERVER` もないときだけ `migrate_legacy_files` を呼ぶ。`slug(LEGACY_DEFAULT_SERVER)` のファイルがあり、`slug(DEFAULT_SERVER)` の同じ種類のファイルがないときだけ動く。
- [ ] 移すのは `session-nagi.wizard1026miya.workers.dev.json`、`nagi.wizard1026miya.workers.dev.db` と `.db.owner`、`nagi.wizard1026miya.workers.dev--<user>.db`。`.db` は `-wal` と `-shm` も一緒に移す。
- [ ] 移し方は `fs::rename` にする。写すと、ログアウトで新しい方を消したあとに、古い方から黙ってログインし直してしまう。開いたままの古い nagi はトークンをメモリに持っているので、名前が変わっても動き続ける。
- [ ] 控えの `.db` は、移す前に rusqlite で開いて `PRAGMA wal_checkpoint(TRUNCATE)` をかける。移せないときは移さずに `log::error` に残す。控えはカーソル 0 から取り直せるので、失敗してもデータは失われない。
- [ ] セッションのファイルは `fs::rename` で移るので、`write_private` が付けた 0600 の権限のまま残る。
- [ ] `deploy.yml` の確かめは、新しい URL と古い URL の両方に `expect /api/session 401` と `expect /auth/device/token 400` を回す。

**You see.**
- [ ] 前の版でログインしていた人が更新して `nagi` を開くと、ログインの画面は出ず、前と同じ一覧がすぐ出る。
- [ ] `nagi --help` の最後に `https://api.usenagi.dev` が出る。
- [ ] 更新していない nagi は、今までどおり同期する。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `tui/src/config.rs` のテスト。古い slug のセッションと控えだけがある置き場で `migrate_legacy_files` を呼ぶと、`saved_session()` が同じトークンと `user_id` を返し、`db_path(Some(user))` が移した控えを指す。
- [ ] 新しい slug のファイルがすでにあれば、どちらのファイルも書き換えない。
- [ ] `--server` か `NAGI_SERVER` で名指ししたときは、何も移さない。
- [ ] `.db.owner` の印も移り、`db_path(Some(owner))` が移した共有の控えを指す。
- [ ] `clear_token` と `remove_db` のあとに、もう一度 `Config::new(None)` を呼んでもセッションが戻らない。
- [ ] `cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings`、`pnpm check`、`pnpm test` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

運用者は Build のあと、trunk の nagi で `nagi login` を一度行い、その HOME を `/tmp/swarm-R12/seed-home` に残す。各 lane は、この HOME を `scripts/tui-shot.py` の一時 HOME に写してから動かす。画面は 120 x 36 で撮る。

- [ ] Lane 1. Regression lane against trunk. 種の HOME で trunk の nagi と head の nagi を順に開き、今日の一覧を撮る。Save `r12-lane1-today.png`. Pass when 両方ともログインの画面を出さず、今日のタスクの件数と並びが同じ.
- [ ] Lane 2. 移したあとの置き場。head で開いて `q` で閉じ、`scripts/tui-shot.py --cmd 'ls -l ~/.config/nagi ~/.local/share/nagi'` で撮る。Save `r12-lane2-files.png`. Pass when `session-api.usenagi.dev.json` が `-rw-------` で、古い slug の控えが新しい slug の名前で残り、古い slug のファイルが一つもない.
- [ ] Lane 3. 控えを使い直すこと。lane 2 のあと、ネットのない名前空間（`unshare -rn`）で head を開く。Save `r12-lane3-offline.png`. Pass when 移した控えからタスクが出て、下の欄がオフラインを示す.
- [ ] Lane 4. 新しく入れた人。空の HOME で head の `nagi login` を動かす。Save `r12-lane4-login.png`. Pass when `https://github.com/login/device` とコードが出て（`api.usenagi.dev/auth/device/start` が応えた印）、承認前にはセッションのファイルが作られない.
- [ ] Lane 5. 古い URL の名指し。種の HOME で `NAGI_SERVER=https://nagi.wizard1026miya.workers.dev` を付けて head を開く。Save `r12-lane5-legacy-explicit.png`. Pass when 古い slug のセッションでそのまま一覧が出て、新しい slug のファイルが作られない.
- [ ] Lane 6. 二つの URL が同じ Worker であること。`NAGI_TOKEN` に lane 2 のセッションのトークンを入れ、`scripts/tui-shot.py --cmd` で `nagi list today --json` を名指しなしと `--server https://nagi.wizard1026miya.workers.dev` で続けて動かす。Save `r12-lane6-both-hosts.png`. Pass when 二つの JSON が同じ.
- [ ] Lane 7. ログアウト。lane 2 のあとの HOME で head を開き、Ctrl+K から「ログアウト」を選び、閉じてもう一度開く。Save `r12-lane7-logout.png`. Pass when 新旧どちらの slug のセッションも控えも残らず、二度目はこの端末のデータの一覧が出る.
- [ ] Lane 8. 新旧の両方があるとき。lane 2 のあとの HOME に、種の HOME の古い slug のファイルをもう一度写して head を開く。Save `r12-lane8-both-slugs.png`. Pass when head は新しい slug のセッションを使い、古い slug のファイルの `sha256sum` が開く前と同じ.
- [ ] Lane 9. 本番の確かめ。`deploy.yml` の「本番の応答を確かめる」の中身を `base` を新旧それぞれにして、`scripts/tui-shot.py --cmd 'bash smoke.sh'` で動かす。Save `r12-lane9-smoke.png`. Pass when 四つの確かめが順に 401、400、401、400.
- [ ] Lane 10. CLI が先に動くとき。種の HOME で、画面を開く前に head の `nagi add "R12 lane"` を動かし、そのあと画面を開く。Save `r12-lane10-cli-first.png`. Pass when `nagi add` が 0 で終わり、そのときに移す処理が動いていて、画面の一覧に `R12 lane` が出る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 更新した人の最初の起動で、種のタスク名が画面に出るまでの時間。
- [ ] Probe. `scripts/tui-shot.py` で 50 ms ごとに画面を起こし、種の HOME を毎回写し直して 10 回起動し、中央値を取る。
- [ ] Baseline. trunk の nagi で同じ 10 回。trunk は古い slug の控えをそのまま読む。
- [ ] Rule. head の中央値が、trunk の中央値と 100 ms の和以下。超えたら、控えを移せずにカーソル 0 から取り直している。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## ドメインに紹介のページを置く (R13)

**Depends on.** R07, R10, R12.

**Files.**
- [ ] Create `site/wrangler.jsonc`。Worker の名前は `nagi-site`。`assets.directory` は `./public`、`assets.not_found_handling` は `404-page`、`routes` は `usenagi.dev` の custom domain。
- [ ] Create `site/public/index.html`、`site/public/pricing/index.html`、`site/public/privacy/index.html`、`site/public/terms/index.html`、`site/public/legal/index.html`（英語）。
- [ ] Create `site/public/ja/index.html`、`site/public/ja/pricing/index.html`、`site/public/ja/privacy/index.html`、`site/public/ja/terms/index.html`、`site/public/ja/tokushoho/index.html`（日本語）。
- [ ] Create `site/public/404.html`、`site/public/style.css`、`site/public/_headers`。
- [ ] Create `scripts/check-site.mjs`。
- [ ] Create `.github/workflows/site.yml`。
- [ ] `.github/workflows/ci.yml` の `check-and-test` に `node scripts/check-site.mjs` を足す。
- [ ] `.gitignore` に `site/public/*.svg` を足す。
- [ ] `README.md`、`tui/src/cli.rs` の `HELP`、`tui/src/ui/render/overlay.rs` のログインの案内に `https://usenagi.dev` とプライバシーの URL を足す。文は R09 の翻訳の表に ja と en の両方で足す。

**Build.**
- [ ] Stop until the operator approves the 特定商取引法に基づく表記 fields, the contact address, and the price text. 個人の販売者は、住所と電話番号を「請求があれば遅滞なく開示します」と書く形を選べる。運用者がどちらにするかを決める。
- [ ] 置き場は Workers の static assets にする。API と同じ `wrangler` で出せる。静的なファイルの配信は無料で、回数の制限がない。R12 と同じ custom domain の仕組みで `usenagi.dev` を付けられる。Cloudflare は新しい作りに Pages より Workers を勧めている。
- [ ] API の Worker `nagi` とは別の Worker にする。`src/worker/index.test.ts` が確かめている「`/` は 404 の JSON」を崩さないため。
- [ ] 英語を `/`、日本語を `/ja/` に置く。Homebrew と GitHub から来る人の多くが英語を読むため。各ページの `<head>` に `hreflang` の `alternate` を付け、右上に同じページの別の言語へのリンクを置く。自動の振り分けはしない。
- [ ] ページは手で書いた HTML と一枚の CSS にする。JavaScript、外部のフォント、解析のタグは使わない。`_headers` で `Content-Security-Policy` に `default-src 'self'` を入れ、`Strict-Transport-Security` を付ける。
- [ ] 色は R07 で決めた配色の値を `style.css` の CSS 変数に写す。`prefers-color-scheme` で明暗を切り替える。ロゴは `assets/logo-dark.svg`、`assets/logo-light.svg`、`assets/icon.svg` を `site.yml` が `site/public/` に写して使う。
- [ ] トップに、何か（一文と画面の画像）、入れ方（R11 の README と同じコマンド）、ローカルは無料でクラウドは有料であることを書く。
- [ ] 料金のページに、ローカルは無料、クラウドは運用者が承認した月額を書く。R19 が入るまでは申し込みのボタンを置かず「準備中」と書く。
- [ ] プライバシーポリシーに、保存するもの（GitHub のユーザー ID、タスクとプロジェクトの中身、セッションのトークンの SHA-256）、置き場（Cloudflare D1、APAC）、期間（論理削除から 30 日で物理削除）、消し方、連絡先を書く。ローカルのデータは送らないことも書く。
- [ ] 規約に、提供の範囲、禁止事項、上限（R14）、停止と解約、免責、準拠法（日本法）を書く。
- [ ] 特商法の表記は日本語のページに置き、英語の `/legal/` からリンクする。項目は販売業者、運営責任者、所在地、電話番号、メールアドレス、販売価格、支払方法と時期、提供の時期、返品とキャンセルの九つ。
- [ ] `scripts/check-site.mjs` は次を確かめる。en と ja のページが組でそろう。内部のリンクがすべて実在のファイルを指す。各ページに `<html lang>` と `<title>` がある。`<script` がない。特商法のページに九つの項目がある。
- [ ] `site.yml` は `site/**` か `assets/**` が main に入ったら動く。`assets/*.svg` を写し、`pnpm exec wrangler deploy -c site/wrangler.jsonc` を動かし、`curl` で `/`、`/ja/`、`/ja/tokushoho/` が 200 を返すことを確かめる。秘密は `deploy.yml` と同じ `CLOUDFLARE_API_TOKEN` で、environment は `production`。

**You see.**
- [ ] `https://usenagi.dev/` に、ロゴと一文と入れ方のコマンドが出る。
- [ ] 右上のリンクで `/ja/` に移り、同じ中身が日本語で出る。
- [ ] 足もとから料金、プライバシー、規約、特商法の表記に行ける。
- [ ] `nagi --help` とログインの画面に `https://usenagi.dev/privacy/` が出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `node scripts/check-site.mjs` が 0 で終わる。
- [ ] 一時的に `site/public/ja/terms/index.html` を消すと 1 で終わり、欠けたページの名前を出す。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

ページは `pnpm exec wrangler dev -c site/wrangler.jsonc --port 5318` で配る。ブラウザの画面は `chromium --headless=new --window-size=1280,800 --screenshot=<path> <url>` で撮る。端末の出力は `scripts/tui-shot.py --cmd` で撮る。

- [ ] Lane 1. Regression lane against trunk. trunk と head の nagi で `nagi --help` を `scripts/tui-shot.py --cmd 'nagi --help'` で撮る。trunk には `site/` がなく、ページがないことを記録する。Save `r13-lane1-help.png`. Pass when head の help にだけ `https://usenagi.dev` の行が足され、ほかの行は trunk と同じ.
- [ ] Lane 2. 英語のトップを明るい色で撮る。Save `r13-lane2-home-en.png`. Pass when ロゴ、一文、`brew install` のコマンドが最初の画面に収まり、`npx lighthouse http://localhost:5318/ --only-categories=accessibility` に色のコントラストの指摘がない.
- [ ] Lane 3. 日本語のトップを `--force-dark-mode` で撮る。Save `r13-lane3-home-ja-dark.png`. Pass when 背景が暗く、ロゴが `logo-dark.svg` で、アクセントの CSS 変数が R07 の後の `tui/src/ui/theme.rs` のアクセントと同じ値.
- [ ] Lane 4. 料金のページを英語と日本語で撮る。Save `r13-lane4-pricing.png`. Pass when ローカルは無料、クラウドは運用者が承認した額で、申し込みのボタンがなく「準備中」と出る.
- [ ] Lane 5. 日本語のプライバシーポリシーを撮る。Save `r13-lane5-privacy-ja.png`. Pass when 保存するもの三つ、置き場、30 日、ローカルのデータを送らないこと、連絡先が出て、英語の版と見出しの数が同じ.
- [ ] Lane 6. 特商法の表記を撮る。Save `r13-lane6-tokushoho.png`. Pass when 九つの項目がすべて埋まり、空欄も `TBD` もない.
- [ ] Lane 7. 言語の切り替え。`/privacy/` の右上のリンク先と `/ja/privacy/` の右上のリンク先を `curl` で読み、移った先を撮る。Save `r13-lane7-switch.png`. Pass when 同じページの別の言語に移り、トップには戻らず、どちらも 200.
- [ ] Lane 8. 知らない URL とヘッダ。`scripts/tui-shot.py --cmd 'curl -si http://localhost:5318/nope'` で撮る。Save `r13-lane8-404-headers.png`. Pass when 状態が 404 で、本文が `404.html` で、`Content-Security-Policy` と `Strict-Transport-Security` が付き、Chromium のコンソールに CSP の違反が出ない.
- [ ] Lane 9. 狭い画面。`--window-size=375,812` で日本語のトップと料金を撮る。Save `r13-lane9-narrow.png`. Pass when 横にはみ出さず（`document.documentElement.scrollWidth` が 375 以下）、入れ方のコマンドが枠の中で折り返すか横に送れる.
- [ ] Lane 10. TUI のログインの案内。この端末のデータで head を開き、Ctrl+K から「ログイン」を選んで撮る。R10 の切り替えで英語にしてもう一度撮る。Save `r13-lane10-login-privacy.png`. Pass when 両方の言語でプライバシーの URL が一行で出て、120 x 36 の枠からはみ出さない.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 各ページの転送量の合計（HTML、CSS、SVG）と、Lighthouse の performance の点。
- [ ] Probe. `curl -s -o /dev/null -w '%{size_download}'` を各ページとその資産に回して足す。`npx lighthouse http://localhost:5318/ --only-categories=performance` を各ページに 3 回ずつ回し、中央値を取る。
- [ ] Baseline. trunk にはページがない。目標の値（1 ページ 100 KB、点 95）を基準にする。
- [ ] Rule. どのページも合計 100 KB 以下で、performance が 95 以上。

**Review gate.**
- [ ] Copy lane 2, 3, 4 and 6 screenshots into `docs/review/R13-review-home-en.png`, `docs/review/R13-review-home-ja-dark.png`, `docs/review/R13-review-pricing.png`, and `docs/review/R13-review-tokushoho.png`.
- [ ] Record a 30 to 60 second video that walks the English and Japanese pages and save it as `docs/review/R13-review.mp4`.
- [ ] Post the screenshot and the video in chat for the operator. Stop at merge-ready.
- [ ] 運用者（operator）が特商法、プライバシー、規約の文を読んで承認するまで、マージに進まない。

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## Worker に上限と回数制限を入れ、セッションを掃除する (R14)

**Depends on.** None.

**Files.**
- [ ] `src/shared/mutations.ts` と `src/shared/mutations.test.ts`（文字列と配列の `.max()`、上限の定数）。
- [ ] `src/shared/api.ts`（`InvalidRequestReason` に `quota_exceeded`、`ApiErrorResponse` に `rate_limited` と `payload_too_large`）。
- [ ] `src/worker/sync/mutate.ts` と `src/worker/sync/mutate.test.ts`（`MAX_TASKS_PER_USER`、`MAX_PROJECTS_PER_USER`）。
- [ ] Create `src/worker/rate-limit.ts` と `src/worker/rate-limit.test.ts`。
- [ ] `src/worker/index.ts` と `src/worker/index.test.ts`（`bodyLimit`、`secureHeaders`、`Cache-Control`、回数制限、`scheduled`）。
- [ ] `src/worker/auth/session.ts` と `src/worker/auth/session.test.ts`（`sweepExpiredSessions`）。
- [ ] `src/worker/env.d.ts`、`wrangler.jsonc`（`ratelimits`、`triggers.crons`）。
- [ ] `tui/src/model.rs`（同じ上限の定数）、`tui/src/data/store.rs`（`is_well_formed` と `Failure::TooLong`）、`tui/src/data/net.rs`（429）、`tui/src/auth.rs`（ログインの 429 の文）、`tui/src/ui/app.rs`（上限の文）、`tui/src/data/tests.rs`。
- [ ] `README.md`（上限と回数制限の表、Cloudflare のトークンの権限）。

**Build.**
- [ ] Stop until the operator moves the Cloudflare account to Workers Paid and replaces `CLOUDFLARE_API_TOKEN` with a token limited to the `nagi` Worker and the `nagi` D1. 権限は Workers Scripts の Edit、D1 の Edit、R12 が入っていれば Workers Routes の Edit だけにする。
- [ ] 先に本番の今の最大値をはかる。`pnpm exec wrangler d1 execute nagi --remote --command "SELECT max(length(title)), max(length(memo)), max(json_array_length(checklist)) FROM tasks"`。上限より大きい値があれば、上限をその値より上にする。
- [ ] 上限は `src/shared/mutations.ts` の定数にする。`MAX_TITLE_LENGTH = 500`、`MAX_MEMO_LENGTH = 20000`、`MAX_CHECKLIST_ITEMS = 200`、`MAX_CHECKLIST_ITEM_LENGTH = 500`、`MAX_PROJECT_NAME_LENGTH = 100`。長さは JavaScript の `length`（UTF-16 の単位）で数える。
- [ ] 利用者ごとの行の上限は `MAX_TASKS_PER_USER = 20000` と `MAX_PROJECTS_PER_USER = 500`。論理削除の行も数える（30 日で消える）。`loadFacts` で件数も読み、超えるなら最初の作成の位置で `quota_exceeded` を返す。
- [ ] 同時の書き込みに備え、`applyMutationBatch` のバッチの最後に、件数が上限を超えたら `meta.seq` に NULL を入れる守りを置く。`requireExistingRows` と同じ形で、超えたらバッチ全体が戻る。
- [ ] 本文の上限。`hono/body-limit` の `bodyLimit` を `/api/*` に 1 MiB、`/auth/*` に 4 KiB でかける。超えたら 413 の `payload_too_large`。
- [ ] 回数制限。`wrangler.jsonc` の `ratelimits` に三つの binding を足す。`AUTH_START_LIMITER` は `/auth/device/start` に IP ごと 60 秒で 5 回。`AUTH_POLL_LIMITER` は `/auth/device/token` と `/auth/logout` に IP ごと 60 秒で 30 回（5 秒ごとのポーリングは 12 回）。`API_LIMITER` は `/api/*` に利用者ごと 60 秒で 600 回。
- [ ] IP は `CF-Connecting-IP` を使い、ないとき（`pnpm dev`）は `local`。`/api/*` の制限は `requireSession` のあとにかけ、鍵は利用者の ID。超えたら 429 の `rate_limited` と `Retry-After: 60` を返す。
- [ ] `hono/secure-headers` の `secureHeaders()` を全体にかけ、`/api/*` と `/auth/*` の応答に `Cache-Control: no-store` を付ける。
- [ ] `session.ts` に `sweepExpiredSessions(db, now)` を足す。`DELETE FROM user_sessions WHERE id IN (SELECT id FROM user_sessions WHERE expires_at < ? LIMIT 1000)` を、消える行がなくなるまで繰り返す。
- [ ] `index.ts` の既定の出力を `{ fetch, scheduled }` にし、`scheduled` で `ctx.waitUntil(sweepExpiredSessions(...))` を呼ぶ。`wrangler.jsonc` の `triggers.crons` に `"17 19 * * *"`（日本時間 4 時 17 分）を足す。
- [ ] TUI は同じ上限を `tui/src/model.rs` に持つ。`is_well_formed` は `encode_utf16().count()` で長さを確かめ、超えたら送らずに `Failure::TooLong` を返す。画面は「タイトルは 500 文字まで」のように出す。ローカルも同じ道を通るので、R18 でクラウドへ移せない行はできない。
- [ ] `net.rs` は 429 を `ApiFailure::Server(429)` にする。同じ ID で 2 回まで再送される。`auth.rs` はログインの 429 に「試行が多すぎます。1 分待ってください」を出す。`quota_exceeded` は `Rejected` のまま、画面に件数の上限を出す。

**You see.**
- [ ] 501 文字のタイトルを貼ると、保存されずに「タイトルは 500 文字まで」と出る。
- [ ] タスクが 20000 件ある人が足すと「タスクは 20000 件まで」と出て、表示は足す前に戻る。
- [ ] ふつうの使い方では何も変わらない。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `src/shared/mutations.test.ts`。各上限ちょうどは通り、1 つ超えると `schema` で落ちる。
- [ ] `src/worker/sync/mutate.test.ts`。上限まで 1 件の利用者が 2 件足すと `quota_exceeded` で何も書かれず、ほかの利用者の件数は数えない。
- [ ] `src/worker/rate-limit.test.ts`。binding を差し替え、`success: false` で 429 と `Retry-After` が返る。
- [ ] `src/worker/index.test.ts`。1 MiB を超える本文で 413。応答に `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` がある。
- [ ] `src/worker/auth/session.test.ts`。期限切れだけが消え、2500 行でも全部消える。
- [ ] `tui/src/data/tests.rs`。上限を超えるタイトルと 201 個のチェックリストを、送らずに `Failure::TooLong` で断る。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

Worker は `pnpm dev --test-scheduled` で起動する（`AUTH_DISABLED=true`、利用者は `owner`）。二人を使う lane は `--var AUTH_DISABLED:false --var SIGNUP:open` を足し、利用者を `pnpm exec wrangler d1 execute nagi --local --command` で作る。`users` に 1 行、`meta` に `seq`、`last_rollover_on`、`purged_through_seq` の 3 行、`user_sessions` に 1 行を入れ、`user_sessions.id` はトークンの `sha256sum` の値にする。TUI は `NAGI_SERVER=http://localhost:5317` と `NAGI_TOKEN` で開く。`wrangler dev` が ratelimits の binding を真似ない場合 [INFERENCE]、lane 5 から 7 は R21 の staging で動かす。

- [ ] Lane 1. Regression lane against trunk. trunk と head の Worker と nagi で、TUI からタスクを 3 件足し、1 件にメモを書き、1 件を完了にする。Save `r14-lane1-basic.png`. Pass when 両方で同じ一覧になり、保存の失敗の知らせが出ない.
- [ ] Lane 2. 長すぎるタイトル。TUI の追加欄に 501 文字を貼って Enter を押す。続けて同じ形を `scripts/tui-shot.py --cmd 'curl -si -X POST ... /api/mutate'` で送る。Save `r14-lane2-title.png`. Pass when head の TUI は送らずに上限の文を出し、curl は 400 の `schema`。trunk では保存されることを記録する.
- [ ] Lane 3. 行の上限。`node scripts/seed-local.mjs fill 19999` のあと、TUI から 2 件足す。Save `r14-lane3-quota.png`. Pass when 1 件目は保存され、2 件目で「タスクは 20000 件まで」が出て、`SELECT COUNT(*) FROM tasks` が 20000.
- [ ] Lane 4. 上限はほかの人に効かない。lane 3 のあと、二人目の利用者で TUI を開いて 1 件足す。Save `r14-lane4-other-user.png`. Pass when 二人目の追加が保存され、知らせが出ない.
- [ ] Lane 5. ログインの回数制限。`scripts/tui-shot.py --cmd` で `curl` を `/auth/device/start` に 6 回続けて送り、そのあと TUI のログインの画面を開く。Save `r14-lane5-auth-429.png`. Pass when 6 回目が 429 で `Retry-After: 60` が付き、TUI は「1 分待ってください」を出して落ちない.
- [ ] Lane 6. ポーリングは止まらない。TUI でログインを始め、承認せずに 3 分待つ。Save `r14-lane6-polling.png`. Pass when 画面はコードを出したまま待ち続け、`pnpm dev` のログに 429 が一つもない.
- [ ] Lane 7. API の回数制限。`curl` の繰り返しで `/api/sync` に 60 秒で 601 回送り、すぐ二人目のトークンで 1 回送り、61 秒後に一人目の TUI を開く。Save `r14-lane7-api-429.png`. Pass when 601 回目だけが 429、二人目は 200、61 秒後の TUI は同期できる.
- [ ] Lane 8. 本文の上限。`scripts/tui-shot.py --cmd` で、1 MiB と 1 バイトの本文を `/api/mutate` に、5 KiB の本文を `/auth/device/token` に送る。Save `r14-lane8-413.png`. Pass when 両方とも 413 の `payload_too_large` で、D1 の行が変わらない.
- [ ] Lane 9. ヘッダ。`scripts/tui-shot.py --cmd 'curl -si localhost:5317/api/session; curl -si -X POST -H "Content-Type: application/json" -d "{}" localhost:5317/auth/device/token'` で撮る。Save `r14-lane9-headers.png`. Pass when 両方に `Cache-Control: no-store` と `X-Content-Type-Options: nosniff` があり、本文は今までと同じ JSON.
- [ ] Lane 10. セッションの掃除。期限切れのセッションを 3 つ、有効なものを 1 つ入れ、`curl "localhost:5317/__scheduled?cron=17+19+*+*+*"` を呼び、有効なトークンと期限切れのトークンで TUI を開く。Save `r14-lane10-sweep.png`. Pass when `user_sessions` に有効な 1 行だけが残り、有効なトークンの TUI は同期し、期限切れの方はログインの画面を出す.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. `POST /api/mutate`（`task.update` 1 件）の p95 の時間と、期限切れ 10000 行の掃除にかかる時間。
- [ ] Probe. `pnpm dev` に `curl -w '%{time_total}'` で 300 回を順に送り、p50 と p95 を出す。掃除は 10000 行を入れて `__scheduled` を `curl` で呼び、`time_total` を取る。
- [ ] Baseline. trunk の Worker で同じ 300 回。掃除は trunk にないので、目標の 10 秒を基準にする。
- [ ] Rule. head の p95 が、trunk の p95 の 1.1 倍と 3 ms の和以下。10000 行の掃除が 10 秒以内に終わる。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## TUI と Worker の版がずれても変更を失わない (R15)

**Depends on.** None.

**Files.**
- [ ] `src/shared/api.ts`（`MIN_API_VERSION`、版の決まりの説明、`ApiErrorResponse` の `api_version_unsupported` と `api_version_too_new`）と `src/shared/api.test.ts`。
- [ ] `src/worker/sync/routes.ts`（`requireApiVersion` を範囲で見る）と `src/worker/sync/mutate.test.ts`（今の 409 のテストを直す）。
- [ ] `tui/src/data/net.rs`、`tui/src/data/store.rs`、`tui/src/data/replica.rs`（`PendingBatch` と `OperationKind` に `Serialize` と `Deserialize`）、`tui/src/data/local_db.rs`（`pending` の表）、`tui/src/data/tests.rs`。
- [ ] Create `tui/src/upgrade.rs`（入れ方ごとの更新のコマンド）。`tui/src/main.rs` に `mod upgrade` を足す。
- [ ] `tui/src/ui/app.rs`、`tui/src/ui/render/mod.rs`、`tui/src/ui/login.rs`、`tui/src/cli.rs`。
- [ ] `README.md`（版の決まり）。

**Build.**
- [ ] 版の決まりを `src/shared/api.ts` に書く。Worker は `MIN_API_VERSION` から `API_VERSION` までを受ける。`API_VERSION` は形を足すときに上げ、範囲の中の古い形も受け続ける。`MIN_API_VERSION` は、新しい版の TUI を出して Homebrew の tap が更新されてから 90 日たつまで上げない。今は両方 3。
- [ ] `requireApiVersion` は `X-Api-Version` を整数で読む。ない、読めない、`MIN_API_VERSION` より小さいときは 409 の `api_version_unsupported` で、本文に `minApiVersion`、`apiVersion`、Release の URL を入れる。
- [ ] 状態は 426 にせず 409 のままにする。出回っている nagi は `net.rs` で 409 だけを「更新が要る」と読むため。426 にすると、古い nagi は `Rejected` と読み、止まらずに変更を捨て続ける。
- [ ] `API_VERSION` より大きいときは 409 の `api_version_too_new`。TUI が先に出て、Worker の deploy がまだのとき。
- [ ] `net.rs` は 409 の本文を読み、`ApiFailure::VersionMismatch` を `UpgradeRequired { min_api_version }` と `ServerBehind` に分ける。
- [ ] `UpgradeRequired` のとき、`store.rs` は `discard_pending` を呼ばない。送信と同期を止め、送っていないまとまりを表示に残し、`LocalDb::save_pending` で `pending` の表に書く。知らせは `Notice::UpgradeRequired { kept }` にし、`app.rs` の `restore_drafts` の分岐を消す。
- [ ] `ServerBehind` のときは止めない。まとまりを列に残して `is_online` を false にし、8 秒ごとの同期（`OFFLINE_RETRY_INTERVAL`）が通ったら送り直す。下の欄に「Worker の更新を待っています」と出す。
- [ ] `local_db.rs` は `pending` の表を `CREATE TABLE IF NOT EXISTS` で作る。版の確かめとは別にするので、控えは取り直しにならない。`FORMAT_VERSION` を変えたときに消す表に `pending` を入れない。
- [ ] 起動のとき、`Store::new` は `pending` の表のまとまりを列に戻し、最初の同期のあとに送る。確定したまとまりは表から 1 つずつ消す。CLI も同じストアを通るので、更新後の最初の `nagi` のコマンドで送られる。
- [ ] 401 のときは今までどおり捨てる。ログインし直す相手が同じ利用者とは限らないため。
- [ ] `upgrade.rs` の `upgrade_command()` は `std::env::current_exe()` の実際の場所を見る。`/Cellar/` を含めば `brew upgrade nagi`、それ以外は `https://github.com/myksyut/nagi/releases/latest`。R05 と R15 のうち後に入るほうが、Windows の入れ方の分岐を足す。
- [ ] 下の欄（`render/mod.rs`）と CLI（`cli.rs` の `StopReason::VersionMismatch` の文）は「nagi を更新してください。`brew upgrade nagi`。送っていない変更 3 件は残してあります」の形にする。
- [ ] `pending` に行があるときのログアウトは、一度「送っていない変更が 3 件あります。ログアウトすると消えます」と出し、もう一度選んだときだけ消す。

**You see.**
- [ ] Worker が先に新しくなっても、打った変更は画面に残り、下の欄に更新のコマンドが出る。
- [ ] nagi を更新して開くと、残っていた変更が送られる。
- [ ] nagi が先に新しくなったときは、止まらずに「Worker の更新を待っています」と出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `src/worker/sync/mutate.test.ts`。版 2 とヘッダなしは 409 の `api_version_unsupported` で `minApiVersion` が 3。版 4 は 409 の `api_version_too_new`。版 3 は 200。どの 409 でも行が変わらない。
- [ ] `src/shared/api.test.ts`。`MIN_API_VERSION` が `API_VERSION` 以下。`tui/src/model.rs` を文字として読み、その `API_VERSION` が TypeScript の `API_VERSION` と同じ。
- [ ] `tui/src/data/tests.rs`。`UpgradeRequired` で列が残り、`stopped_by` が立ち、`LocalDb` の `pending` に同じまとまりが入る。`ServerBehind` では止まらず、同期が通ったあとに同じ ID で送り直す。401 では今までどおり捨てる。
- [ ] `tui/src/data/local_db.rs` のテスト。`pending` の書き込みと読み出しが順を保ち、確定したまとまりだけが消える。
- [ ] `tui/src/upgrade.rs` のテスト。`/opt/homebrew/Cellar/nagi/1.0.0/bin/nagi` は `brew upgrade nagi`、`/home/u/bin/nagi` は Release の URL。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

Worker は `pnpm dev --persist-to /tmp/swarm-R15/state`（`AUTH_DISABLED=true`）で起動し、版を替えるときも同じ D1 を使う。版をずらす lane は、lane 用の作業ツリーで定数だけを変えてビルドし、コミットしない。`MIN4` の Worker は `src/shared/api.ts` の `API_VERSION` と `MIN_API_VERSION` を 4 にしたもの。`V4` の nagi は `tui/src/model.rs` の `API_VERSION` を 4 にしたもの。TUI は `NAGI_SERVER=http://localhost:5317` で開く。

- [ ] Lane 1. Regression lane against trunk. trunk の Worker と nagi、head の Worker と nagi の組で、タスクを 2 件足し、1 件にメモを書く。Save `r15-lane1-basic.png`. Pass when 両方で同じ一覧になり、知らせが出ない.
- [ ] Lane 2. 出回っている nagi。trunk の nagi を `MIN4` の Worker で開いてタスクを 1 件足す。Save `r15-lane2-trunk-stops.png`. Pass when trunk の nagi は「新しいバージョンがあります」を出して止まり、エラーを繰り返さない（状態を 409 のままにした確かめ）.
- [ ] Lane 3. 版が古くなった瞬間。head の nagi を head の Worker で開いたまま、Worker を `MIN4` に替え、タスクを 2 件足し、1 件のメモを書き換える。Save `r15-lane3-kept.png`. Pass when 3 つの変更が画面に残り、下の欄に更新のコマンドと「送っていない変更 3 件」が出る.
- [ ] Lane 4. 閉じても残る。lane 3 のあと `q` で閉じ、もう一度開いて撮り、`scripts/tui-shot.py --cmd 'sqlite3 ~/.local/share/nagi/localhost_5317.db "SELECT COUNT(*) FROM pending"'` も撮る。Save `r15-lane4-reopen.png`. Pass when 3 つの変更が画面にあり、件数が 3.
- [ ] Lane 5. 更新したあと。lane 4 の HOME で `V4` の nagi を `MIN4` の Worker で開く。Save `r15-lane5-upgraded.png`. Pass when 3 つの変更が送られ、`pending` が 0 件になり、`curl` の `/api/sync` に同じ行がある.
- [ ] Lane 6. nagi が先に新しいとき。`V4` の nagi を head の Worker で開いてタスクを 1 件足し、30 秒後に Worker を `MIN4` に替える。Save `r15-lane6-server-behind.png`. Pass when 替える前は「Worker の更新を待っています」と出て止まらず、替えたあと 8 秒以内にその 1 件が送られる.
- [ ] Lane 7. Homebrew で入れた人。head の nagi を一時的な `homebrew/Cellar/nagi/1.0.0/bin/nagi` に置き、`MIN4` の Worker で開く。Save `r15-lane7-brew.png`. Pass when 下の欄に `brew upgrade nagi` が出る.
- [ ] Lane 8. 手で入れた人。head の nagi を一時的な `bin/nagi` に置き、`MIN4` の Worker で開く。Save `r15-lane8-direct.png`. Pass when 下の欄に `https://github.com/myksyut/nagi/releases/latest` が出る.
- [ ] Lane 9. CLI。`MIN4` の Worker に `scripts/tui-shot.py --cmd 'nagi add "R15 cli"; echo exit=$?'` を動かす。Save `r15-lane9-cli.png`. Pass when 終了コードが 1 で、文に更新のコマンドと「変更は残してあります」があり、`pending` が 1 件.
- [ ] Lane 10. 残した変更があるときのログアウト。lane 4 の HOME で Ctrl+K の「ログアウト」を一度選び、Esc で閉じる。Save `r15-lane10-logout-guard.png`. Pass when 一度目は消える件数の警告だけが出て、`pending` とセッションのファイルが残る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 起動から最初の一覧が出るまでの時間。`pending` が 0 件のときと 200 件のとき。
- [ ] Probe. `scripts/tui-shot.py` で 50 ms ごとに画面を起こし、10 回の中央値を取る。200 件は lane 3 の手順を 200 回の追加で作る。
- [ ] Baseline. trunk の nagi で、同じ控えから起動する 10 回の中央値。
- [ ] Rule. 0 件で trunk と 20 ms の和以下、200 件で trunk と 100 ms の和以下。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## クラウドの日付の切り替えを利用者のタイムゾーンにする (R16)

**Depends on.** None.

**Files.**
- [ ] `src/worker/db/schema.ts` の `users` に `timeZone: text("time_zone")` を足し、`pnpm db:generate --name user_time_zone` で `migrations/0005_user_time_zone.sql`、`migrations/meta/0005_snapshot.json`、`migrations/meta/_journal.json` を作る。
- [ ] Create `src/worker/db/migration-0005.test.ts`。`vitest.config.ts` に `MIGRATION_0005_TEST_DB` を足す。
- [ ] Create `src/shared/time-zone.ts`（`timeZoneSchema`）と `src/shared/time-zone.test.ts`。
- [ ] `src/shared/api.ts`（`SyncResponse` に `timeZone`）、`src/shared/logical-date.ts`（説明）。
- [ ] `src/worker/auth/session.ts`、`src/worker/auth/middleware.ts`、`src/worker/types.ts`（`Variables` に `timeZone`）、`src/worker/auth/routes.ts`、`src/worker/auth/users.ts`、`src/worker/auth/routes.test.ts`。
- [ ] `src/worker/sync/routes.ts`（`/sync` と `POST /time-zone`）、`src/worker/sync/rollover.test.ts`、`src/worker/sync/isolation.test.ts`。
- [ ] `tui/src/config.rs`（`Session` に `time_zone`）、`tui/src/auth.rs`、`tui/src/model.rs`（`SyncResponse` に `time_zone`）、`tui/src/data/net.rs`、`tui/src/data/store.rs`（`set_time_zone`）、`tui/src/data/mod.rs`、`tui/src/dates.rs`、`tui/src/ui/app.rs`、`tui/src/data/tests.rs`。
- [ ] `README.md`（日付の切り替えの説明）。

**Build.**
- [ ] `users.time_zone` は NULL を許す。NULL は `APP_TIMEZONE`（`Asia/Tokyo`）として扱うので、今の利用者の切り替えは変わらない。
- [ ] `timeZoneSchema` は 64 文字までの文字列で、`new Intl.DateTimeFormat("en-US", { timeZone })` が投げない名前だけを通す。
- [ ] `/auth/device/token` の本文（`deviceTokenRequestSchema`）に省略できる `timeZone` を足す。`status` が `ok` になるときだけ、その利用者の `time_zone` に書く。
- [ ] `POST /api/time-zone` を足す。本文は `{ "timeZone": "Europe/Berlin" }`。書いたら 200 で同じ形を返し、読めない名前は 400 の `schema`。
- [ ] `validateSession` は `users.time_zone` も同じ問い合わせで読み、`requireSession` が `c.set("timeZone", ...)` を呼ぶ。`AUTH_DISABLED` のときは `OWNER_USER_ID` の行を読む。
- [ ] `/api/sync` は `rolloverIfDue(db, userId, now(), c.get("timeZone") ?? c.env.APP_TIMEZONE)` を呼び、各ページに `timeZone` を付ける。古い nagi は知らない項目を読み飛ばす（`tui/src/model.rs` の `SyncResponse` に `deny_unknown_fields` がない）。
- [ ] ゾーンを西へ変えて論理日付が戻るときは、`last_rollover_on` が今日以上なので何もしない。東へ変えて進むときは、次の同期で切り替える。`isDue` の条件は同じなので、二重には移さない。
- [ ] TUI はログインのときに `device_time_zone()` の名前を送り、`Session.time_zone` に保存する。古いセッションのファイルも読めるよう `#[serde(default)]` にする。
- [ ] 起動のときと 45 秒ごとの同期のときに `device_time_zone()` を読み、保存した名前と違えば `POST /api/time-zone` を送って保存し、「タイムゾーンを Europe/Berlin にしました」とトーストで出す。`NAGI_TOKEN` で動くときは送らない（自動の実行が利用者のゾーンを変えないため）。
- [ ] クラウドのストアの `tz` は保存した名前で始め、なければ `APP_TIME_ZONE`。同期の応答の `timeZone` で `Store::set_time_zone` を呼ぶ。`set_time_zone` は `refresh_day` と同じ流れで `today` を計算し直す。`tui/src/data/mod.rs` の `tz: APP_TIME_ZONE` とコメント「利用者ごとの設定は、まだない」を直す。
- [ ] 端末が二台でゾーンが違うときは、最後に自分のゾーンが変わった端末のゾーンになる。どちらの画面も同期の応答のゾーンで「今日」を出すので、Worker と画面の日付はずれない。README に書く。

**You see.**
- [ ] ロサンゼルスの端末でログインすると、日付はロサンゼルスの午前 4 時に変わる。
- [ ] 端末のゾーンが変わると「タイムゾーンを Europe/Berlin にしました」と出る。
- [ ] 日本の利用者とローカルの利用者には、何も変わらない。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `src/shared/time-zone.test.ts`。`Asia/Tokyo` と `America/Los_Angeles` は通り、`Mars/Base` と 65 文字は落ちる。
- [ ] `src/worker/sync/rollover.test.ts`。同じ時刻で、`Pacific/Pago_Pago` の利用者は日本の今日に予定したタスクを移さず、`time_zone` が NULL の利用者は移す。
- [ ] `src/worker/db/migration-0005.test.ts`。0004 まで当てた D1 に行を入れ、0005 を当てても行が残り、`time_zone` が NULL。
- [ ] `src/worker/auth/routes.test.ts`。`timeZone` を付けたログインで列に入り、付けないログインでは変わらない。読めない名前は 400。
- [ ] `src/worker/sync/isolation.test.ts`。利用者 A の `POST /api/time-zone` が B の列を変えない。
- [ ] `tui/src/data/tests.rs`。同期の応答の `timeZone` で `store.today` が変わる。`tui/src/config.rs` のテストで、`time_zone` のない古いセッションのファイルが読める。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

Worker は `pnpm dev --var AUTH_DISABLED:false --var SIGNUP:open` で起動し、利用者は R14 と同じく `pnpm exec wrangler d1 execute nagi --local --command` で作る。TUI の HOME には `~/.config/nagi/session-localhost_5317.json` を `{"token":"...","user_id":"..."}` の形で置き、`NAGI_SERVER=http://localhost:5317` で開く。lane は日本時間の 4 時から 24 時のあいだに動かす（`Pacific/Pago_Pago` の論理日付が日本より 1 日前になる時間）。期待する日付は `TZ=<zone> date -d '-4 hours' +%F` で出す。タスクは `curl` で `/api/mutate` に入れる。

- [ ] Lane 1. Regression lane against trunk. `time_zone` が NULL の利用者に、日本の今日に予定したタスクを入れ、`TZ=Asia/Tokyo` で trunk と head の nagi を開く。Save `r16-lane1-tokyo.png`. Pass when 両方でタスクが「今日」にあり、見出しの日付が同じ.
- [ ] Lane 2. 西の利用者。日本の今日に予定したタスクを入れ、`TZ=Pacific/Pago_Pago` で head を開く。Save `r16-lane2-pago.png`. Pass when タスクは「予定」に残り、見出しが Pago Pago の論理日付で、`SELECT time_zone FROM users` が `Pacific/Pago_Pago`。trunk なら今日へ移ることを記録する.
- [ ] Lane 3. 西の利用者の今日。Pago Pago の今日に予定したタスクを足し、45 秒の同期を待つ。Save `r16-lane3-pago-today.png`. Pass when タスクが「今日」に移り、`arrivedOn` が Pago Pago の論理日付.
- [ ] Lane 4. 端末のゾーンが変わる。lane 2 の HOME で `TZ=Europe/Berlin` を付けて head を開き直す。Save `r16-lane4-berlin.png`. Pass when 「タイムゾーンを Europe/Berlin にしました」と出て、D1 の列とセッションのファイルの `time_zone` が `Europe/Berlin`.
- [ ] Lane 5. 二台の端末。同じ利用者の二つの HOME を、A は `Asia/Tokyo`、B は `Pacific/Pago_Pago` で保存済みにする。A を最後にログインした端末として列を `Asia/Tokyo` にし、B を開く。Save `r16-lane5-two-devices.png`. Pass when B は日本の論理日付を見出しに出し、D1 の列は `Asia/Tokyo` のまま変わらない.
- [ ] Lane 6. 自動の実行。`TZ=Europe/London` と `NAGI_TOKEN` を付けて `scripts/tui-shot.py --cmd 'nagi list today --json'` を動かす。Save `r16-lane6-cli-token.png`. Pass when D1 の列が変わらず、JSON の今日は列のゾーンの論理日付で決まっている.
- [ ] Lane 7. 読めない名前。`scripts/tui-shot.py --cmd` で `{"timeZone":"Mars/Base"}` を `POST /api/time-zone` に送る。Save `r16-lane7-invalid.png`. Pass when 400 の `schema` が返り、列が変わらない.
- [ ] Lane 8. 東へ変えて日付が進む。Pago Pago の利用者で `last_rollover_on` を Pago Pago の今日にし、日本の今日に予定したタスクを入れ、`TZ=Asia/Tokyo` で開き直す。Save `r16-lane8-east.png`. Pass when タスクが一度だけ「今日」に移り、`last_rollover_on` が日本の論理日付になる.
- [ ] Lane 9. 西へ変えて日付が戻る。日本の利用者で今日の切り替えを済ませ、「今日」にタスクがある状態で `TZ=Pacific/Pago_Pago` で開き直す。Save `r16-lane9-west.png`. Pass when どの行も動かず、`last_rollover_on` が変わらず、見出しが Pago Pago の論理日付.
- [ ] Lane 10. ローカルは変わらない。ログインしていない HOME で `TZ=Pacific/Pago_Pago` を付けて trunk と head を開く。Save `r16-lane10-local.png`. Pass when 両方の見出しが Pago Pago の論理日付で同じ.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. `POST /api/sync`（1 ページ、切り替えなし）の p95 の時間。
- [ ] Probe. `pnpm dev` にトークン付きの `curl -w '%{time_total}'` で 300 回を順に送り、p50 と p95 を出す。
- [ ] Baseline. trunk の Worker で同じ 300 回。
- [ ] Rule. head の p95 が、trunk の p95 の 1.1 倍と 2 ms の和以下。ゾーンはセッションの確認と同じ問い合わせで読むので、問い合わせは増えない。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## クラウドのアカウントを消せ、データを書き出せるようにする (R17)

**Depends on.** R06.

**Files.**
- [ ] Create `src/worker/account/routes.ts`（`DELETE /api/account`、`GET /api/export`）と `src/worker/account/routes.test.ts`。
- [ ] Create `src/worker/account/delete.ts`（`deleteAccount`）と `src/worker/account/export.ts`（`exportAccount`）。
- [ ] Create `src/shared/export.ts`（R06 の `nagi export` と同じ形の `exportSchema`）と `src/shared/export.test.ts`。R18 が先に入っていれば、その `src/shared/export.ts` を使う。
- [ ] `src/worker/index.ts`（`app.route("/api", accountRoutes)`）と `src/worker/sync/isolation.test.ts`。
- [ ] `tui/src/data/net.rs`（`delete_raw`）、`tui/src/cli.rs`（クラウドの `nagi export`、`nagi account delete`）、`tui/src/ui/keys.rs`（Ctrl+K の「アカウントを削除」）、`tui/src/ui/render/overlay.rs`（確かめの画面）、`tui/src/ui/login.rs`（`App::delete_account`）。
- [ ] `README.md`（消し方と書き出し方）。

**Build.**
- [ ] `DELETE /api/account` は本文 `{ "confirm": "<userId>" }` を受ける。`userId` が今の利用者と違えば 400 で、何も消さない。`requireSameOriginJson` は DELETE にも JSON を求めるので、本文を付ける形でそのまま通る。
- [ ] 消すのは 1 回の `db.batch` にする。順に `tasks`、`projects`、`applied_mutations`、`meta`、`user_sessions`、`users` の、その利用者の行。外部キーが `ON DELETE no action` なので、子の表から消す。成功したら 204。
- [ ] 持ち主の行（`OWNER_USER_ID`）も同じに消す。次に同じ GitHub でログインすると、`resolveUser` の持ち主の分岐は行がないので外れ、新しい利用者が作られる。
- [ ] `GET /api/export` は R06 の形で返す。論理削除の行は入れない。`Content-Disposition` に `attachment; filename="nagi-export-<date>.json"` を付ける。行は `seq` の順に 1000 行ずつ読む。
- [ ] CLI の `nagi export` は、クラウドのときに `GET /api/export` を呼ぶ。ローカルのときは R06 のまま。`--output` の扱いも R06 と同じ。
- [ ] CLI の `nagi account delete` は、先にタスクとプロジェクトの件数と「先に `nagi export` で書き出せます」を出し、`delete` と打たせる。`--yes` があれば聞かない。成功したら `Config::clear_token` と `Config::remove_db` を呼ぶ。
- [ ] TUI は `tui/src/ui/keys.rs` に「アカウントを削除」を足す（クラウドのときだけ出す）。確かめの画面は件数と書き出しの案内を出し、`delete` と打つまで消さない。通信はログアウトと同じく別のスレッドで行い、204 が返ってから手元を消し、`logout` と同じ流れでこの端末のデータに戻って「クラウドのアカウントを消しました」と出す。
- [ ] ローカルのデータ（`local.db`）には触れない。

**You see.**
- [ ] `nagi export --output nagi.json` で、クラウドの全部が一つの JSON になる。
- [ ] `nagi account delete` が件数を出し、`delete` と打つと消える。
- [ ] TUI の Ctrl+K から同じことができ、消したあとはこの端末の一覧に戻る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `src/worker/account/routes.test.ts`。消したあと、その利用者の行が 6 つの表のどこにも残らず、ほかの利用者の行の数は変わらない。
- [ ] 確かめの `userId` が違うと 400 で、何も消えない。消したあとの同じトークンは 401。
- [ ] `GET /api/export` の応答が `exportSchema` で読め、論理削除の行を含まない。
- [ ] `src/shared/export.test.ts`。R06 の `nagi export` の見本の JSON が `exportSchema` で読める。
- [ ] `tui/src/cli.rs` のテスト。`account delete`、`account delete --yes`、`export --output` を読み、`account` の知らない続きを断る。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

Worker は `pnpm dev --var AUTH_DISABLED:false --var SIGNUP:open` で起動し、利用者 A と B を R14 と同じ手順で作る。HOME に `session-localhost_5317.json` を置き、`NAGI_SERVER=http://localhost:5317` で開く。A には `curl` で 30 件のタスク、3 つのプロジェクト、論理削除の 2 件を入れる。

- [ ] Lane 1. Regression lane against trunk. A の HOME で trunk と head の nagi を開き、Ctrl+K を開いて撮る。trunk には「アカウントを削除」と `nagi account delete` がないことを記録する。Save `r17-lane1-palette.png`. Pass when 一覧は両方で同じで、head の Ctrl+K にだけ「アカウントを削除」がある.
- [ ] Lane 2. 書き出し。`scripts/tui-shot.py --cmd 'nagi export --output a.json && jq ".tasks | length" a.json'` を動かす。Save `r17-lane2-export.png`. Pass when 件数が `SELECT COUNT(*) FROM tasks WHERE user_id = 'A' AND deleted_at IS NULL` と同じ.
- [ ] Lane 3. ローカルと同じ形。ログインしていない HOME で R06 の `nagi export` を動かし、lane 2 の JSON とキーの集まりを `jq '[paths | map(tostring) | join(".")] | unique'` で比べる。Save `r17-lane3-shape.png`. Pass when 値の違いを除いて、キーの集まりが同じ.
- [ ] Lane 4. 打ち間違い。`nagi account delete` で `no` と打つ。Save `r17-lane4-cancel.png`. Pass when 何も消えず、終了コードが 1 で、セッションのファイルが残る.
- [ ] Lane 5. CLI で消す。`nagi account delete` で `delete` と打つ。Save `r17-lane5-cli-delete.png`. Pass when A の行が 6 つの表に残らず、B の行の数が変わらず、A のセッションと控えのファイルが消え、終了コードが 0.
- [ ] Lane 6. TUI で消す。B の HOME で Ctrl+K の「アカウントを削除」を選び、確かめの画面を撮ってから `delete` と打つ。Save `r17-lane6-tui-delete.png`. Pass when 確かめの画面に件数と書き出しの案内が出て、消したあとはこの端末の一覧と「クラウドのアカウントを消しました」が出る.
- [ ] Lane 7. もう一台の端末。A にセッションを二つ作り、HOME 1 で消したあと、HOME 2 の TUI を開いたままにする。Save `r17-lane7-other-device.png`. Pass when HOME 2 は次の同期でログインが切れたことを出し、落ちない.
- [ ] Lane 8. エージェントの使い方。端末なしで `nagi account delete --yes < /dev/null` を動かす。Save `r17-lane8-yes.png`. Pass when 聞かずに消し、終了コードが 0.
- [ ] Lane 9. 大きな書き出し。`curl` で 20000 件のタスクを入れた利用者で `nagi export --output big.json` を動かす。Save `r17-lane9-big-export.png`. Pass when 終了コードが 0 で、`jq` の件数が 20000 で、5 秒以内に終わる.
- [ ] Lane 10. ローカルのデータは残る。ログイン前に `nagi add` で 5 件入れた HOME に A のセッションを置き、TUI から消す。Save `r17-lane10-local-kept.png`. Pass when 消したあとの一覧にローカルの 5 件が出る.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. 20000 件の利用者の `GET /api/export` の時間と応答の大きさ、`DELETE /api/account` の時間。
- [ ] Probe. `curl -w '%{time_total} %{size_download}'` を 5 回ずつ。削除は毎回入れ直してから測り、中央値を取る。
- [ ] Baseline. trunk にはない。目標（書き出し 5 秒、削除 2 秒）を基準にする。
- [ ] Rule. 書き出しが 5 秒以内、削除が 2 秒以内。超えたら、書き出しを `cursor` でページに分ける作りに変える。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## ローカルのデータをクラウドへ移せるようにする (R18)

**Depends on.** R06.

**Files.**
- [ ] Create `src/worker/sync/import.ts`（`importRows`）と `src/worker/sync/import.test.ts`。
- [ ] `src/worker/sync/routes.ts`（`POST /api/import`、`?dryRun=1`）と `src/shared/api.ts`（`ImportResponse`）。
- [ ] `src/shared/export.ts`（R06 の形の `exportSchema`）。R17 が先に入っていれば使い、なければ Create。
- [ ] `tui/src/cli.rs`（`nagi import`、`nagi import --dry-run`、`nagi login` のあとの案内）、`tui/src/ui/login.rs`、`tui/src/ui/keys.rs`（Ctrl+K の「この端末のデータをクラウドへ移す」）、`tui/src/ui/render/overlay.rs`、`tui/src/config.rs`（`Prefs` に `import_offered`）、`tui/src/data/net.rs`、`tui/src/data/tests.rs`。
- [ ] `README.md` の `### ローカルとクラウド`（「クラウドへは移らない」を直す）。

**Build.**
- [ ] 送る形は R06 の `nagi export` の JSON にする。TUI は R06 の関数で `local.db` から作り、論理削除の行は入れない。
- [ ] `POST /api/import` はプロジェクトを先に、タスクをあとに、1 回 500 行まで受ける。TUI は 1 回の本文を 900 KiB 以下に分ける（R14 の 1 MiB の上限の下）。
- [ ] Worker は先にその利用者に同じ id の行があるかを読み、ない行だけを 1 回の `db.batch` で入れる。`INSERT` には `ON CONFLICT (user_id, id) DO NOTHING` を付け、同時の取り込みでも重ならない。`seq` は新しい行の数だけ `advanceSeq` で進める。何度送っても同じ結果になる。
- [ ] 項目はそのまま写す（`createdAt`、`completedAt`、`archivedAt`、`rank`、`checklist`、`priority`、`points` を含む）。`updatedAt` は取り込んだ時刻。指す先のプロジェクトがないタスクは `projectId` を null にし、その数を応答に入れる。
- [ ] 行は `src/shared/mutations.ts` の項目のスキーマで確かめる。落ちた行があれば 400 で、その位置を返し、何も書かない。
- [ ] `?dryRun=1` は書かずに `{ "tasks": { "new": 42, "existing": 0 }, "projects": { "new": 2, "existing": 0 } }` の形を返す。
- [ ] 行の上限は、R14 と R18 のうち後に入るほうが `POST /api/import` にかける。
- [ ] TUI は、クラウドで開いたとき（ログインの直後と起動のとき）に、`DeviceDb::count()` が 0 より多く、`Prefs.import_offered` にこの Worker と利用者の印がなければ、一度だけ聞く。画面は dry-run の数（「新しく 42 件、もうある 0 件」）を出し、Enter で移し、Esc で移さない。どちらでも印を付けて、二度と聞かない。
- [ ] Ctrl+K の「この端末のデータをクラウドへ移す」と `nagi import` で、いつでもやり直せる。途中で切れても、もう一度動かせば残りだけが入る。
- [ ] 移すあいだは「120 / 400 件」と進み具合を出す。終わったら同期して一覧に出す。
- [ ] 移したあとも `local.db` は消さない。ログアウトすると、今までどおりこの端末のデータに戻る。
- [ ] `login.rs` の「クラウドへは移さない」のコメントとトースト、`cli.rs` の `nagi login` のあとの文（「`nagi import` で移せます」と件数）を直す。

**You see.**
- [ ] ローカルで使っていた人がクラウドで開くと「この端末の 42 件をクラウドへ移しますか」と出る。
- [ ] Enter で移り、一覧にこの端末のタスクが並ぶ。
- [ ] `nagi import --dry-run` が件数だけを出す。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] `src/worker/sync/import.test.ts`。同じ本文を 2 回送ると、2 回目は全部 `existing` で、行と `meta.seq` が変わらない。
- [ ] ほかの利用者に同じ id の行があっても、自分の行として入る（主キーは `(user_id, id)`）。
- [ ] dry-run は何も書かない。指す先のないタスクは `projectId` が null になる。形の誤りは 400 で、何も書かない。
- [ ] `tui/src/data/tests.rs`。本文を 900 KiB 以下に分け、プロジェクトをタスクより先に送る。
- [ ] `tui/src/config.rs` のテスト。`import_offered` のない古い `prefs.json` が読める。
- [ ] `pnpm check`、`pnpm test`、`cd tui && cargo test`、`cargo clippy --all-targets -- -D warnings` が通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

Worker は `pnpm dev --var AUTH_DISABLED:false --var SIGNUP:open` で起動し、利用者を R14 と同じ手順で作る。各 HOME では、先にログインなしの `nagi add` と `nagi` の画面でローカルのデータを作り、そのあと `session-localhost_5317.json` を置いて `NAGI_SERVER=http://localhost:5317` で開く。クラウドの側には利用者ごとに `curl` で 3 件を入れておく。

- [ ] Lane 1. Regression lane against trunk. ローカルに 5 件ある HOME にセッションを置き、trunk と head で開く。Save `r18-lane1-offer.png`. Pass when trunk はクラウドの 3 件だけを出し（移す道がないことを記録する）、head は「新しく 5 件、もうある 0 件」の確かめを出す.
- [ ] Lane 2. 移す。lane 1 の head の確かめで Enter を押す。Save `r18-lane2-imported.png`. Pass when 一覧に 8 件が出て、D1 の件数が 5 増え、`local.db` の件数が 5 のまま.
- [ ] Lane 3. 移さない。新しい HOME で確かめに Esc を押し、閉じてもう一度開く。Save `r18-lane3-declined.png`. Pass when 二度目は確かめが出ず、D1 の件数が変わらない.
- [ ] Lane 4. あとから移す。lane 3 の HOME で Ctrl+K の「この端末のデータをクラウドへ移す」を選ぶ。Save `r18-lane4-palette.png`. Pass when 同じ確かめが出て、Enter で 5 件が入る.
- [ ] Lane 5. 二度目は何も入らない。lane 2 の HOME で `scripts/tui-shot.py --cmd 'nagi import --dry-run; nagi import'` を動かす。Save `r18-lane5-idempotent.png`. Pass when dry-run が「新しく 0 件、もうある 5 件」で、`meta` の `seq` が変わらない.
- [ ] Lane 6. 途中で切れる。ローカルに 2000 件ある HOME で `nagi import` を動かし、最初の本文が通ったあとに Worker を止め、起こし直してもう一度動かす。Save `r18-lane6-resume.png`. Pass when 二度目は残りだけを入れ、D1 の件数がちょうど 2000 増え、同じ id の行が一つもない.
- [ ] Lane 7. プロジェクトと完了。ローカルに色付きのプロジェクト 2 つ、アーカイブしたもの 1 つ、完了したタスク 3 件を作って移す。Save `r18-lane7-projects.png`. Pass when 色と所属が同じで、アーカイブはアーカイブのまま、完了は同じ `completedAt` で完了の記録に出る.
- [ ] Lane 8. 別の利用者。lane 2 の HOME のセッションを利用者 B のものに替えて開く。Save `r18-lane8-second-user.png`. Pass when B にも一度だけ確かめが出て、A の行は B の一覧に出ない.
- [ ] Lane 9. dry-run だけ。新しい HOME で `scripts/tui-shot.py --cmd 'nagi import --dry-run; echo exit=$?'` を動かす。Save `r18-lane9-dry-run.png`. Pass when 件数が出て、終了コードが 0 で、D1 の件数が変わらない.
- [ ] Lane 10. ログアウトで戻る。lane 2 の HOME で Ctrl+K の「ログアウト」を選ぶ。Save `r18-lane10-logout.png`. Pass when この端末の 5 件の一覧に戻り、クラウドの 3 件は出ない.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.
- [ ] Metric. ローカル 5000 件の取り込みの時間と、本文の大きさの最大。
- [ ] Probe. `time nagi import` を、毎回 D1 の利用者の行を消してから 3 回動かし、中央値を取る。本文の大きさは `pnpm dev` のログの `Content-Length` で見る。
- [ ] Baseline. trunk にはない。目標（30 秒、900 KiB）を基準にする。
- [ ] Rule. 30 秒以内に終わり、どの本文も 900 KiB 以下。

**Review gate.** None.

**Merge.**
- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## クラウドを有料にする (R19)

**Depends on.** R12、R13、R14、R15、そして operator の課金の選択。

**Files.**

- [ ] Create `migrations/0006_subscriptions.sql`。`subscriptions` テーブル（user_id、provider、provider_customer_id、status、current_period_end、updated_at）と `billing_events` テーブル（提供元のイベント id を主キー、received_at）を置く。
- [ ] Create `src/worker/billing/routes.ts`。`POST /billing/webhook` と `POST /api/billing/checkout` を置く。
- [ ] Create `src/worker/billing/verify.ts`。webhook の署名を確かめる。
- [ ] Create `src/worker/billing/entitlement.ts`。だれがクラウドを使えるかを決める規則を置く。
- [ ] `src/worker/auth/users.ts` を直す。`allowlist` と `open` の隣に `SIGNUP="paid"` を足す。
- [ ] `src/worker/auth/middleware.ts` を直す。`SIGNUP` が `paid` のとき、`requireSession` は許可リストでなく `entitlement.ts` に聞く。
- [ ] `wrangler.jsonc` を直し、提供元の公開設定を入れる。webhook の秘密は `wrangler secret put` で入れる。
- [ ] `tui/src/cli.rs` を直し、`nagi subscribe` と `nagi billing` を足す。
- [ ] `tui/src/ui/render/overlay.rs` と `tui/src/ui/login.rs` を直し、未契約と支払い遅れの状態を出す。

**Build.**

- [ ] Stop until the operator が課金の提供元（Polar、Lemon Squeezy、Paddle、Stripe のどれか）と価格（月額、年額の有無）を決める。
- [ ] 提供元は 1 つのモジュールの中に閉じ込める。提供元の名前を知るのは `verify.ts` と checkout の呼び出しだけにする。
- [ ] `POST /api/billing/checkout` は、ログイン中の GitHub ユーザー id に結びついた checkout の URL を、短命の署名つきトークンで作る。`nagi subscribe` はそれをブラウザで開き、画面にも出す。
- [ ] `POST /billing/webhook` は署名を確かめ、5 分より古いイベントを捨て、イベント id を `billing_events` に記録し、すでに見た id は無視する。
- [ ] `entitlement.ts` は、持ち主（`OWNER_GITHUB_USER_ID`）、`ALLOWED_GITHUB_USER_IDS` の無料枠のアカウント、`active` と `trialing` の契約、`current_period_end` から 7 日間の `past_due` を通す。
- [ ] 権利のない利用者には 402 と `{"error":"payment_required","checkoutUrl":...}` を返す。TUI は、プラン、価格、`nagi subscribe` を、R09 のカタログで日本語と英語で出す。
- [ ] 課金はローカルのデータに触れない。支払いをやめた利用者は、30 日間、`GET /api/export`（R17）でクラウドのデータを読める。

**You see.**

- [ ] staging で提供元をテストモードにすると、`nagi subscribe` が checkout を開く。テストの支払いのあと、10 秒以内に `nagi list --json` が利用者のタスクを返す。
- [ ] 契約のない利用者がログインすると、招待制のメッセージでなくプランの画面が出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/worker/billing/verify.test.ts` で、正しい署名、違う秘密、本文の書き換え、古い時刻を調べる。`pnpm test` を回す。
- [ ] `src/worker/billing/entitlement.test.ts` で、持ち主、無料枠、active、trialing、7 日以内と 7 日後の past due、canceled、契約なしを調べる。`pnpm test` を回す。
- [ ] `src/worker/billing/routes.test.ts` で、同じイベントを 2 回送り、行の変化が 1 回だけだと確かめる。`pnpm test` を回す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk で、許可リストにない GitHub ユーザーが staging にログインし、招待制のメッセージを見る。head で同じ利用者が、価格つきのプランの画面を見る。Save `paid-vs-invite.png`. Pass when trunk は招待制の文を出し、head は価格と `nagi subscribe` を出す。
- [ ] Lane 2. 新しい利用者が `nagi subscribe` を打ち、提供元のテストカードで払い、`nagi list` を打つ。Save `subscribe-flow.png`. Pass when 支払いから 10 秒以内に `nagi list` が成功する。
- [ ] Lane 3. 偽の署名の webhook を `scripts/tui-shot.py --cmd 'curl ...'` で送る。Save `forged-webhook.png`. Pass when 答えが 400 で、`subscriptions` の行が変わらない。
- [ ] Lane 4. 正しい webhook を同じイベント id で 2 回送る。Save `replayed-webhook.png`. Pass when 2 回目の答えが 200 で、`billing_events` にその id の行が 1 つだけある。
- [ ] Lane 5. 10 分前に署名した正しい webhook を送る。Save `stale-webhook.png`. Pass when 答えが 400。
- [ ] Lane 6. テストの契約を `past_due` にし、`current_period_end` を 3 日前にする。Save `past-due-grace.png`. Pass when 同期がまだ動き、TUI が支払いの警告を出す。
- [ ] Lane 7. 同じ契約の `current_period_end` を 8 日前にする。Save `past-due-expired.png`. Pass when `/api/sync` が 402 を返し、`GET /api/export` はまだ 200 を返す。
- [ ] Lane 8. 契約の行がない持ち主のアカウントでログインする。Save `owner-free.png`. Pass when 同期が動く。
- [ ] Lane 9. 契約のない利用者として、TUI を `--lang en` で起動する。Save `plan-screen-en.png`. Pass when プランの画面の全部の行が英語で、価格がランディングページと合う。
- [ ] Lane 10. 支払い中の利用者が、ログインせずにローカルモードを使う。Save `local-unaffected.png`. Pass when ローカルのタスクがネットワークの呼び出しなしで開き、課金の文が出ない。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. 支払い中の利用者の `POST /api/sync` の Worker CPU 時間。staging の `wrangler tail` で測る。
- [ ] Probe. trunk（許可リストの確認）で 50 回、head（entitlement の確認）で 50 回、交互に同期を回し、1 回ごとの CPU 時間を読む。
- [ ] Baseline. 先に trunk の中央値を記録する。
- [ ] Rule. head の中央値は trunk の中央値より 1 ms を超えて増えてはならず、head のどの要求も 10 ms を超えてはならない。

**Review gate.** merge の前に operator が確認する。

- [ ] Copy lane 2 and lane 9 screenshots into `docs/review/R19-review-subscribe.png` and `docs/review/R19-review-plan-en.png`.
- [ ] Record a 30 to 60 second video of the subscribe flow on staging and save it as `docs/review/R19-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## バックアップと障害の通知を入れる (R20)

**Depends on.** R14。

**Files.**

- [ ] `wrangler.jsonc` を直し、R2 バケットの束縛 `BACKUPS` と、毎日の cron トリガーを足す。
- [ ] Create `src/worker/ops/backup.ts`。全テーブルを、日付つきの 1 ファイルにして R2 に出す。
- [ ] `src/worker/index.ts` を直し、`scheduled` ハンドラーを足す。
- [ ] Create `scripts/restore-rehearsal.sh`。いちばん新しいバックアップを staging の D1 に読み込み、行数を数える。
- [ ] Create `docs/operations.md`。復元の手順、警告の一覧、だれに連絡が行くかを書く。

**Build.**

- [ ] Stop until the operator が、Worker のエラー率と D1 の容量の Cloudflare 通知を有効にし、`https://api.usenagi.dev/api/session` への外部の死活監視を足す。
- [ ] 毎日のバックアップは `backups/YYYY-MM-DD.sqlgz` に書き、35 日より古いファイルを消す。
- [ ] 復元の予行は staging だけで動かし、staging のものでないデータベース id は断る。

**You see.**

- [ ] staging で cron を 1 回回すと、`wrangler r2 object list` に今日のファイルが出る。
- [ ] `scripts/restore-rehearsal.sh` が、元と同じテーブルごとの行数を出す。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/worker/ops/backup.test.ts` で、ファイル名、35 日の掃除、失敗しても古いファイルが残ることを調べる。`pnpm test` を回す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk にバックアップはない。それを記録してから、head で `wrangler dev --test-scheduled` から cron を動かす。Save `backup-created.png`. Pass when ローカルの R2 に今日のファイルが出る。
- [ ] Lane 2. 同じ日に cron を 2 回回す。Save `backup-twice.png`. Pass when その日のファイルが 1 つだけある。
- [ ] Lane 3. 36 日前のファイルを R2 に置いて cron を回す。Save `backup-cleanup.png`. Pass when 古いファイルが消え、今日のファイルがある。
- [ ] Lane 4. staging に対して `scripts/restore-rehearsal.sh` を回す。Save `restore-counts.png`. Pass when 全テーブルの行数が元と合う。
- [ ] Lane 5. 本番のデータベース id で `scripts/restore-rehearsal.sh` を回す。Save `restore-refused.png`. Pass when 何かを書く前に 0 以外で終わる。
- [ ] Lane 6. staging に 10,000 件のタスクを入れて cron を回す。Save `backup-large.png`. Pass when Worker の時間制限の内で終わる。
- [ ] Lane 7. R2 への書き込みを失敗させる。Save `backup-failure.png`. Pass when エラーをログに出し、古いファイルが残る。
- [ ] Lane 8. staging の Worker を 2 分止める。Save `uptime-alert.png`. Pass when 外部の監視が停止を知らせる。
- [ ] Lane 9. staging で 500 の答えを 5 回起こす。Save `error-alert.png`. Pass when Cloudflare の通知が届く。
- [ ] Lane 10. `docs/operations.md` を読み、staging で復元の手順を手で追う。Save `runbook-followed.png`. Pass when 抜けた手順なしに最後まで動く。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. タスク 10,000 件でのバックアップ 1 回の実時間と CPU 時間。
- [ ] Probe. staging で cron を 3 回起こし、`wrangler tail` で時間を読む。trunk にバックアップはないので、それを記録する。
- [ ] Baseline. trunk にバックアップの実行がないことを記録する。
- [ ] Rule. 1 回の実行は実時間 30 秒より短く終わり、実行中の `/api/sync` の p95 を 20 ms を超えて上げてはならない。

**Review gate.** None.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 検証用の環境（staging）を作る (R21)

**Depends on.** R12。

**Files.**

- [ ] `wrangler.jsonc` を直し、`env.staging` を足す。専用の Worker 名、専用の D1 データベース、ルート `staging.usenagi.dev`、`SIGNUP="allowlist"` を持たせる。
- [ ] Create `.github/workflows/staging.yml`。`workflow_dispatch` と `staging` ブランチへの push で staging に配備する。
- [ ] Create `scripts/seed-staging.mjs`。`scripts/seed-local.mjs` をもとに、3 人のテスト利用者とそのタスクを入れる。
- [ ] `docs/operations.md` を直し、staging の配備と初期化のしかたを書く。

**Build.**

- [ ] Stop until the operator が staging の D1 データベースと、専用の Cloudflare トークンつきの GitHub environment `staging` を作る。
- [ ] staging は、データベース、秘密、課金のアカウントを、本番と決して共有しない。課金の提供元はそこではテストモードで動く。
- [ ] `nagi --server https://staging.usenagi.dev` で staging につながる。

**You see.**

- [ ] `curl -s https://staging.usenagi.dev/api/session` が 401 を返す。
- [ ] `wrangler d1 list` に、`nagi` と別の staging のデータベースが出る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/worker/index.test.ts` に、staging の変数を読み、`AUTH_DISABLED` の守りを保つ場合を足す。`pnpm test` を回す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk に staging はない。それを記録してから、head で `scripts/tui-shot.py --cmd 'curl -si https://staging.usenagi.dev/api/session'` を回す。Save `staging-alive.png`. Pass when 答えが 401 の JSON である。
- [ ] Lane 2. staging の workflow を dispatch で回す。Save `staging-deploy.png`. Pass when 実行が緑で、変わったのは staging の Worker だけである。
- [ ] Lane 3. staging に種を入れ、`nagi --server` でテスト利用者 1 としてログインする。Save `staging-login.png`. Pass when 種のタスクが出る。
- [ ] Lane 4. 同じ GitHub アカウントで本番にログインする。Save `prod-separate.png`. Pass when staging のタスクが出ない。
- [ ] Lane 5. staging の Worker の設定から、staging の D1 id を読む。Save `staging-db-id.png`. Pass when `770a86db-0365-4b58-ab4f-842f1d0684d3` と違う。
- [ ] Lane 6. `AUTH_DISABLED=true` の通信を staging に送る。Save `staging-auth-guard.png`. Pass when 答えが 401 である。
- [ ] Lane 7. 書かれた手順で staging を初期化する。Save `staging-reset.png`. Pass when 行数が種の状態に戻る。
- [ ] Lane 8. staging の配備のあとで main を本番に配備する。Save `prod-unchanged.png`. Pass when `deploy.yml` の本番の smoke テストが通る。
- [ ] Lane 9. staging から課金の提供元のページを開く。Save `staging-test-mode.png`. Pass when テストモードと書いてある。
- [ ] Lane 10. staging のサーバーを指定せず、`nagi` をローカルモードで回す。Save `local-default.png`. Pass when staging への要求が 1 つもない。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. dispatch から、staging の Worker が動き出すまでの時間。
- [ ] Probe. staging の workflow を 3 回 dispatch し、実行時間を読む。
- [ ] Baseline. trunk に staging の配備がないことを記録する。
- [ ] Rule. staging の配備は 5 分より短く終わる。

**Review gate.** None.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 依存と CI を固める (R22)

**Depends on.** R03。

**Files.**

- [ ] Create `.github/dependabot.yml`。`tui/` の cargo、ルートの npm、GitHub Actions を見る。
- [ ] Create `tui/deny.toml`。`cargo deny` の設定（advisories、licenses、sources）を置く。
- [ ] `.github/workflows/ci.yml` を直し、`cargo deny check` と `pnpm audit --prod` を回す。
- [ ] `.github/workflows/ci.yml`、`deploy.yml`、`tui.yml`、`staging.yml` を直し、各 job が必要な最小の `permissions:` だけを持つようにする。

**Build.**

- [ ] Stop until the operator が、`TAURI_SIGNING_PRIVATE_KEY` と `TAURI_UPDATER_PUBKEY` の削除を認め、`main` の secret scanning、push protection、branch protection を有効にする。
- [ ] 第三者の action は、すべて完全な SHA に固定したままにする。
- [ ] 直し方のある新しい advisory は CI を落とす。直し方のないものは、理由と日付つきで `tui/deny.toml` に載せる。

**You see.**

- [ ] `gh secret list` に `TAURI_*` の secret が出ない。
- [ ] 既知の advisory のある crate を足すテスト PR は、`cargo deny check` で落ちる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] PR の head で、`tui/` の `cargo deny check` とルートの `pnpm audit --prod` を回す。どちらも通る。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk と head で `cargo deny check` を回す。Save `deny-trunk-head.png`. Pass when trunk にそのような検査はなく、head は通る。
- [ ] Lane 2. 作業用の枝で、既知の advisory のある crate の版を足す。Save `deny-advisory.png`. Pass when CI がその advisory で落ちる。
- [ ] Lane 3. 作業用の枝で、許可リストにない license の crate を足す。Save `deny-license.png`. Pass when CI がその license で落ちる。
- [ ] Lane 4. head で `pnpm audit --prod` を回す。Save `pnpm-audit.png`. Pass when 終了コードが 0 である。
- [ ] Lane 5. すべての workflow の `permissions:` を `scripts/tui-shot.py --cmd 'grep -n permissions -A4 .github/workflows/*.yml'` で読む。Save `permissions.png`. Pass when `write-all` の job がなく、書けるのは release と deploy の job だけである。
- [ ] Lane 6. 作業用の枝に偽のトークンの文字列を push する。Save `push-protection.png`. Pass when GitHub が push を止める。
- [ ] Lane 7. `gh secret list` を回す。Save `secrets.png`. Pass when `TAURI_*` の secret が残っていない。
- [ ] Lane 8. `main` への直接の push を試す。Save `branch-protection.png`. Pass when GitHub が断る。
- [ ] Lane 9. 1 日後に Dependabot のタブを読む。Save `dependabot.png`. Pass when cargo、npm、actions の更新が出ている。
- [ ] Lane 10. すべての `uses:` の行に 40 文字の SHA があるか調べる。Save `pinned-actions.png`. Pass when タグだけを使うものがない。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. PR での CI workflow の実時間。
- [ ] Probe. trunk で 3 回、head で 3 回、交互に CI を回す。
- [ ] Baseline. 先に trunk の中央値を記録する。
- [ ] Rule. head の中央値は trunk の中央値より 90 秒を超えて増えてはならない。

**Review gate.** None.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 攻撃者の視点でセキュリティ診断をし、見つかった穴をふさぐ (R23)

**Depends on.** R14、R15、R16、R17、R18、R19、R20、R21、R22。

**Files.**

- [ ] Create `docs/security/threat-model.md`。守る物、信頼の境界、攻撃する側、入口を書く。
- [ ] Create `docs/security/pentest-2026.md`。見つけた穴ごとに、重大度、証拠、直した PR、再試験の結果を書く。
- [ ] Create `scripts/security/`。穴の種類ごとに、繰り返せる検査のスクリプトを 1 つ置く。staging に対してだけ回す。
- [ ] 各修正に必要なファイルを直す。high と critical の修正は、それぞれ R24 の前に単独の PR で入れる。

**Build.**

- [ ] Stop until the operator が、範囲、staging の対象、試験の時間帯を認める。診断は、本番、他人のアカウント、GitHub、Cloudflare そのものを決して対象にしない。
- [ ] 先に脅威モデルを書く。守る物は、タスクの内容、セッショントークン、課金の状態、リリースの流れ。境界は、TUI、Worker、D1、課金の提供元、GitHub、Homebrew の tap。
- [ ] 違うモデルの系統の独立した査読者を、`security-reviewer` の役で走らせる。範囲と証拠は全員で同じにし、見つけた穴を合わせる。
- [ ] 次の種類を、査読者が再実行できるスクリプトで staging に対して調べる。`/api/sync` と `/api/mutate` での他の利用者へのアクセス。セッションの扱い（トークンの推測、ログアウト後の再利用、期限切れ）。device flow の悪用。rate limit と quota の回避。大きすぎる変更と壊れた変更。webhook の偽造と再送。entitlement の回避。Origin の確認。同期されたタイトルとメモの中の端末制御文字列（ANSI、OSC 52、OSC 8）。ローカルのファイルの権限とログの中身。release、checksum、tap の完全性。
- [ ] 見つけた穴ごとに、影響と起こりやすさで格づけする。high と critical はすべて直し、そのスクリプトで再試験し、結果を記録する。

**You see.**

- [ ] `docs/security/pentest-2026.md` が、見つけた穴をすべて状態つきで並べ、high と critical に未解決がない。
- [ ] `scripts/security/` のすべてのスクリプトが、最後の head の staging に対して通る。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] 各修正の PR は、直す前に落ち、直したあとに通るテストを足す。`pnpm test` と `cargo test` を回す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. trunk から配備した staging と head から配備した staging に、`scripts/security/` のすべてのスクリプトを回す。Save `security-suite.png`. Pass when head がすべてのスクリプトを通り、trunk の失敗が穴の一覧と合う。
- [ ] Lane 2. テスト利用者 1 として、テスト利用者 2 のタスク id を `/api/sync` と `/api/mutate` で求める。Save `cross-user.png`. Pass when どの答えも何も漏らさず、何も変えない。
- [ ] Lane 3. ログアウトしてから古いトークンを再利用する。Save `token-after-logout.png`. Pass when 答えが 401 である。
- [ ] Lane 4. `/auth/device/start` に rate limit を超えて要求を送る。Save `rate-limit.png`. Pass when 設定した上限で答えが 429 になる。
- [ ] Lane 5. 1 MB のタイトルと、100,000 項目のチェックリストを送る。Save `oversize.png`. Pass when 両方が 400 か 413 で断られ、D1 の大きさが変わらない。
- [ ] Lane 6. 偽造した課金の webhook と、再送した課金の webhook を送る。Save `webhook-attacks.png`. Pass when 両方が断られ、契約が何も変わらない。
- [ ] Lane 7. 契約が切れた利用者で、すべての `/api/*` のルートを試す。Save `entitlement-bypass.png`. Pass when `GET /api/export` とログアウトだけが動く。
- [ ] Lane 8. タイトルに ANSI の色、OSC 52、OSC 8 の列を持つタスクを同期し、TUI と `nagi list` で開く。Save `escape-sequences.png`. Pass when その列がただの文字で出て、クリップボードが変わらない。
- [ ] Lane 9. Linux と macOS の runner でログインしたあと、`~/.config/nagi` のセッションのファイルと `nagi.log` の権限を読む。Save `file-modes.png`. Pass when セッションとログが 0600 で、ログにトークンがない。
- [ ] Lane 10. 最新の release をダウンロードし、`SHA256SUMS` と来歴の attestation を `gh attestation verify` で確かめる。Save `release-integrity.png`. Pass when 両方が合う。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. すべての修正のあとの、staging での `/api/sync` の p95 の遅延。
- [ ] Probe. trunk から配備した staging と head から配備した staging で、200 回ずつ同期を交互に回す。
- [ ] Baseline. 先に trunk の p95 を記録する。
- [ ] Rule. head の p95 は trunk の p95 より 15 パーセントを超えて増えてはならない。

**Review gate.** merge の前に operator が確認する。

- [ ] Copy lane 1 and lane 8 screenshots into `docs/review/R23-review-suite.png` and `docs/review/R23-review-escapes.png`.
- [ ] Record a 30 to 60 second video of the security suite running against staging and save it as `docs/review/R23-review.mp4`.
- [ ] Post the screenshots, the video, and `docs/security/pentest-2026.md` in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## 1.0.0 を出し、クラウドの申し込みを開く (R24)

**Depends on.** R00、R01、R02、R03、R04、R05、R06、R07、R08、R09、R10、R11、R12、R13、R14、R15、R16、R17、R18、R19、R20、R21、R22、R23。

**Files.**

- [ ] `wrangler.jsonc` を直し、`SIGNUP` を `paid` にする。
- [ ] R09 のカタログを直し、招待制の文字列をすべて消す。`README.md` と `README.ja.md` も同じように直す。
- [ ] `tui/Cargo.toml` を直し、版を `1.0.0` にする。
- [ ] `CHANGELOG.md` を直し、1.0.0 の項を足す。

**Build.**

- [ ] Stop until the operator が、公開の日と、R23 に未解決の high と critical がないことを認める。
- [ ] 先に Worker の変更を配備し、そのあと `v1.0.0` のタグを push する。R03 の流れが全プラットフォームをビルドし、tap と Windows のパッケージを更新する。
- [ ] ランディングページの申し込みボタンを有効にする。

**You see.**

- [ ] `brew upgrade nagi` のあとに `nagi --version` を打つと `nagi 1.0.0` が出る。
- [ ] 新しい GitHub アカウントが、ログインし、プランを見て、本番モードで払い、同期できる。

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `src/worker/auth/users.test.ts` で、`SIGNUP="paid"` のときの、持ち主、無料枠、支払い中、未払いの利用者を調べる。`pnpm test` を回す。
- [ ] どちらかの言語のキーに招待制を指す語が残っていたら落ちる、カタログのテストを足す。`cargo test` を回す。

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `fast mechanical model (setup default)` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. 知らない GitHub ユーザーが trunk と head でログインする。Save `launch-login.png`. Pass when trunk は招待制の文を出し、head はプランの画面を出す。
- [ ] Lane 2. 新しい macOS arm64 の runner で `brew install myksyut/tap/nagi` を回す。Save `brew-arm.png`. Pass when `nagi --version` が `nagi 1.0.0` を出す。
- [ ] Lane 3. macOS Intel の runner で同じことをする。Save `brew-intel.png`. Pass when `nagi --version` が `nagi 1.0.0` を出す。
- [ ] Lane 4. ubuntu-24.04-arm で、Linux arm64 の tarball から入れる。Save `linux-arm.png`. Pass when `nagi add` と `nagi list` が動く。
- [ ] Lane 5. Windows の runner で、scoop か winget から入れる。Save `windows.png`. Pass when `nagi --version` が `nagi 1.0.0` を出す。
- [ ] Lane 6. 新しいアカウントが本番モードで本物のカードで払い、返金する。Save `live-payment.png`. Pass when 支払いのあとで同期が動き、返金が提供元に出る。
- [ ] Lane 7. ランディングページを日本語と英語で開く。Save `landing-live.png`. Pass when 価格、プライバシー、利用規約、特定商取引法に基づく表記のページが開く。
- [ ] Lane 8. R15 より前の 0.x のバイナリを、新しい Worker に対して回す。Save `old-client.png`. Pass when 更新を促すメッセージが出て、保留中の変更が残る。
- [ ] Lane 9. `v1.0.0` の release ページを読む。Save `release-page.png`. Pass when 変更点、`SHA256SUMS`、attestation が載っている。
- [ ] Lane 10. すべてのプラットフォームの runner で、ネットワークなしにローカルモードを回す。Save `local-offline.png`. Pass when タスクが開き、保存できる。

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. ローカルモードで `nagi` を始めてから最初の描画までの時間と、本番の `/api/sync` の p95。
- [ ] Probe. trunk と head のビルドで `nagi` を `scripts/tui-shot.py` から 20 回ずつ交互に起動し、公開の前後に本番の同期を 100 回ずつ回す。
- [ ] Baseline. 先に trunk の起動時間と、公開前の p95 を記録する。
- [ ] Rule. 起動時間は Linux の runner で 200 ms より短く、p95 は基準より 20 パーセントを超えて増えてはならない。

**Review gate.** merge の前に operator が確認する。

- [ ] Copy lane 1 and lane 7 screenshots into `docs/review/R24-review-login.png` and `docs/review/R24-review-landing.png`.
- [ ] Record a 30 to 60 second video of install, login, and payment and save it as `docs/review/R24-review.mp4`.
- [ ] Post the screenshots and the video in chat for the operator. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The operator squash-merges the PR.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] `brew install myksyut/tap/nagi` on a fresh macOS runner, `scoop install nagi` or `winget install nagi` on a fresh Windows runner, and the Linux tarball on ubuntu-24.04-arm each print `nagi 1.0.0`.
- [ ] The landing page at `usenagi.dev` shows the price, the privacy policy, the terms, and the 特定商取引法に基づく表記 in Japanese and English.
- [ ] `docs/security/pentest-2026.md` lists no open high or critical finding.
- [ ] Reply to the operator with the report the execution playbook names.

## Appendix A. Prototype evidence

調べて答えが出たことと、まだ出ていないこと。

- ドメインの空き（2026-10-11）。RDAP（`https://data.iana.org/rdap/dns.json` の登録先）と、whois の 43 番ポートで調べた。取られている名前は nagi.dev、nagi.app、nagi.com、nagi.io、nagi.sh、nagi.jp、nagi.so、nagi.page、nagi.day、nagi.cloud、bagi.dev、bagi.app、bagi.com、bagi.io。空いている名前は nagi.run、nagi.tools、nagi.ink、usenagi.dev、usenagi.app、getnagi.dev、nagitodo.dev、nagitodo.app、nagitodo.com、nagi-todo.dev、bagi.sh、bagi.jp。値段（プレミアム扱いか）は登録先で確かめていない。
- ドメインの値段（2026-10-11、Cloudflare Registrar、1 年あたり、cfdomainpricing.com の一覧）。nagi.run は 21.20 ドル。nagi.tools は 28.20 ドル。nagi.ink は 25.20 ドル。.dev は初年 8.20 ドル、更新 12.20 ドル。.app は初年 8.20 ドル、更新 14.20 ドル。.com は 10.46 ドル。.sh は 45.00 ドル。.jp は Cloudflare では扱っていない。名前ごとのプレミアム扱いは、登録の画面で確かめる。
- ドメインの決定。運用者は nagi.date も考えたが、.date はフィッシングに今も使われる TLD で（gTLD Trust Index で 82 日に 17 件、停止は 1 件）、「デート」とも読まれるので外した。運用者は usenagi.dev を選んで買った（2026-10-11）。
- ロゴとアニメーション。使い捨ての試作で、ロゴ 6 案、TUI での描き方 7 案、動き 4 案を比べ、運用者がロゴ B と動き 3 を選んだ。#37、#38、#39 でマージ済み。配色を一つにする問いは、まだ答えが出ていない。R07 が試作で答える。
- ほかのプラットフォーム。GitHub の changelog（2026-02-05 と 2026-06-11）と runner-images の告知で、Linux arm64、macOS Intel、Windows x64、Windows arm64 の runner があることを確かめた。nagi を実際にそれらで組んだことはまだない。R04 と R05 が確かめる。
- 翻訳の量。`tui/src` の Rust に、日本語を含む文字列リテラルが 775 個、38 ファイルある（grep で数えた）。英語の日付の入力が今の解析器に素直に乗るかは確かめていない。R10 が確かめる。
- 決済の手数料（2026-10-11、stripe.com/jp/pricing と Stripe のサポート記事）。Stripe の日本の口座は、カード 3.6%（固定費なし）、通貨換算が要れば 2% を足す、サブスクリプションの Billing が 0.7%。Stripe Managed Payments（Stripe の Merchant of Record）は 3.5% を足し、80 か国以上の消費税と VAT の計算、徴収、申告、納付を受け持つ。日本の事業者も対象で、Adaptive Pricing で通貨換算の手数料はかからない。合計は約 7.8% で、月 3 ドルなら約 0.23 ドル。Polar、Lemon Squeezy、Paddle は 5% と 50 セントで、月 3 ドルなら約 0.65 ドル（約 22%）。運用者は Stripe を選んだ（2026-10-11）。
- 端末の色。macOS の「ターミナル」や明るい背景での見え方は、まだ実際に見ていない。R08 の lane が確かめる。

## Appendix B. Alternatives rejected

- 手元に Intel の Mac や Windows を用意する案。運用者は持っておらず、GitHub の runner で組んで動かせるので、買わない。
- 毎回の main へのマージで配る今のやり方を続ける案。ロゴの変更のような小さな変更まで全員に届き、版の番号が CI の実行回数で飛ぶ。タグで出す形に変える（R03）。
- 招待制のまま、許可リストを手で増やし続ける案。人が増えるたびにデプロイが要り、お金の流れもない。有料の利用権に置き換える（R19）。
- Polar、Lemon Squeezy、Paddle を使う案。各国の税は引き受けてくれるが、1 回 50 セントの固定費があり、月 3 ドルでは手数料が約 22% になる。Stripe Managed Payments なら同じ税の引き受けが約 7.8% で済む。Stripe だけを使い税を自分で扱う案も、EU や英国への販売で登録と申告が要るので選ばない。
- 本番に向けて侵入テストをする案。ほかの利用者のデータを壊すおそれがある。staging（R21）だけに向ける。
- 翻訳に大きな枠組み（Fluent など）を入れる案。R09 で比べ、文字の数と複数形の要り方に見合うほうを選ぶ。

## Appendix C. Risks

- R02。手元のデータの形の移行は一方通行。他人が v1 のデータを持つ前にマージする。owner は古い形のデータの見本から開けるテストを見張る。
- R12。接続先を変えると、ログイン済みの人がログアウトされるおそれ。owner は古い `slug(server)` の控えとセッションの引き継ぎを見張る。workers.dev は止めない。
- R15。版のずれで変更が消える今の動きを、R19 より前に直す。owner は送っていない変更が残ることを見張る。
- R19。Webhook の偽造と二重処理で、払っていない人が使える、または払った人が使えない。owner は署名の確認、イベント ID の重複、猶予の期間を見張る。R23 でも攻める。
- R23。侵入テストで見つかった重い穴は、R24 を止める。
- 運用者の作業待ち。ドメインの購入、決済の選択、Workers Paid、`TAP_GITHUB_TOKEN`、TAURI の secret の削除。どれかが止まると、その先の PR が止まる。root は毎回の tick で開いている gate を報告する。
- 一人で運用する負担。障害の通知（R20）とバックアップの戻し方の練習がないと、気づくのが遅れる。

## Appendix D. Links and reading list

- 今回の調査の結果。配布、クラウド、TUI の作り、リポジトリの整理の 4 つに分けて調べた（2026-10-11）。見つかった穴は、この計画の各 PR に割り振った。
- 読んでから触る文書。`README.md`、`.github/workflows/tui.yml`、`.github/workflows/deploy.yml`、`wrangler.jsonc`、`tui/src/data/device.rs`、`src/worker/auth/users.ts`、`src/shared/api.ts`。
- `skills/how/SKILL.md` を先に通す PR。R02、R09、R12、R15、R19。
- `skills/interrogate/SKILL.md` を通す PR。R03、R19、R23。
- 判断の記録は `skills/show-me-your-work/SKILL.md` に従い、`docs/release-decisions.tsv` に一行ずつ残す。
