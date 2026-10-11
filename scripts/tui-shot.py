#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.13"
# dependencies = ["pyte", "pillow"]
# ///
"""nagi の TUI（または任意のコマンド）を PTY で動かし、画面を PNG とテキストに撮る。

隔離した HOME・固定の端末サイズ・キーの台本で動かすので、運用者のデータには触れず、
毎回同じ画面が撮れる。使い方は `scripts/tui-shot.py --help` と README の「テスト」。
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from dataclasses import dataclass
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parent.parent
# 素の ESC を送ったあとに置く間（秒）。crossterm に時間切れはなく、読んだ時点で後続のバイトがあるかだけで決まる。
# 1ms でも通ったが、混んだ CPU でも別のキーとして読まれるよう 50ms にしている
ESC_SETTLE = 0.05
DEFAULT_BIN = REPO_ROOT / "tui" / "target" / "release" / "nagi"
SCRUBBED_ENV = ("NAGI_TOKEN", "NAGI_SERVER", "NO_COLOR")  # NO_COLOR は crossterm が色を落とすので、継いだ値で画面が変わらないようにする
FIXED_ENV = {
    "TERM": "xterm-256color",
    "COLORTERM": "truecolor",
    "TZ": "Asia/Tokyo",
    "LANG": "C.UTF-8",
}
FONT_SIZE = 18
DEFAULT_FG = (229, 229, 229)
DEFAULT_BG = (0, 0, 0)
TIMEOUT_EXIT = 124
# 一度に読み切る回数の上限。出し続ける子（yes など）でも、撮ったり時間切れを確かめたりへ戻れるようにする
DRAIN_READS = 64
TERM_SIGNALS = (signal.SIGTERM, signal.SIGINT)

# xterm の標準の 16 色。pyte は色を名前（ANSI）か 6 桁の 16 進で返す。
ANSI_RGB = {
    "black": (0, 0, 0),
    "red": (205, 0, 0),
    "green": (0, 205, 0),
    "brown": (205, 205, 0),
    "blue": (0, 0, 238),
    "magenta": (205, 0, 205),
    "cyan": (0, 205, 205),
    "white": (229, 229, 229),
    "brightblack": (127, 127, 127),
    "brightred": (255, 0, 0),
    "brightgreen": (0, 255, 0),
    "brightbrown": (255, 255, 0),
    "brightblue": (92, 92, 255),
    "brightmagenta": (255, 0, 255),
    "brightcyan": (0, 255, 255),
    "brightwhite": (255, 255, 255),
}


class ScriptError(ValueError):
    pass


class Timeout(Exception):
    pass


class Terminated(Exception):
    def __init__(self, signum: int):
        super().__init__(signal.Signals(signum).name)
        self.signum = signum


# 届いた SIGTERM/SIGINT のうち最初のもの。ハンドラは記すだけで、Terminated は Session の待ちの輪か片付けのあとで上げる。
# ハンドラが例外を上げると、続けて届いたシグナルが片付けの途中（子の起動直後や killpg の手前）を飛ばしてしまう
_stop_signal: int | None = None


def _terminate(signum, _frame) -> None:
    global _stop_signal
    if _stop_signal is None:
        _stop_signal = signum


def _has_exited(pid: int) -> bool:
    """刈り取らずに終わったかだけを見る。ゾンビが pid を持ち続けるので、あとの killpg が別のグループに当たらない。

    macOS の os.waitid は Python 3.13 から。"""
    return os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def _killpg(pgid: int) -> None:
    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        pass


# ---- キーの台本 -------------------------------------------------------------


@dataclass(frozen=True)
class Step:
    verb: str
    arg: str


VERBS = ("sleep", "type", "key", "shot", "resize", "run", "wait-exit")
SLUG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def parse_size(text: str) -> tuple[int, int]:
    m = re.fullmatch(r"(\d+)x(\d+)", text.strip())
    if not m or int(m[1]) < 1 or int(m[2]) < 1:
        raise ScriptError(f"bad size {text!r} (want COLSxROWS)")
    return int(m[1]), int(m[2])


def _validate(step: Step) -> Step:
    verb, arg = step.verb, step.arg
    if verb not in VERBS:
        raise ScriptError(f"unknown step {verb!r} (steps: {', '.join(VERBS)})")
    if verb in ("sleep", "wait-exit"):
        try:
            if float(arg) < 0:
                raise ValueError
        except ValueError:
            raise ScriptError(f"{verb}: want seconds, got {arg!r}") from None
    elif verb == "key":
        key_bytes(arg)
    elif verb == "shot":
        if not SLUG_RE.match(arg):
            raise ScriptError(f"shot: bad slug {arg!r}")
    elif verb == "resize":
        parse_size(arg)
    elif not arg:
        raise ScriptError(f"{verb}: argument required")
    return step


def parse_step(text: str) -> Step | None:
    text = text.strip()
    if not text or text.startswith("#"):
        return None
    verb, _, arg = text.partition(" ")
    return _validate(Step(verb, arg.strip()))


def parse_script(spec: str) -> list[Step]:
    """`@PATH` は 1 行 1 手順のファイル（`;` は区切りにしない）。それ以外は `;` 区切り（`\\;` は文字の `;`）。"""
    if spec.startswith("@"):
        lines = Path(spec[1:]).read_text(encoding="utf-8").splitlines()
    else:
        lines = [p.replace("\\;", ";") for p in re.split(r"(?<!\\);", spec)]
    return [s for s in map(parse_step, lines) if s]


# ---- キー名 → xterm のバイト列 ------------------------------------------------

# 修飾キーの数は xterm と同じ。1 + shift(1) + alt(2) + ctrl(4)
MODIFIER_BITS = {"shift": 1, "alt": 2, "meta": 2, "ctrl": 4}
CURSOR_KEYS = {"up": "A", "down": "B", "right": "C", "left": "D", "home": "H", "end": "F"}
TILDE_KEYS = {"insert": 2, "delete": 3, "pageup": 5, "pagedown": 6}
FUNCTION_KEYS = {
    "f1": ("O", "P"), "f2": ("O", "Q"), "f3": ("O", "R"), "f4": ("O", "S"),
    "f5": ("~", 15), "f6": ("~", 17), "f7": ("~", 18), "f8": ("~", 19),
    "f9": ("~", 20), "f10": ("~", 21), "f11": ("~", 23), "f12": ("~", 24),
}  # fmt: skip
PLAIN_KEYS = {
    "enter": "\r", "return": "\r", "esc": "\x1b", "escape": "\x1b", "tab": "\t",
    "backspace": "\x7f", "space": " ",
}  # fmt: skip


def _split_modifiers(name: str) -> tuple[int, str]:
    bits = 0
    while "+" in name[1:]:
        head, _, rest = name.partition("+")
        if head.lower() not in MODIFIER_BITS:
            break
        bits |= MODIFIER_BITS[head.lower()]
        name = rest
    return bits, name


def key_bytes(name: str) -> bytes:
    bits, base = _split_modifiers(name.strip())
    low = base.lower()
    mod = 1 + bits
    if low in CURSOR_KEYS:
        final = CURSOR_KEYS[low]
        seq = f"\x1b[{final}" if mod == 1 else f"\x1b[1;{mod}{final}"
    elif low in TILDE_KEYS:
        n = TILDE_KEYS[low]
        seq = f"\x1b[{n}~" if mod == 1 else f"\x1b[{n};{mod}~"
    elif low in FUNCTION_KEYS:
        kind, code = FUNCTION_KEYS[low]
        if kind == "O":
            seq = f"\x1bO{code}" if mod == 1 else f"\x1b[1;{mod}{code}"
        else:
            seq = f"\x1b[{code}~" if mod == 1 else f"\x1b[{code};{mod}~"
    elif low == "tab" and bits == MODIFIER_BITS["shift"]:
        seq = "\x1b[Z"
    elif low in PLAIN_KEYS:
        seq = PLAIN_KEYS[low]
        if bits & MODIFIER_BITS["ctrl"] and low == "space":
            seq = "\x00"
        if bits & MODIFIER_BITS["alt"]:
            seq = "\x1b" + seq
    elif len(base) == 1:
        ch = base
        if bits & MODIFIER_BITS["ctrl"]:
            code = ord(ch.upper()) ^ 0x40
            if not 0x40 <= ord(ch.upper()) <= 0x5F:
                raise ScriptError(f"key: no control byte for {name!r}")
            ch = chr(code)
        elif bits & MODIFIER_BITS["shift"]:
            ch = ch.upper()
        seq = ("\x1b" + ch) if bits & MODIFIER_BITS["alt"] else ch
    else:
        raise ScriptError(f"key: unknown key {name!r}")
    return seq.encode("utf-8")


# ---- 色・字形・PNG ----------------------------------------------------------


def color_rgb(value: str, default: tuple[int, int, int]) -> tuple[int, int, int]:
    if value == "default":
        return default
    if value in ANSI_RGB:
        return ANSI_RGB[value]
    if re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)
    raise ValueError(f"unknown color {value!r}")


def cell_colors(char, cursor: bool = False):
    fg = color_rgb(char.fg, DEFAULT_FG)
    bg = color_rgb(char.bg, DEFAULT_BG)
    if char.reverse != cursor:
        fg, bg = bg, fg
    return fg, bg


def layout_row(screen, y: int) -> list[tuple[int, str, int]]:
    """1 行を (開始セル, 文字, 占めるセル数) にする。pyte は幅 2 の文字の次のセルを空文字で埋める。"""
    row, out, x = screen.buffer[y], [], 0
    while x < screen.columns:
        data = row[x].data
        span = 2 if x + 1 < screen.columns and row[x + 1].data == "" else 1
        out.append((x, data, span))
        x += span
    return out


def screen_text(screen) -> str:
    lines = ("".join(d for _, d, _ in layout_row(screen, y)).rstrip() for y in range(screen.lines))
    return "\n".join(lines) + "\n"


class Font:
    def __init__(self, font: ImageFont.FreeTypeFont, path: str | None):
        self.font = font
        self.path = path
        ascent, descent = font.getmetrics()
        self.ascent = ascent
        self.cell_h = ascent + descent + 2
        self.cell_w = max(1, round(font.getlength("0")))
        self._masks: dict[tuple[str, bool, int], Image.Image] = {}

    @classmethod
    def load(cls, path: str | None = None) -> Font:
        if path is None:
            try:
                path = subprocess.run(
                    ["fc-match", "-f", "%{file}", "monospace:lang=ja"],
                    capture_output=True, text=True, check=True,
                ).stdout.strip() or None  # fmt: skip
            except (OSError, subprocess.CalledProcessError):
                path = None
        if path is None:
            print("tui-shot: no font found; use --font PATH (CJK glyphs will be missing)", file=sys.stderr)
            return cls(ImageFont.load_default(FONT_SIZE), None)
        return cls(ImageFont.truetype(path, FONT_SIZE), path)

    def mask(self, data: str, bold: bool, span: int) -> Image.Image:
        """字形はセルの幅で切る。隣のセルにはみ出させない。"""
        key = (data, bold, span)
        if key not in self._masks:
            mask = Image.new("L", (self.cell_w * span, self.cell_h), 0)
            draw = ImageDraw.Draw(mask)
            for dx in (0, 1) if bold else (0,):
                draw.text((dx, self.ascent + 1), data, font=self.font, fill=255, anchor="ls")
            self._masks[key] = mask
        return self._masks[key]


def render_png(screen, font: Font) -> Image.Image:
    cw, ch = font.cell_w, font.cell_h
    img = Image.new("RGB", (screen.columns * cw, screen.lines * ch), DEFAULT_BG)
    draw = ImageDraw.Draw(img)
    cursor = None if screen.cursor.hidden else (screen.cursor.x, screen.cursor.y)
    for y in range(screen.lines):
        py = y * ch
        for x, data, span in layout_row(screen, y):
            char = screen.buffer[y][x]
            fg, bg = cell_colors(char, cursor == (x, y))
            px = x * cw
            draw.rectangle((px, py, px + cw * span - 1, py + ch - 1), fill=bg)
            if data.strip():
                img.paste(fg, (px, py, px + cw * span, py + ch), font.mask(data, char.bold, span))
            if char.underscore:
                draw.line((px, py + ch - 2, px + cw * span - 1, py + ch - 2), fill=fg)
            if char.strikethrough:
                draw.line((px, py + ch // 2, px + cw * span - 1, py + ch // 2), fill=fg)
    return img


# ---- PTY ----------------------------------------------------------------------


def set_winsize(fd: int, cols: int, rows: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


class TermScreen(pyte.Screen):
    """crossterm のカーソル位置の問い合わせ（ESC[6n）などへの答えを、子への入力の列に積む。書くのは Session。

    PTY は書き込みで待たないので、子が入力を読まず詰まっているとその場では書けない。台本の入力と同じ列で順に書く。"""

    def __init__(self, columns: int, lines: int):
        super().__init__(columns, lines)
        self.outbox = bytearray()

    def write_process_input(self, data: str) -> None:
        self.outbox += data.encode()


class Session:
    def __init__(self, argv: list[str], env: dict[str, str], cwd: str, size: tuple[int, int], deadline: float):
        self.t0 = time.monotonic()
        self.deadline = deadline
        self.screen = TermScreen(*size)
        self.stream = pyte.ByteStream(self.screen)
        self.output_bytes = 0
        self.first_output_ms: float | None = None
        self.read_counts: dict[int, int] = {}
        self.eof = False
        self.done = False
        self.status: int | None = None
        cols, rows = size
        pid, fd = pty.fork()
        if pid == 0:
            try:
                set_winsize(0, cols, rows)  # 子が最初に端末の大きさを読むより前に決める
                os.chdir(cwd)
                os.execvpe(argv[0], argv, env)
            except BaseException as e:
                os.write(2, f"tui-shot: exec {argv[0]}: {e}\n".encode())
                os._exit(127)
        self.pid, self.fd = pid, fd
        os.set_blocking(fd, False)

    # 読み書き
    def _read(self) -> None:
        try:
            data = os.read(self.fd, 65536)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            self.eof = True
            return
        elapsed = time.monotonic() - self.t0
        if self.first_output_ms is None:
            self.first_output_ms = elapsed * 1000
        self.read_counts[int(elapsed)] = self.read_counts.get(int(elapsed), 0) + 1
        self.output_bytes += len(data)
        self.stream.feed(data)

    def _write(self) -> None:
        outbox = self.screen.outbox
        try:
            del outbox[: os.write(self.fd, outbox)]
        except BlockingIOError:
            pass
        except OSError:
            outbox.clear()

    def _io(self, timeout: float) -> bool:
        """読めれば読み、子への入力が積まれていれば書けるだけ書く。どちらもできなければ False。"""
        reads = [] if self.eof else [self.fd]
        writes = [self.fd] if self.screen.outbox and not self.done else []
        r, w, _ = select.select(reads, writes, [], timeout)
        if r:
            self._read()
        if w:
            self._write()
        return bool(r or w)

    def _check(self) -> float:
        """止めるシグナルか時間切れなら例外にする。残りの秒を返す。"""
        if _stop_signal is not None:
            raise Terminated(_stop_signal)
        left = self.deadline - time.monotonic()
        if left <= 0:
            raise Timeout
        return left

    def _drain(self) -> None:
        for _ in range(DRAIN_READS):
            self._check()
            if self.eof or not select.select([self.fd], [], [], 0)[0]:
                return
            self._read()

    def _poll_exit(self) -> None:
        if not self.done and _has_exited(self.pid):
            self._drain()
            self.done = True

    def pump(self, seconds: float, stop_on_exit: bool = False) -> None:
        until = time.monotonic() + seconds
        while not (self.done and stop_on_exit):
            wait = min(until - time.monotonic(), self._check())
            if wait <= 0:
                break
            if self.done or self.eof:
                time.sleep(min(wait, 0.01))
                self._poll_exit()
            elif not self._io(min(wait, 0.05)):
                self._poll_exit()
        self._drain()

    def send(self, data: bytes) -> None:
        """端末の答えと同じ列に積んで書き切る。待つ間も子の出力を読む。子が入力を読まなくても、時間切れで抜けられる。"""
        self.screen.outbox += data
        while self.screen.outbox and not self.done:
            self._io(min(self._check(), 0.05))
            self._poll_exit()

    def resize(self, cols: int, rows: int) -> None:
        self.screen.resize(rows, cols)
        if not self.done:
            set_winsize(self.fd, cols, rows)  # カーネルが前面のプロセスグループに SIGWINCH を送る

    def kill(self) -> None:
        _killpg(self.pid)  # 親が先に終わっても、HUP を無視して残る子がいる
        _, self.status = os.waitpid(self.pid, 0)
        os.close(self.fd)

    @property
    def exit_code(self) -> int | None:
        return None if self.status is None else os.waitstatus_to_exitcode(self.status)


# ---- 実行 ---------------------------------------------------------------------


def build_env(args, home: str) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k not in SCRUBBED_ENV}
    env.update(
        HOME=home,
        XDG_CONFIG_HOME=os.path.join(home, ".config"),
        XDG_DATA_HOME=os.path.join(home, ".local", "share"),
        **FIXED_ENV,
    )
    for item in args.env:
        name, sep, value = item.partition("=")
        if not sep or not name:
            raise ScriptError(f"--env wants NAME=VALUE, got {item!r}")
        env[name] = value
    for name in args.unset:
        env.pop(name, None)
    return env


def build_argv(args) -> list[str]:
    if args.cmd is not None:
        if args.bin is not None or args.args:
            raise ScriptError("--cmd cannot be combined with --bin or trailing ARGS")
        return ["bash", "-c", args.cmd]
    binary = args.bin or str(DEFAULT_BIN)
    if "/" in binary:
        binary = os.path.abspath(binary)
    return [binary, *args.args]


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="tui-shot.py",
        description="PTY で TUI（または --cmd のコマンド）を動かして PNG とテキストに撮る。"
        " 台本の手順: sleep S / type TEXT / key NAME / shot SLUG / resize COLSxROWS / run SHELL / wait-exit S",
    )
    p.add_argument("--bin", help="動かすバイナリ（既定 tui/target/release/nagi）")
    p.add_argument("--cmd", help="bash -c で動かすコマンド。終わったら最後の画面を撮る")
    p.add_argument("--size", default="120x36", help="COLSxROWS（既定 120x36）")
    p.add_argument("--keys", default="", help="台本。`;` 区切り、または @PATH（1 行 1 手順）")
    p.add_argument("--shot", help="終了後に撮る画面の名前（--cmd は既定 screen）")
    p.add_argument("--out-dir", default=str(Path(tempfile.gettempdir()) / "tui-shot"))
    p.add_argument("--home", help="HOME（なければ一時のフォルダ。終わったら消す）")
    p.add_argument("--cwd", help="作業のフォルダ（既定は今のフォルダ）")
    p.add_argument("--env", action="append", default=[], metavar="NAME=VALUE")
    p.add_argument("--unset", action="append", default=[], metavar="NAME")
    p.add_argument("--timeout", type=float, default=30.0, help="秒。過ぎたらプロセスグループを SIGKILL して 124 で終わる")
    p.add_argument("--font", help="TTF/TTC のパス（既定は fc-match 'monospace:lang=ja'）")
    p.add_argument("args", nargs="*", help="-- のあとは --bin に渡す引数")
    return p.parse_args(argv)


def run(args: argparse.Namespace) -> int:
    global _stop_signal
    size = parse_size(args.size)
    steps = parse_script(args.keys)
    argv = build_argv(args)
    cwd = os.path.abspath(args.cwd) if args.cwd else os.getcwd()
    font = Font.load(args.font)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    own_home = args.home is None
    home = None if own_home else os.path.abspath(args.home)
    started = time.monotonic()
    shots: list[dict] = []
    runs: list[dict] = []
    timed_out = False
    session: Session | None = None

    def shot(slug: str) -> None:
        t = time.monotonic()
        session.pump(0)
        render_png(session.screen, font).save(out_dir / f"{slug}.png")
        (out_dir / f"{slug}.txt").write_text(screen_text(session.screen), encoding="utf-8")
        shots.append(
            {
                "slug": slug,
                "png": str(out_dir / f"{slug}.png"),
                "txt": str(out_dir / f"{slug}.txt"),
                "cols": session.screen.columns,
                "rows": session.screen.lines,
                "render_ms": round((time.monotonic() - t) * 1000, 1),
            }
        )

    def run_step(cmd: str) -> None:
        # PTY を読み続けながら待つ。止めるときは後ろに回したものも含めてグループごと終わらせる
        with tempfile.TemporaryFile() as log:
            proc = subprocess.Popen(
                ["bash", "-c", cmd], env=env, cwd=cwd, stdout=log, stderr=log, start_new_session=True
            )
            try:
                while not _has_exited(proc.pid):
                    session.pump(0.01)
            finally:
                _killpg(proc.pid)
                proc.wait()
            log.seek(0)
            sys.stderr.write(log.read().decode("utf-8", errors="replace"))
        runs.append({"cmd": cmd, "exit_code": proc.returncode})

    _stop_signal = None
    previous = {s: signal.signal(s, _terminate) for s in TERM_SIGNALS}
    try:
        if own_home:
            home = tempfile.mkdtemp(prefix="tui-shot-home-")
        env = build_env(args, home)
        session = Session(argv, env, cwd, size, started + args.timeout)
        try:
            for step in steps:
                if step.verb == "sleep":
                    session.pump(float(step.arg))
                elif step.verb == "type":
                    session.send(step.arg.encode("utf-8"))
                elif step.verb == "key":
                    data = key_bytes(step.arg)
                    session.send(data)
                    if data == b"\x1b":
                        # crossterm は ESC の直後に入力が続いていると Alt+キーと読む。次を別のキーにするため少し待つ
                        session.pump(ESC_SETTLE)
                elif step.verb == "shot":
                    shot(step.arg)
                elif step.verb == "resize":
                    session.resize(*parse_size(step.arg))
                elif step.verb == "wait-exit":
                    session.pump(float(step.arg), stop_on_exit=True)
                else:
                    run_step(step.arg)
            session.pump(float("inf"), stop_on_exit=True)
            final = args.shot or ("screen" if args.cmd is not None else None)
            if final:
                shot(final)
        except Timeout:
            timed_out = True
    finally:
        try:
            if session is not None:
                session.kill()
            if own_home and home is not None:
                shutil.rmtree(home, ignore_errors=True)
        finally:
            for s, handler in previous.items():
                signal.signal(s, handler)
    if _stop_signal is not None:
        raise Terminated(_stop_signal)

    wall = time.monotonic() - started
    buckets = int(wall) + 1
    exit_code = None if session is None else session.exit_code
    report = {
        "command": argv,
        "size": args.size,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "wall_ms": round(wall * 1000, 1),
        "first_output_ms": None if session.first_output_ms is None else round(session.first_output_ms, 1),
        "writes_per_sec": [session.read_counts.get(i, 0) for i in range(buckets)],
        "output_bytes": session.output_bytes,
        "shots": shots,
        "runs": runs,
    }
    (out_dir / "run.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for s in shots:
        print(s["png"])
    if timed_out:
        return TIMEOUT_EXIT
    return exit_code or 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        return run(args)
    except (ScriptError, OSError) as e:
        print(f"tui-shot: {e}", file=sys.stderr)
        return 2
    except Terminated as e:
        print(f"tui-shot: stopped by {e}", file=sys.stderr)
        return 128 + e.signum


if __name__ == "__main__":
    sys.exit(main())
