"""Hover-legend runs can lag the mouse by a few pixels, so bar x positions may be
shifted. Find the single offset that puts the most columns on a candle of the
bar's own colour (green close>open, red otherwise) and apply it to every bar."""
RED, GREEN = (242, 54, 69), (8, 153, 129)
def near(px, col, tol=14): return all(abs(px[k] - col[k]) <= tol for k in range(3))
def align(im, bars, meta):
    dpr = meta['dpr']; pane = meta['pane']; sp = meta.get('spacingCss', 6) * dpr
    y0, y1 = int(pane['y'] * dpr) + 2, int((pane['y'] + pane['h']) * dpr) - 2
    W = im.size[0]
    px = im.load()
    best = (0, -1)
    rng = int(sp * 1.5)
    for d in range(-rng, rng + 1):
        score = 0
        for b in bars[:-1]:
            x = round(b['xCss'] * dpr) + d
            if x <= 0 or x >= W: continue
            col = GREEN if b['c'] > b['o'] else RED
            if any(near(px[x, yy], col) for yy in range(y0, y1, 2)): score += 1
        if score > best[1] or (score == best[1] and abs(d) < abs(best[0])): best = (d, score)
    d = best[0]
    for b in bars: b['xCss'] = b['xCss'] + d / dpr
    return d, best[1]
