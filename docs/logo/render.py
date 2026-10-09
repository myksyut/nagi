import json
d = json.load(open("bitmap.json"))
BG, TILE, MUTED, FG = "#0f1420", "#141b2c", "#8a93a6", "#e6e8ef"
def rgb(c): return "#%02x%02x%02x" % tuple(c)
def pixels(x0, y0, size, gap=0, radius=0):
    return "\n".join(f'<rect x="{x0 + c*size + gap/2:.1f}" y="{y0 + r*size + gap/2:.1f}" width="{size-gap:.1f}" height="{size-gap:.1f}" rx="{radius}" fill="{rgb(col)}"/>' for c, r, col in d["pixels"])
def svg(w, h, body, bg=BG):
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n<rect width="{w}" height="{h}" fill="{bg}"/>\n{body}\n</svg>\n'
W, H = 1440, 840
cols, rows = d["cols"], d["rows"]
size = 22; x0 = (W - cols*size)/2; y0 = (H - rows*size)/2
files = {"solid.svg": svg(W, H, pixels(x0, y0, size)), "dots.svg": svg(W, H, pixels(x0, y0, size, gap=6, radius=4))}
cell = 14; term_w, term_h = 1200, 620; tx, ty = (W-term_w)/2, (H-term_h)/2
px0 = tx + (term_w - cols*cell)/2; py0 = ty + 130
chrome = f'''<rect x="{tx}" y="{ty}" width="{term_w}" height="{term_h}" rx="18" fill="{TILE}" stroke="#263454" stroke-width="2"/>
<circle cx="{tx+28}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+52}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+76}" cy="{ty+26}" r="7" fill="#3a4660"/>
<text x="{tx+36}" y="{ty+96}" font-family="JetBrains Mono" font-size="22" fill="{MUTED}">$ nagi</text>
<text x="{tx+36}" y="{ty+term_h-74}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{FG}">Enter で始める　<tspan fill="{MUTED}">q で終了</tspan></text>
<text x="{tx+36}" y="{ty+term_h-34}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">受信箱 0　今日 0　予定 0　あとで 0</text>
<text x="{tx+term_w-36}" y="{ty+term_h-34}" text-anchor="end" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">ローカル</text>'''
files["terminal.svg"] = svg(W, H, chrome + pixels(px0, py0, cell))
for n, t in files.items(): open(n, "w").write(t)
