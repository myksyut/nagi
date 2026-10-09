"""nagi のピクセルのロゴ。1 つのビットマップから、端末用（半ブロック文字）と SVG を作る。
線の太さ 3px、x-height 12 行。角は 1px 落として丸く見せる"""
import json, sys

N = ["..#######..", ".#########.", "###########", "####...####", "###.....###", "###.....###",
     "###.....###", "###.....###", "###.....###", "###.....###", "###.....###", "###.....###"]
A = ["..#########", ".##########", "###########", "####...####", "###.....###", "###.....###",
     "###.....###", "###.....###", "####...####", "###########", ".##########", "..#########"]
G = A + [
     "........###", "###.....###", "###########", ".#########."]
I_DOT = ["###", "###", "###"]
I = ["###"] * 12

ROWS = 20          # 0-2 点、3 空き、4-15 x-height、16-19 下
TOP = 4
def blank(w): return [["."] * w for _ in range(ROWS)]

def place(canvas, bitmap, x, y, ch="#"):
    for r, line in enumerate(bitmap):
        for c, v in enumerate(line):
            if v == "#":
                canvas[y + r][x + c] = ch

def wordmark():
    cv = blank(11 + 3 + 11 + 3 + 11 + 3 + 3)
    x = 0
    place(cv, N, x, TOP); x += 14
    place(cv, A, x, TOP); x += 14
    place(cv, G, x, TOP); x += 14
    place(cv, I_DOT, x, 0)
    place(cv, I, x, TOP)
    return cv

SUN = ["...####...", ".########.", "##########", "##########", "##########", "##########",
       "##########", "##########", ".########.", "...####..."]

def mark():
    # 太陽（'o'）と水平線（'#'）、反射（'~'）。19 列 × 20 行
    cv = blank(19)
    place(cv, SUN, 4, 2, "o")
    for r in (13, 14, 15):
        for c in range(19): cv[r][c] = "#"
    for r in (18, 19):
        for c in range(5, 14): cv[r][c] = "~"
    return cv

def join(*canvases, gap=4):
    return [("." * gap).join("".join(cv[r]) for cv in canvases) for r in range(ROWS)]

def ansi(fg, bg=None):
    s = "\x1b[38;2;%d;%d;%dm" % fg
    return s + ("\x1b[48;2;%d;%d;%dm" % bg if bg else "\x1b[49m")

def halfblocks(lines, colors):
    """2 行を 1 行の文字にする。上下の塗りの組で ▀▄█ を選ぶ"""
    rows = []
    for r in range(0, len(lines), 2):
        top = lines[r]; bot = lines[r + 1] if r + 1 < len(lines) else "." * len(top)
        s = ""
        for t, b in zip(top, bot):
            t = t if t in colors else None; b = b if b in colors else None
            if t and b: s += (ansi(colors[t]) + "█") if t == b else (ansi(colors[t], colors[b]) + "▀")
            elif t: s += ansi(colors[t]) + "▀"
            elif b: s += ansi(colors[b]) + "▄"
            else: s += "\x1b[0m "
        rows.append(s + "\x1b[0m")
    return rows

def plainblocks(lines):
    """色なし（README 用）"""
    rows = []
    for r in range(0, len(lines), 2):
        top = lines[r]; bot = lines[r + 1] if r + 1 < len(lines) else "." * len(top)
        s = ""
        for t, b in zip(top, bot):
            t, b = t != ".", b != "."
            s += "█" if t and b else "▀" if t else "▄" if b else " "
        rows.append(s.rstrip())
    return rows

FG = (230, 232, 239); ACC = (96, 165, 250); DIM = (46, 70, 112)
COLORS = {"#": FG, "o": ACC, "~": DIM}

lines = join(mark(), wordmark())
if sys.argv[1:] == ["text"]:
    print("\n".join(halfblocks(lines, COLORS)))
elif sys.argv[1:] == ["plain"]:
    print("\n".join(plainblocks(lines)))
else:
    json.dump({"lines": lines, "mark": ["".join(r) for r in mark()], "word": ["".join(r) for r in wordmark()],
               "blocks": plainblocks(lines)}, open("bitmap.json", "w"), ensure_ascii=False, indent=0)
    print(f"{len(lines[0])} 列 × {len(lines)} 行（端末では {len(lines)//2} 行）")
