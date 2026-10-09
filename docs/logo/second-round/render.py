import json
d = json.load(open("bitmap.json"))
LINES, MARK, WORD = d["lines"], d["mark"], d["word"]
BG, FG, ACC, DIM, MUTED, TILE = "#0f1420", "#e6e8ef", "#60a5fa", "#2e4670", "#8a93a6", "#141b2c"
COLOR = {"#": FG, "o": ACC, "~": DIM}

def pixels(lines, x0, y0, size, gap=0, radius=0, color=None):
    out = []
    for r, line in enumerate(lines):
        for c, ch in enumerate(line):
            if ch in COLOR:
                fill = color.get(ch, COLOR[ch]) if color else COLOR[ch]
                x, y, s = x0 + c * size + gap / 2, y0 + r * size + gap / 2, size - gap
                out.append(f'<rect x="{x:.1f}" y="{y:.1f}" width="{s:.1f}" height="{s:.1f}" rx="{radius}" fill="{fill}"/>')
    return "\n".join(out)

def svg(w, h, body, bg=BG):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n<rect width="{w}" height="{h}" fill="{bg}"/>\n{body}\n</svg>\n'

W, H = 1440, 840
cols, rows = len(LINES[0]), len(LINES)

# 1. ベタ塗りのピクセル
size = 18; x0 = (W - cols * size) / 2; y0 = (H - rows * size) / 2 - 10
files = {"pixel-solid.svg": svg(W, H, pixels(LINES, x0, y0, size))}

# 2. ドット（LED のように、すこし間を空けて角を丸める）
files["pixel-dots.svg"] = svg(W, H, pixels(LINES, x0, y0, size, gap=6, radius=4))

# 3. 端末の中（画面の雰囲気）
cell_w, cell_h = 14, 28   # 端末の 1 文字（縦長）。半ブロック 1 つ＝15×15 のピクセル
pw = cols * cell_w; term_w, term_h = 1200, 600
tx, ty = (W - term_w) / 2, (H - term_h) / 2
px0 = tx + (term_w - pw) / 2; py0 = ty + 150
chrome = f'''<rect x="{tx}" y="{ty}" width="{term_w}" height="{term_h}" rx="18" fill="{TILE}" stroke="#263454" stroke-width="2"/>
<circle cx="{tx+28}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+52}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+76}" cy="{ty+26}" r="7" fill="#3a4660"/>
<text x="{tx+36}" y="{ty+96}" font-family="JetBrains Mono" font-size="22" fill="{MUTED}">$ nagi</text>
<text x="{tx+36}" y="{ty+term_h-34}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">受信箱 0　今日 0　予定 0　あとで 0</text>
<text x="{tx+term_w-36}" y="{ty+term_h-34}" text-anchor="end" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">ローカル</text>
<text x="{tx+36}" y="{ty+term_h-74}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{FG}">Enter で始める　<tspan fill="{MUTED}">q で終了</tspan></text>'''
files["terminal.svg"] = svg(W, H, chrome + pixels(LINES, px0, py0, cell_w))

# 4. アイコン（印だけ。角丸の正方形）
S = 512; m_cols, m_rows = len(MARK[0]), len(MARK); ps = 18
mx, my = (S - m_cols * ps) / 2, (S - m_rows * ps) / 2 + 4
files["icon.svg"] = f'<svg xmlns="http://www.w3.org/2000/svg" width="{S}" height="{S}" viewBox="0 0 {S} {S}">\n<rect width="{S}" height="{S}" rx="116" fill="{TILE}"/>\n{pixels(MARK, mx, my, ps)}\n</svg>\n'

# 5. 白地の版（ワードマーク＋印）
light = {"#": "#0f1420", "o": "#3b82f6", "~": "#bfd3f7"}
files["pixel-light.svg"] = svg(W, H, pixels(LINES, x0, y0, size, color=light), bg="#f6f7fb")

# 6. 小さいサイズでの見え方（左から大きい順。端末の 1 文字＝ピクセル 1 つのときに近い大きさも）
small = ""
gx = 120
for ps in [14, 9, 6, 4]:
    tw = m_cols * ps + 2 * 6 * ps // 2 + 40
    pad = (tw - m_cols * ps) / 2
    gy = 420 - (m_rows * ps + 2 * pad) / 2
    small += f'<rect x="{gx}" y="{gy}" width="{tw}" height="{m_rows*ps + 2*pad}" rx="{tw*0.22}" fill="{TILE}"/>'
    small += pixels(MARK, gx + pad, gy + pad, ps)
    small += f'<text x="{gx + tw/2}" y="{gy + m_rows*ps + 2*pad + 40}" text-anchor="middle" font-family="Plus Jakarta Sans" font-size="24" fill="{MUTED}">{int(tw)}px</text>'
    gx += tw + 60
files["sizes.svg"] = svg(W, H, small)

for name, text in files.items():
    open(name, "w").write(text)
print(" ".join(files))
