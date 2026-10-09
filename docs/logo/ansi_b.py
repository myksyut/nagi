"""第 3 案 B：大文字のブロック体（figlet の ANSI Shadow）にグラデーション、下に水平線と太陽。
文字の配置（端末のセル）をそのまま SVG に描く"""
import subprocess, json
def lerp(a, b, t): return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))
font_dir = "/tmp/claude-10001/-home-miyakishota-nagi/4b243fb8-30ff-4f34-bb26-352888f163d7/scratchpad/flf"
art = subprocess.run(["nix", "shell", "nixpkgs#figlet", "-c", "figlet", "-d", font_dir, "-f", "ANSI Shadow", "nagi"], capture_output=True, text=True).stdout.rstrip("\n").split("\n")
art = [l.rstrip() for l in art if l.strip()]
width = max(len(l) for l in art)
TOP, BOT = (186, 230, 253), (96, 165, 250)        # 空色 → 青
SHADOW_TOP, SHADOW_BOT = (70, 110, 170), (40, 60, 110)
cells = []   # (col, row, char, color)
for r, line in enumerate(art):
    t = r / (len(art) - 1)
    for c, ch in enumerate(line):
        if ch == " ": continue
        col = lerp(TOP, BOT, t) if ch == "█" else lerp(SHADOW_TOP, SHADOW_BOT, t)
        cells.append((c + 2, r, ch, col))
R = len(art)
# 水平線（細い）と、太陽（半ブロック）、反射
line_w = width + 12
for c in range(line_w): cells.append((c, R + 1, "─", (90, 130, 200)))
sx = width + 6
sun = [("▄██▄", 0), ("████", 1), ("▀██▀", 2)]
for text, dr in sun:
    for i, ch in enumerate(text):
        if ch != " ": cells.append((sx + i, R - 2 + dr, ch, lerp((250, 206, 120), (240, 140, 90), dr / 2)))
for i, ch in enumerate("▀▀▀▀"): cells.append((sx + i, R + 2, ch, (120, 85, 90)))
tag = "calm todo for the terminal"
for i, ch in enumerate(tag): cells.append((2 + i, R + 3, ch, (138, 147, 166)))
json.dump({"cols": line_w, "rows": R + 4, "cells": cells}, open("ansi_b.json", "w"))
print("\n".join(art)); print(width, "列")
