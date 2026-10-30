#!/usr/bin/env python3
"""Verify the TradingView bars against Yahoo Finance (^NSEI), map price -> pixel
from the screenshot's own candles, and compute the levels used on the slides.
Every number written to data.json is either read from TradingView's legend or
computed here from those numbers. Usage: data.py <run dir> [YYYY-MM-DD]"""
import json, sys, math, urllib.request, datetime as dt
from PIL import Image
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xalign import align

run = sys.argv[1]
bars = json.load(open(f'{run}/tv-bars.json'))
meta = json.load(open(f'{run}/tv-meta.json'))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
cap = dt.datetime.fromisoformat(meta['capturedAt'].replace('Z', '+00:00')).astimezone(IST)
today = sys.argv[2] if len(sys.argv) > 2 else cap.date().isoformat()
problems = []

# ---- Yahoo daily OHLC (dates) -------------------------------------------
req = urllib.request.Request('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=1y&interval=1d',
                             headers={'User-Agent': 'Mozilla/5.0'})
y = json.load(urllib.request.urlopen(req, timeout=30))['chart']['result'][0]
q = y['indicators']['quote'][0]
yrows = []
for t, o, h, l, c in zip(y['timestamp'], q['open'], q['high'], q['low'], q['close']):
    if None in (o, h, l, c): continue
    d = dt.datetime.fromtimestamp(t, IST).date().isoformat()
    yrows.append({'date': d, 'o': round(o, 2), 'h': round(h, 2), 'l': round(l, 2), 'c': round(c, 2)})
# de-dup by date (keep last)
yd = {}
for r in yrows: yd[r['date']] = r
yrows = sorted(yd.values(), key=lambda r: r['date'])

def close(a, b, tol=0.06): return abs(a - b) <= tol
for i, b in enumerate(bars):
    live = i == len(bars) - 1
    hit = [r for r in yrows if close(b['o'], r['o']) and close(b['h'], r['h']) and close(b['l'], r['l']) and close(b['c'], r['c'])]
    if not hit and live:
        hit = [r for r in yrows if r['date'] == today and close(b['o'], r['o'])]
    b['date'] = hit[-1]['date'] if hit else None
    b['yahooMatch'] = 'ohlc' if hit and close(b['c'], hit[-1]['c']) else ('open-only (live bar)' if hit else 'none')
recent = bars[-15:]
unmatched = [i for i, b in enumerate(bars) if not b['date']]
if any(not b['date'] for b in recent):
    problems.append(f'last 15 TradingView bars not all matched to Yahoo dates: {[b["xCss"] for b in recent if not b["date"]]}')
if bars[-1]['date'] != today:
    problems.append(f'last TradingView bar is {bars[-1]["date"]}, expected {today}')
dates = [b['date'] for b in bars if b['date']]
if dates != sorted(dates) or len(set(dates)) != len(dates):
    problems.append('matched dates are not strictly increasing')

# ---- price -> pixel from the candles in the unaltered screenshot -----------
im = Image.open(f'{run}/tv.png').convert('RGB')
W, H = im.size
xoff = align(im, bars, meta)
dpr = meta['dpr']; pane = meta['pane']
RED, GREEN = (242, 54, 69), (8, 153, 129)
def is_candle(px): return any(all(abs(px[k] - col[k]) <= 14 for k in range(3)) for col in (RED, GREEN))
y0, y1 = int(pane['y'] * dpr) + 2, int((pane['y'] + pane['h']) * dpr) - 2
pairs = []
for b in bars[:-1]:  # not the live bar
    xc = round(b['xCss'] * dpr)
    half = max(2, int(meta.get('spacingCss', 6) * dpr * 0.3))
    best = None
    for x in range(xc - half, xc + half + 1):
        if x <= 0 or x >= W: continue
        rows = [yy for yy in range(y0, y1) if is_candle(im.getpixel((x, yy)))]
        if not rows: continue
        segs, s_ = [], [rows[0], rows[0]]
        for yy in rows[1:]:
            if yy - s_[1] <= 3: s_[1] = yy
            else: segs.append(s_); s_ = [yy, yy]
        segs.append(s_)
        seg = max(segs, key=lambda q: q[1] - q[0])
        if best is None: best = list(seg)
        elif seg[0] <= best[1] + 3 and seg[1] >= best[0] - 3: best = [min(best[0], seg[0]), max(best[1], seg[1])]
        elif seg[1] - seg[0] > best[1] - best[0]: best = list(seg)
    if not best or best[1] - best[0] < 4: continue
    top, bot = best
    pairs += [(b['h'], top), (b['l'], bot + 1)]
# Robust Theil-Sen start (pxfit.py), same as the 5m fit: on 30 Oct 2026 two gross
# outlier pairs dragged the old OLS start so far that 109/148 good pairs were dropped
# and every midday run held, although the axis was fine (robust fit keeps 146/148).
from pxfit import robust_fit
n0 = len(pairs)
a, slope, pairs2, res2 = robust_fit(pairs)
mapping = {'a': a, 'b': slope, 'pairs': len(pairs2), 'dropped': n0 - len(pairs2), 'maxResidualPx': round(max(res2), 2),
           'meanResidualPx': round(sum(res2) / len(res2), 2)}
if mapping['maxResidualPx'] > 4 or len(pairs2) < 40 or len(pairs2) < 0.7 * n0: problems.append(f'price->pixel fit is poor: {mapping}')

# ---- levels ---------------------------------------------------------------
dated = [b for b in bars if b['date']]
T = dated[-1]; P = dated[-2]
win = dated[-10:]
S_bar = min(win, key=lambda b: b['l'])
pivots = []
look = dated[-30:]
for i in range(2, len(look) - 2):
    if look[i] is T: continue
    if all(look[i]['h'] > look[j]['h'] for j in (i - 2, i - 1, i + 1, i + 2)): pivots.append(look[i])
above = sorted([b for b in pivots if b['h'] > T['c']], key=lambda b: b['h'])
R1 = above[0] if above else max(win, key=lambda b: b['h'])
R2 = above[1] if len(above) > 1 and (above[1]['h'] - R1['h']) / R1['h'] < 0.02 else None
year = [r for r in yrows if r['date'] < today][-247:]
low52 = min(year, key=lambda r: r['l']) if year else None
high52 = max(year, key=lambda r: r['h']) if year else None
S_is_52w = bool(low52 and S_bar['l'] <= low52['l'] + 0.06)
prevClose = P['c']
chg = round(T['c'] - prevClose, 2); pct = round(chg / prevClose * 100, 2)
if not close(chg, T['chg'], 0.06): problems.append(f'change {chg} != TradingView legend {T["chg"]}')
if not close(pct, T['pct'], 0.011): problems.append(f'change % {pct} != TradingView legend {T["pct"]}')

def Y(p): return a + slope * p
out = {
    'today': today, 'capturedAtIst': cap.strftime('%Y-%m-%d %H:%M:%S IST'), 'capturedAt': meta['capturedAt'],
    'afterClose': cap.hour * 60 + cap.minute >= 15 * 60 + 30,
    'meta': meta, 'mapping': mapping, 'xOffsetPx': xoff[0],
    'T': T, 'P': P, 'chg': chg, 'pct': pct,
    'S': {'price': S_bar['l'], 'date': S_bar['date'], 'x': S_bar['xCss'] * dpr, 'is52wLow': S_is_52w},
    'R1': {'price': R1['h'], 'date': R1['date'], 'x': R1['xCss'] * dpr},
    'R2': ({'price': R2['h'], 'date': R2['date'], 'x': R2['xCss'] * dpr} if R2 else None),
    'low52': low52, 'high52': high52,
    'bars': [{k: b[k] for k in ('date', 'xCss', 'o', 'h', 'l', 'c', 'chg', 'pct', 'yahooMatch')} for b in dated[-45:]],
    'unmatchedBars': len(unmatched), 'yahooLast': yrows[-1],
    'problems': problems,
    'Ypx': {k: Y(v) for k, v in [('S', S_bar['l']), ('R1', R1['h']), ('R2', R2['h'] if R2 else R1['h']), ('Tc', T['c']), ('Th', T['h']), ('Tl', T['l'])]},
    'xPx': {'T': T['xCss'] * dpr, 'first': dated[0]['xCss'] * dpr, 'axis': (pane['x'] + pane['w']) * dpr},
}
json.dump(out, open(f'{run}/data.json', 'w'), indent=1)
print(json.dumps({k: out[k] for k in ('today', 'capturedAtIst', 'chg', 'pct', 'S', 'R1', 'R2', 'mapping', 'problems')}, indent=1))
print('T', T)
