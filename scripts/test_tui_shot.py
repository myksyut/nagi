"""scripts/tui-shot.py の確かめ。

実行: uv run --with pytest --with pyte --with pillow pytest scripts/test_tui_shot.py
"""

import importlib.util
import json
import os
import random
import signal
import subprocess
import sys
import time
from pathlib import Path

import pyte
import pytest

HERE = Path(__file__).resolve().parent


@pytest.fixture(scope="module")
def shot():
    spec = importlib.util.spec_from_file_location("tui_shot", HERE / "tui-shot.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules["tui_shot"] = mod
    spec.loader.exec_module(mod)
    return mod


def feed(shot, text, cols=20, rows=3):
    screen = shot.TermScreen(cols, rows)
    pyte.ByteStream(screen).feed(text.encode())
    return screen


def test_key_names_become_xterm_bytes(shot):
    assert shot.key_bytes("ctrl+k") == b"\x0b"
    assert shot.key_bytes("ctrl+r") == b"\x12"
    assert shot.key_bytes("alt+up") == b"\x1b[1;3A"
    assert shot.key_bytes("Enter") == b"\r"
    assert shot.key_bytes("Esc") == b"\x1b"
    assert shot.key_bytes("Tab") == b"\t"
    assert shot.key_bytes("Down") == b"\x1b[B"
    assert shot.key_bytes("shift+tab") == b"\x1b[Z"
    assert shot.key_bytes("q") == b"q"
    assert shot.key_bytes("?") == b"?"
    assert shot.key_bytes("alt+x") == b"\x1bx"
    with pytest.raises(shot.ScriptError):
        shot.key_bytes("Bogus")


def test_inline_and_file_scripts_give_the_same_steps(shot, tmp_path):
    inline = "sleep 1; key n; type 牛乳を買う; key Enter; shot add; resize 100x30; run echo hi; wait-exit 2"
    path = tmp_path / "script.txt"
    path.write_text(
        "# コメント\nsleep 1\nkey n\n\ntype 牛乳を買う\nkey Enter\nshot add\nresize 100x30\nrun echo hi\nwait-exit 2\n",
        encoding="utf-8",
    )
    steps = shot.parse_script(inline)
    assert steps == shot.parse_script(f"@{path}")
    assert [s.verb for s in steps] == ["sleep", "key", "type", "key", "shot", "resize", "run", "wait-exit"]
    assert steps[2].arg == "牛乳を買う"


def test_bad_scripts_are_rejected(shot):
    for bad in ("jump 1", "sleep x", "key Nope", "shot a/b", "resize 10", "type"):
        with pytest.raises(shot.ScriptError):
            shot.parse_script(bad)


def test_colors_resolve_to_rgb(shot):
    assert shot.color_rgb("2e4670", (0, 0, 0)) == (0x2E, 0x46, 0x70)
    assert shot.color_rgb("red", (0, 0, 0)) == (205, 0, 0)
    assert shot.color_rgb("default", (1, 2, 3)) == (1, 2, 3)
    screen = feed(shot, "\x1b[38;5;196ma\x1b[48;2;1;2;3mb")
    assert shot.cell_colors(screen.buffer[0][0])[0] == (255, 0, 0)
    assert shot.cell_colors(screen.buffer[0][1])[1] == (1, 2, 3)


def test_background_pixel_is_exact_and_reverse_swaps(shot):
    font = shot.Font.load(None)
    screen = feed(shot, "\x1b[?25l\x1b[48;2;46;70;112mabc\x1b[0m\x1b[7md")
    img = shot.render_png(screen, font)
    cw, ch = font.cell_w, font.cell_h
    assert img.size == (20 * cw, 3 * ch)
    assert img.getpixel((0, 0)) == (0x2E, 0x46, 0x70)
    assert img.getpixel((3 * cw, 0)) == shot.DEFAULT_FG  # 反転の地は前景色
    assert img.getpixel((10 * cw, 0)) == shot.DEFAULT_BG


def test_cursor_is_drawn_unless_hidden(shot):
    font = shot.Font.load(None)
    shown = shot.render_png(feed(shot, "ab"), font)
    hidden = shot.render_png(feed(shot, "\x1b[?25lab"), font)
    assert shown.getpixel((2 * font.cell_w, 0)) == shot.DEFAULT_FG
    assert hidden.getpixel((2 * font.cell_w, 0)) == shot.DEFAULT_BG


def test_wide_chars_take_two_cells(shot):
    font = shot.Font.load(None)
    screen = feed(shot, "\x1b[?25l牛乳a")
    assert shot.layout_row(screen, 0)[:3] == [(0, "牛", 2), (2, "乳", 2), (4, "a", 1)]
    assert shot.screen_text(screen).splitlines()[0] == "牛乳a"
    # 幅 2 の文字の地は 2 セル分塗られ、3 文字目の字形は 5 セル目から始まる
    screen = feed(shot, "\x1b[?25l\x1b[48;2;9;9;9;38;2;255;0;0m牛乳\x1b[0ma")
    img = shot.render_png(screen, font)
    cw = font.cell_w
    assert img.getpixel((4 * cw - 1, 0)) == (9, 9, 9)
    assert img.getpixel((4 * cw, 0)) == shot.DEFAULT_BG
    xs = {c: [x for x in range(img.width) for y in range(img.height) if img.getpixel((x, y)) == c]
          for c in ((255, 0, 0), shot.DEFAULT_FG)}  # fmt: skip
    assert xs[(255, 0, 0)] and max(xs[(255, 0, 0)]) < 4 * cw
    assert xs[shot.DEFAULT_FG] and min(xs[shot.DEFAULT_FG]) >= 4 * cw


def run_tool(shot, tmp_path, *argv):
    out = tmp_path / "out"
    code = shot.main(["--out-dir", str(out), "--size", "40x5", *argv])
    return code, out


def test_cmd_runs_isolated_and_reports(shot, tmp_path, monkeypatch):
    monkeypatch.setenv("NAGI_TOKEN", "secret")
    monkeypatch.setenv("NAGI_SERVER", "http://example.invalid")
    code, out = run_tool(shot, tmp_path, "--cmd", 'echo "[$NAGI_TOKEN$NAGI_SERVER] $HOME $XDG_DATA_HOME 牛乳"; exit 3',
                         "--shot", "cmd")  # fmt: skip
    text = (out / "cmd.txt").read_text(encoding="utf-8")
    report = json.loads((out / "run.json").read_text())
    assert code == 3 and report["exit_code"] == 3 and not report["timed_out"]
    assert "[]" in text and "牛乳" in text
    home = text.split()[1]
    assert "tui-shot-home-" in home and not os.path.exists(home)  # 一時の HOME は消える
    assert (out / "cmd.png").exists()
    assert report["shots"][0]["render_ms"] >= 0 and report["first_output_ms"] is not None
    assert sum(report["writes_per_sec"]) >= 1 and report["output_bytes"] > 0


@pytest.fixture
def marker():
    """同じ機械で動くほかのテストや道具のプロセスと取り違えないよう、この試しだけの値を引数にする。"""
    m = str(random.randrange(10**8, 10**9))
    yield m
    subprocess.run(["pkill", "-f", m])


def alive(marker) -> bool:
    return subprocess.run(["pgrep", "-f", marker], capture_output=True).returncode == 0


def test_timeout_kills_process_group_and_exits_124(shot, tmp_path, marker):
    code, out = run_tool(shot, tmp_path, "--cmd", f"sleep {marker} & wait", "--timeout", "1")
    report = json.loads((out / "run.json").read_text())
    assert code == 124 and report["timed_out"] is True
    assert not alive(marker)


def test_resize_changes_screen_size_and_tty_answers_cursor_query(shot, tmp_path):
    keys = "sleep 0.3; shot small; resize 60x8; sleep 0.3; shot big"
    code, out = run_tool(shot, tmp_path, "--cmd", "printf '\\033[6n'; read -s -t 2 -d R r; stty size; sleep 1", "--keys", keys)
    report = {s["slug"]: s for s in json.loads((out / "run.json").read_text())["shots"]}
    assert code == 0
    assert (report["small"]["cols"], report["small"]["rows"]) == (40, 5)
    assert (report["big"]["cols"], report["big"]["rows"]) == (60, 8)
    assert "5 40" in (out / "small.txt").read_text()


def test_bare_esc_is_read_as_a_key_not_alt_prefix(shot, tmp_path):
    binary = shot.DEFAULT_BIN
    if not binary.exists():
        pytest.skip("tui/target/release/nagi が無い（cargo build --release）")
    code, _ = run_tool(shot, tmp_path, "--keys", "sleep 1; key ?; sleep 0.3; key Esc; key q", "--timeout", "10")
    assert code == 0  # Esc の直後の q が Alt+q と読まれると終わらず、124 になる


# ---- 子を残さない・一時の HOME を残さない ---------------------------------------
# 道具を別のプロセスで動かす。止まらない不具合でもテストが止まらず、シグナルも送れる。


def spawn(tmp_path, *argv):
    tmp = tmp_path / "tmp"
    tmp.mkdir(exist_ok=True)
    return subprocess.Popen(
        [sys.executable, str(HERE / "tui-shot.py"), "--out-dir", str(tmp_path / "out"), "--size", "40x5", *argv],
        env={**os.environ, "TMPDIR": str(tmp)},
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def finish(proc, limit: float) -> int:
    try:
        return proc.wait(limit)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        pytest.fail(f"tui-shot が {limit} 秒で終わらない")


def homes_left(tmp_path) -> list[str]:
    return [p.name for p in (tmp_path / "tmp").iterdir() if p.name.startswith("tui-shot-home-")]


def test_run_step_timeout_kills_its_background_children(tmp_path, marker):
    proc = spawn(tmp_path, "--cmd", f"sleep {marker}", "--keys", f"run sleep {marker} & wait", "--timeout", "2")
    assert finish(proc, 8) == 124
    assert not alive(marker) and not homes_left(tmp_path)


def test_endless_output_still_shoots_and_times_out(tmp_path, marker):
    proc = spawn(tmp_path, "--cmd", f"yes {marker}", "--keys", "sleep 0.2; shot a", "--timeout", "3")
    assert finish(proc, 9) == 124
    assert marker in (tmp_path / "out" / "a.txt").read_text()
    assert json.loads((tmp_path / "out" / "run.json").read_text())["timed_out"] is True
    assert not alive(marker) and not homes_left(tmp_path)


def test_children_left_after_the_command_exits_are_killed(tmp_path, marker):
    proc = spawn(tmp_path, "--cmd", f"trap '' HUP; sleep {marker} >/dev/null 2>&1 & exit 0")
    assert finish(proc, 8) == 0
    assert not alive(marker)


def test_bad_option_leaves_no_temporary_home(tmp_path):
    assert finish(spawn(tmp_path, "--cmd", "true", "--env", "INVALID"), 8) == 2
    assert not homes_left(tmp_path)


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT])
def test_termination_signal_cleans_up_children_and_home(tmp_path, marker, sig):
    keys = f"run sleep {marker} & touch $HOME/ready\\; wait"
    proc = spawn(tmp_path, "--cmd", f"trap '' HUP; sleep {marker}", "--keys", keys, "--timeout", "30")
    until = time.monotonic() + 10
    while not list((tmp_path / "tmp").glob("tui-shot-home-*/ready")):
        assert time.monotonic() < until and proc.poll() is None
        time.sleep(0.05)
    proc.send_signal(sig)
    code = finish(proc, 5)
    assert not alive(marker) and not homes_left(tmp_path)
    assert code == 128 + sig


def test_first_output_is_read_while_a_run_step_runs(shot, tmp_path):
    code, out = run_tool(shot, tmp_path, "--cmd", "echo hi; sleep 2.5", "--keys", "run sleep 2")
    assert code == 0
    assert json.loads((out / "run.json").read_text())["first_output_ms"] < 1000


def test_typed_input_is_delivered_in_full_and_never_outlasts_timeout(tmp_path, marker):
    size = 2_000_000  # 端末の入力の詰まりより十分に大きい
    keys = tmp_path / "keys"
    keys.write_text(f"sleep 0.5\ntype {'a' * size}\nwait-exit 20\n")
    proc = spawn(tmp_path, "--cmd", f"stty raw -echo; head -c {size} | wc -c", "--keys", f"@{keys}", "--shot", "wc")
    assert finish(proc, 25) == 0
    assert str(size) in (tmp_path / "out" / "wc.txt").read_text()
    proc = spawn(tmp_path, "--cmd", f"stty raw -echo; sleep {marker}", "--keys", f"@{keys}", "--timeout", "2")
    assert finish(proc, 8) == 124
    assert not alive(marker) and not homes_left(tmp_path)
