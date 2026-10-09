"""nagi のロゴ（第 3 案）。細い線（2px）・x-height 10・角を丸めた小文字。i の点が太陽で、水平線の上に字が載り、
g の下の部分と太陽の反射は水面の下（暗い青）。色は上から下へのグラデーション。
1 つのビットマップから、端末用（半ブロック文字＋ANSI の色）と SVG を作る"""
import json, sys

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

N = [".######.", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##"]
A = [".#######", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", "##....##", ".#######"]
G = A + ["......##", "......##", "##....##", ".######."]
I = ["##"] * 10
SUN = [".####.", "######", "######", ".####."]

ROWS = 22
X_TOP = 8           # x-height は 8〜17 行目
LINE_ROW = 18       # 水平線
LEFT, RIGHT = 8, 8  # 水平線が字の外へ伸びる長さ

def blank(w): return [["."] * w for _ in range(ROWS)]

def place(cv, bitmap, x, y, ch="#"):
    for r, line in enumerate(bitmap):
        for c, v in enumerate(line):
            if v == "#": cv[y + r][x + c] = ch

def build():
    word_w = 8 + 3 + 8 + 3 + 8 + 3 + 2
    cv = blank(LEFT + word_w + RIGHT)
    x = LEFT
    place(cv, N, x, X_TOP); x += 11
    place(cv, A, x, X_TOP); x += 11
    place(cv, G, x, X_TOP); gx = x; x += 11
    place(cv, I, x, X_TOP)
    place(cv, SUN, x - 2, 2, "o")               # 太陽（i の点）
    for c in range(len(cv[0])): cv[LINE_ROW][c] = "="   # 水平線（1px）
    for r in range(LINE_ROW + 1, ROWS):           # 水面の下：g の下の部分は '~'
        for c in range(len(cv[0])):
            if cv[r][c] == "#": cv[r][c] = "~"
    for c in range(x - 3, x + 5): cv[20][c] = "r"  # 太陽の反射
    for c in range(x - 1, x + 3): cv[21][c] = "r"
    return ["".join(r) for r in cv]

# 色（上から下へ）
TEXT_TOP, TEXT_BOT = (244, 246, 251), (170, 200, 245)
SUN_TOP, SUN_BOT = (250, 206, 120), (240, 140, 90)
WATER_TOP, WATER_BOT = (70, 105, 165), (38, 58, 100)
LINE = (120, 160, 220)
REFL = (210, 150, 100)

def color(ch, r):
    if ch == "#": return lerp(TEXT_TOP, TEXT_BOT, (r - X_TOP) / 9)
    if ch == "o": return lerp(SUN_TOP, SUN_BOT, (r - 2) / 3)
    if ch == "~": return lerp(WATER_TOP, WATER_BOT, (r - 19) / 3)
    if ch == "=": return LINE
    if ch == "r": return lerp((190, 120, 85), (110, 80, 90), (r - 20) / 1)
    return None

def ansi(fg, bg=None):
    s = "\x1b[38;2;%d;%d;%dm" % fg
    return s + ("\x1b[48;2;%d;%d;%dm" % bg if bg else "\x1b[49m")

def halfblocks(lines):
    rows = []
    for r in range(0, len(lines), 2):
        top, bot = lines[r], lines[r + 1]
        s = ""
        for c, (t, b) in enumerate(zip(top, bot)):
            ct, cb = color(t, r), color(b, r + 1)
            if ct and cb: s += (ansi(ct) + "█") if ct == cb else (ansi(ct, cb) + "▀")
            elif ct: s += ansi(ct) + "▀"
            elif cb: s += ansi(cb) + "▄"
            else: s += "\x1b[0m "
        rows.append(s + "\x1b[0m")
    return rows

def plainblocks(lines):
    rows = []
    for r in range(0, len(lines), 2):
        top, bot = lines[r], lines[r + 1]
        s = "".join("█" if t != "." and b != "." else "▀" if t != "." else "▄" if b != "." else " " for t, b in zip(top, bot))
        rows.append(s.rstrip())
    return rows

lines = build()
if sys.argv[1:] == ["text"]: print("\n".join(halfblocks(lines)))
elif sys.argv[1:] == ["plain"]: print("\n".join(plainblocks(lines)))
else:
    pixels = [[(c, r, color(ch, r)) for c, ch in enumerate(line) if color(ch, r)] for r, line in enumerate(lines)]
    json.dump({"cols": len(lines[0]), "rows": ROWS, "pixels": [p for row in pixels for p in row], "blocks": plainblocks(lines)}, open("bitmap.json", "w"))
    print(f"{len(lines[0])} 列 × {ROWS} 行（端末では {ROWS // 2} 行）")
