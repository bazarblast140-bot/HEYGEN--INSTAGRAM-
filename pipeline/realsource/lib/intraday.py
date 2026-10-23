#!/usr/bin/env python3
"""Today's 5-minute session: TradingView 5m bars (legend hover) matched bar by
bar to Yahoo ^NSEI 5m data, day high/low/open/close with times, the day's range,
and the price->pixel fit for the 5m screenshot. Usage: intraday.py <run dir> <YYYY-MM-DD>"""
import json, sys, urllib.request, datetime as dt
from PIL import Image
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xalign import align as xalign
from match5m import align, slot, positions, yahoo_window, complete, fields

run, today = sys.argv[1], sys.argv[2]
bars = json.load(open(f'{run}/tv5-bars.json'))
meta = json.load(open(f'{run}/tv5-meta.json'))
daily = json.load(open(f'{run}/data.json'))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
problems = []

req = urllib.request.Request('https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?range=5d&interval=5m',
                             headers={'User-Agent': 'Mozilla/5.0'})
y = json.load(urllib.request.urlopen(req, timeout=30))['chart']['result'][0]
q = y['indicators']['quote'][0]
yrows = []
for t, o, h, l, c in zip(y['timestamp'], q['open'], q['high'], q['low'], q['close']):
    if None in (o, h, l, c): continue
    w = dt.datetime.fromtimestamp(t, IST)
    yrows.append({'date': w.date().isoformat(), 'time': w.strftime('%H:%M'), 'o': round(o, 2), 'h': round(h, 2), 'l': round(l, 2), 'c': round(c, 2)})
ytoday = [r for r in yrows if r['date'] == today]
def eq(a, b, tol=0.06): return abs(a - b) <= tol

_im = Image.open(f'{run}/tv5.png').convert('RGB')
xoff = xalign(_im, bars, meta)
if xoff[0]: print(f'x offset corrected by {xoff[0]} px ({xoff[1]} bars on candle)', file=sys.stderr)
# Yahoo's in-progress row has an odd minute; keep whole 5-minute bars only.
ytoday = [r for r in ytoday if int(r['time'][-2:]) % 5 == 0]
TOL = round(0.0002 * (bars[-1]['c'] if bars else 22000), 2)  # 0.02% (~4.5 pts): TradingView and Yahoo use different tick feeds; observed diffs up to ~3 pts
from match5m import dev
from wicks import classify, extremes, yahoo_extremes
# A bar matches when its close is within TOL and open/high/low within 3*TOL
# (single wick ticks differ between the two feeds). Printed numbers (day high,
# low, the price shown) are checked strictly against TOL below.
def bar_ok(b, r): return abs(b['c'] - r['c']) <= TOL and all(abs(b[k] - r[k]) <= 3 * TOL for k in fields(r) if k != 'c')
# Align by TIME SLOT (match5m.py): Yahoo drops null rows, so index alignment shifts every later bar.
best = align(bars, ytoday, meta.get('spacingCss'))
pos = positions(bars, meta.get('spacingCss'))
ymap = {r['time']: r for r in ytoday}
for b in bars: b['date'] = b['time'] = None; b['match'] = 'none'
if best is None:
    problems.append('could not align TradingView 5m bars with Yahoo 5m bars')
    tb = []; spikes = []
else:
    k = best[0]
    for j, b in enumerate(bars[k:], start=k):
        t = slot(pos[j] - pos[k]); r = ymap.get(t)
        if r: b.update(date=today, time=t, yahoo=r, dev=round(dev(b, r), 2), match='ok' if bar_ok(b, r) else 'MISMATCH')
        elif ytoday and t > ytoday[-1]['time']: b.update(date=today, time=t, match='live (newer than Yahoo)')
        else: b.update(date=today, time=t, match='no Yahoo row (null in feed)')
    tb = [b for b in bars if b['date'] == today]
    cmp = [b for b in tb[:-1] if b.get('yahoo')] if not daily.get('afterClose') else [b for b in tb if b.get('yahoo')]
    worst = max((b['dev'] for b in cmp), default=0)
    bad = [b for b in cmp if b['match'] == 'MISMATCH']
    # Isolated wick spikes (close and open still within TOL) on any number of bars are
    # tolerated, including the day high/low bar; the printed extremes then use the
    # value both feeds agree on (wicks.py). Any close/open mismatch fails.
    spikes, bad = classify(bad, TOL, {id(tb[i]): tb[i - 1]['c'] for i in range(1, len(tb))})
    for b in spikes: b['match'] = 'wick-spike (open/close ok)'
    if bad: problems.append(f'{len(bad)} 5m bars differ from Yahoo (close > {TOL} or o/h/l > {round(3 * TOL, 2)} points; worst {worst})')
    if tb and tb[0]['time'] != '09:15': problems.append(f'first aligned 5m bar is {tb[0]["time"]}, not 09:15')
    if daily.get('afterClose'):
        if len(tb) != 75 or tb[-1]['time'] != '15:25' or not ytoday or ytoday[-1]['time'] != '15:25':
            problems.append(f'session incomplete: {len(tb)} TradingView 5m bars (need 75, last {tb[-1]["time"] if tb else "-"}) vs {len(ytoday)} Yahoo rows, Yahoo last {ytoday[-1]["time"] if ytoday else "-"}')
    out_dev = {'tolerancePts': TOL, 'worstDevPts': worst, 'compared': len(cmp), 'wickSpikes': [{'time': b['time'], 'dev': b['dev']} for b in spikes]}
out = {'today': today, 'problems': problems, 'meta': meta, 'xOffsetPx': xoff[0], 'yahooCheck': out_dev if best else None}
if tb:
    (hi, hiP), (lo, loP) = extremes(tb, TOL)   # agreed values, never a one-feed spike
    rawHi = max(b['h'] for b in tb); rawLo = min(b['l'] for b in tb)   # TradingView's own extremes
    op = tb[0]
    # The price we print: the newest COMPLETE bar whose close Yahoo confirms
    # within TOL (TradingView's public feed is ~15 min delayed; a live bar is never printed).
    done = [b for b in tb if b.get('yahoo') and abs(b['c'] - b['yahoo']['c']) <= TOL and (b is not tb[-1] or daily.get('afterClose'))]
    cl = done[-1] if done else tb[-1]
    if not done: problems.append('no Yahoo-verified complete 5m bar to print')
    # Same cutoff on both sides: TradingView's last COMPLETE bar (the live one is still forming).
    fin = complete(tb, daily.get('afterClose')) or tb
    yw = yahoo_window(ytoday, fin[-1]['time']) or ytoday
    for e, nm in ((hi, 'high'), (lo, 'low')):
        if e not in fin: problems.append(f'day {nm} {hiP if nm == "high" else loP} is in the live {e["time"]} bar (still forming, cannot be verified)')
        elif not e.get('yahoo'): problems.append(f'day {nm} bar {e["time"]} has no Yahoo row to verify it')
    (yhi, yhiP), (ylo, yloP) = yahoo_extremes(yw, {b['time']: b for b in tb}, TOL)
    if abs(hiP - yhiP) > TOL or hi['time'] != yhi['time']: problems.append(f'day high {hiP} @{hi["time"]} vs Yahoo {yhiP} @{yhi["time"]}')
    if abs(loP - yloP) > TOL or lo['time'] != ylo['time']: problems.append(f'day low {loP} @{lo["time"]} vs Yahoo {yloP} @{ylo["time"]}')
    T = daily['T']
    # same TradingView feed: TradingView's RAW 5m extremes (spike included) must equal its daily
    # bar's high/low exactly; the printed (agreed) values differ from them only by a tolerated spike.
    if not eq(rawHi, T['h']): problems.append(f'5m day high {rawHi} != TradingView daily high {T["h"]}')
    if not eq(rawLo, T['l']): problems.append(f'5m day low {rawLo} != TradingView daily low {T["l"]}')
    rng = round(hiP - loP, 2)
    out.update({
        'high': {'price': hiP, 'time': hi['time'], 'x': hi['xCss'] * meta['dpr'], 'tvRaw': rawHi, 'spikeCorrected': not eq(hiP, rawHi)},
        'low': {'price': loP, 'time': lo['time'], 'x': lo['xCss'] * meta['dpr'], 'tvRaw': rawLo, 'spikeCorrected': not eq(loP, rawLo)},
        # official open (auction price) = TradingView daily open, checked == Yahoo open in build.mjs
        'open': {'price': daily['T']['o'] if op['time'] == '09:15' else op['o'], 'time': op['time'], 'x': op['xCss'] * meta['dpr']},
        'close': {'price': cl['c'], 'time': cl['time'], 'asOf': (dt.datetime.strptime(cl['time'], '%H:%M') + dt.timedelta(minutes=5)).strftime('%H:%M') if cl.get('time') and cl['time'] != 'live' else None,
                  'x': cl['xCss'] * meta['dpr'], 'verified': bool(done), 'isClose': bool(daily.get('afterClose') and cl.get('time') == '15:25'),
                  'live': not (daily.get('afterClose') and cl.get('time') == '15:25')},
        'range': rng, 'rangePct': round(rng / loP * 100, 2), 'bars': len(tb),
        'firstX': tb[0]['xCss'] * meta['dpr'], 'lastX': tb[-1]['xCss'] * meta['dpr'],
        'yahoo': {'bars': len(ytoday), 'high': dict(yhi, agreed=yhiP), 'low': dict(ylo, agreed=yloP), 'first': ytoday[0] if ytoday else None, 'last': ytoday[-1] if ytoday else None},
    })

# price -> pixel from the 5m candles
im = Image.open(f'{run}/tv5.png').convert('RGB'); W, H = im.size
# (x already aligned above)
dpr = meta['dpr']; pane = meta['pane']
RED, GREEN = (242, 54, 69), (8, 153, 129)
def is_candle(px): return any(all(abs(px[k] - col[k]) <= 14 for k in range(3)) for col in (RED, GREEN))
y0, y1 = int(pane['y'] * dpr) + 2, int((pane['y'] + pane['h']) * dpr) - 2
pairs = []
for b in bars[:-1]:
    xc = round(b['xCss'] * dpr); half = max(2, int(meta.get('spacingCss', 6) * dpr * 0.3)); best = None
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
    pairs += [(b['h'], best[0]), (b['l'], best[1] + 1)]
from pxfit import robust_fit
if len(pairs) >= 20:
    n0 = len(pairs); a, s, pairs, res = robust_fit(pairs)
    out['mapping'] = {'a': a, 'b': s, 'pairs': len(pairs), 'maxResidualPx': round(max(res), 2), 'meanResidualPx': round(sum(res) / len(res), 2)}
    if max(res) > 4 or len(pairs) < 0.7 * n0: problems.append(f'5m price->pixel fit is poor (max residual {max(res):.1f}px, kept {len(pairs)}/{n0})')
else:
    problems.append('too few 5m candles found in the screenshot for the price->pixel fit')
out['barsToday'] = [{k: b.get(k) for k in ('time', 'xCss', 'o', 'h', 'l', 'c', 'dev', 'match')} for b in tb]
json.dump(out, open(f'{run}/intraday.json', 'w'), indent=1)
print(json.dumps({k: out.get(k) for k in ('high', 'low', 'open', 'close', 'range', 'rangePct', 'bars', 'mapping', 'problems')}, indent=1))
