import json, sys, html
d = json.load(open(sys.argv[1])); out = sys.argv[2]
BG, TILE, MUTED, FG = "#0f1420", "#141b2c", "#8a93a6", "#e6e8ef"
W, H = 1440, 840
cw, chh = 16, 32   # セルの幅と高さ（JetBrains Mono の 0.6em ≒ 16 → font-size 26.7）
fs = cw / 0.6
cols, rows = d["cols"], d["rows"]
term_w, term_h = 1200, 620; tx, ty = (W - term_w) / 2, (H - term_h) / 2
x0 = tx + (term_w - cols * cw) / 2; y0 = ty + 150
def rgb(c): return "#%02x%02x%02x" % tuple(c)
def cell(c, r, ch, col):
    x, y = x0 + c * cw, y0 + r * chh
    # ブロックは端末と同じくセルを塗りつぶす（字形だと行の間にすき間が出る）
    if ch == "█": return f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw}" height="{chh}" fill="{rgb(col)}"/>'
    if ch == "▀": return f'<rect x="{x:.1f}" y="{y:.1f}" width="{cw}" height="{chh/2}" fill="{rgb(col)}"/>'
    if ch == "▄": return f'<rect x="{x:.1f}" y="{y + chh/2:.1f}" width="{cw}" height="{chh/2}" fill="{rgb(col)}"/>'
    return f'<text x="{x:.1f}" y="{y + chh*0.78:.1f}" font-family="JetBrains Mono" font-size="{fs:.1f}" fill="{rgb(col)}">{html.escape(ch)}</text>'
glyphs = "\n".join(cell(*c) for c in d["cells"])
chrome = f'''<rect x="{tx}" y="{ty}" width="{term_w}" height="{term_h}" rx="18" fill="{TILE}" stroke="#263454" stroke-width="2"/>
<circle cx="{tx+28}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+52}" cy="{ty+26}" r="7" fill="#3a4660"/><circle cx="{tx+76}" cy="{ty+26}" r="7" fill="#3a4660"/>
<text x="{tx+36}" y="{ty+96}" font-family="JetBrains Mono" font-size="22" fill="{MUTED}">$ nagi</text>
<text x="{tx+36}" y="{ty+term_h-74}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{FG}">Enter で始める　<tspan fill="{MUTED}">q で終了</tspan></text>
<text x="{tx+36}" y="{ty+term_h-34}" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">受信箱 0　今日 0　予定 0　あとで 0</text>
<text x="{tx+term_w-36}" y="{ty+term_h-34}" text-anchor="end" font-family="JetBrains Mono, Source Han Sans JP, Source Han Sans" font-size="20" fill="{MUTED}">ローカル</text>'''
open(out, "w").write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">\n<rect width="{W}" height="{H}" fill="{BG}"/>\n{chrome}\n{glyphs}\n</svg>\n')
