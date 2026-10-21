// 15 Oct 2026 check run 38699319652: Yahoo returned null 5m rows (11:45, 11:50) and is
// ahead of TradingView's delayed feed; index alignment compared bars 10 min apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const py = (code) => JSON.parse(execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, 'pipeline/realsource/lib')\nfrom match5m import *\n${code}`]).toString());
const SETUP = `
import datetime as dt
def mk(i): p = 22600 + i * 10; return {'o': p, 'h': p + 6, 'l': p - 4, 'c': p + 3}   # rally: neighbours differ by 10 pts
prev = [{'o': 1, 'h': 2, 'l': 0, 'c': 1} for _ in range(5)]                         # yesterday's bars on the chart
tv = prev + [mk(i) for i in range(44)]                                                # 09:15..12:50 (TV ~15 min delayed)
y = [dict(mk(i), time=slot(i)) for i in range(48) if slot(i) not in ('11:45', '11:50')]  # Yahoo to 13:10, nulls dropped
`;

test('5m TV/Yahoo match is by time slot across Yahoo null rows', () => {
  const r = py(`${SETUP}
k, d = align(tv, y)
ymap = {r['time']: r for r in y}
worst = max(dev(tv[k + i], ymap[slot(i)]) for i in range(43) if slot(i) in ymap)
print(json.dumps([k, d, worst]))`);
  assert.deepEqual(r, [5, 0, 0]);
});

test('Yahoo high/low use the same cutoff as the TradingView chart', () => {
  const r = py(`${SETUP}
w = yahoo_window(y, slot(43))
print(json.dumps([w[-1]['time'], max(w, key=lambda r: r['h'])['time'], max(y, key=lambda r: r['h'])['time']]))`);
  assert.deepEqual(r, ['12:50', '12:50', '13:10']);
});

test('a genuinely different feed still fails (no tolerance loosening)', () => {
  const r = py(`${SETUP}
bad = prev + [dict(mk(i), c=mk(i)['c'] + 40) for i in range(44)]
print(json.dumps(align(bad, y)[1]))`);
  assert.ok(r >= 40);
});

test('09:15 open (pre-open auction vs first trade) is not compared; other fields stay strict', () => {
  const r = py(`
b = {'o': 22686.45, 'h': 22737.7, 'l': 22637.4, 'c': 22725.1}
y915 = {'time': '09:15', 'o': 22671.3, 'h': 22737.7, 'l': 22637.4, 'c': 22725.1}
y920 = dict(y915, time='09:20')
print(json.dumps([dev(b, y915), round(dev(b, y920), 2), round(dev(dict(b, h=22760), y915), 2)]))`);
  assert.deepEqual(r, [0, 15.15, 22.3]);
});

test('cutoff = last complete TradingView bar: the forming bar is excluded before the close', () => {
  const r = py(`
tb = [{'time': slot(i)} for i in range(47)]   # 09:15..13:05, 13:05 still forming
y = [{'time': slot(i), 'h': 1} for i in range(50)]
print(json.dumps([complete(tb, False)[-1]['time'], yahoo_window(y, complete(tb, False)[-1]['time'])[-1]['time'], len(complete(tb, True))]))`);
  assert.deepEqual(r, ['13:00', '13:00', 47]);
});

// 21 Oct 2026 check run 39552391975: Yahoo LAGGED TradingView (last Yahoo row 2 bars older).
// The old "at most one TradingView bar newer than Yahoo" filter rejected the true alignment
// and picked one slot later: every bar labelled 5 min early (high @09:35 vs 09:40, low
// 22807.45 @11:45 vs Yahoo 22814.05 @11:40, 31 bars "differ"). Real data from both feeds.
test('5m alignment holds when Yahoo lags TradingView (real 21 Oct data)', () => {
  const r = py(`
fx = json.load(open('test/fixtures/match5m-2026-10-21-yahoo-lag.json'))
tv, y = fx['tv'], fx['yahoo']
k, d = align(tv, y)
tb = [dict(b, time=slot(i)) for i, b in enumerate(tv[k:])]
fin = complete(tb, False); w = yahoo_window(y, fin[-1]['time'])
hi = max(tb, key=lambda b: b['h']); lo = min(fin, key=lambda b: b['l'])
yhi = max(w, key=lambda r: r['h']); ylo = min(w, key=lambda r: r['l'])
print(json.dumps([k, d <= 13.71, hi['time'], yhi['time'], lo['time'], lo['l'], ylo['time'], ylo['l'], tb[-1]['time']]))`);
  assert.deepEqual(r, [16, true, '09:40', '09:40', '11:50', 22807.45, '11:40', 22814.05, '11:55']);
});

test('synthetic: Yahoo two bars behind TradingView still aligns by slot', () => {
  const r = py(`${SETUP}
yl = [r for r in y if r['time'] <= slot(41)]   # Yahoo stops 2 bars before TradingView's last complete bar
print(json.dumps(align(tv, yl)))`);
  assert.deepEqual(r, [5, 0]);
});
