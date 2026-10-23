// 23 Oct 2026 (held runs 39908584540, 39920316301): TradingView 10:35 5m bar spike low
// 22,407.05 vs Yahoo 22,454.60 (Yahoo 1m agrees with its 5m); that bar was TV's day low.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const py = (code) => JSON.parse(execFileSync('python3', ['-c', `import sys, json; sys.path.insert(0, 'pipeline/realsource/lib')\nfrom wicks import *\nfrom match5m import slot, dev\n${code}`]).toString());
const SETUP = `
TOL = 4.5
def mk(i): p = 22600 - abs(i - 16) * 8; return {'o': p, 'h': p + 6, 'l': p - 4, 'c': p + 3}
y = [dict(mk(i), time=slot(i)) for i in range(30)]
tv = [dict(mk(i)) for i in range(30)]
for b, r in zip(tv, y): b['yahoo'] = r; b['time'] = r['time']
def bar_ok(b, r): return abs(b['c'] - r['c']) <= TOL and all(abs(b[k] - r[k]) <= 3 * TOL for k in ('o','h','l','c'))
`;

test("today's case: spike low on the day-low bar is tolerated and never printed", () => {
  const r = py(`${SETUP}
i = 16   # 10:35
y[i].update(l=22454.60); tv[i].update(l=22407.05)          # TV spike low
tv[20]['h'] = y[20]['h'] + 20                               # a second isolated wick
bad = [b for b in tv if not bar_ok(b, b['yahoo'])]
spikes, real = classify(bad, TOL)
(hb, hp), (lb, lp) = extremes(tv, TOL)
(yh, yhp), (yl, ylp) = yahoo_extremes(y, {b['time']: b for b in tv}, TOL)
print(json.dumps([len(bad), len(spikes), len(real), lb['time'], lp, yl['time'], ylp, hp, yhp, round(hp - lp, 2), min(b['l'] for b in tv)]))`);
  assert.deepEqual(r, [2, 2, 0, '10:35', 22454.6, '10:35', 22454.6, 22606, 22606, 151.4, 22407.05]);
});

test('real feed mismatch still fails: close mismatch', () => {
  const r = py(`${SETUP}
tv[10]['c'] += 12
bad = [b for b in tv if not bar_ok(b, b['yahoo'])]
print(json.dumps([len(x) for x in classify(bad, TOL)]))`);
  assert.deepEqual(r, [0, 1]);
});

test('real feed mismatch still fails: more than 2 spike bars', () => {
  const r = py(`${SETUP}
for i in (5, 9, 13): tv[i]['l'] -= 30
bad = [b for b in tv if not bar_ok(b, b['yahoo'])]
print(json.dumps([len(x) for x in classify(bad, TOL)]))`);
  assert.deepEqual(r, [0, 3]);
});

test('open mismatch on a wick bar is not a tolerated spike (except 09:15 auction open)', () => {
  const r = py(`${SETUP}
tv[8].update(l=tv[8]['l'] - 30, o=tv[8]['o'] + 10)
tv[0].update(l=tv[0]['l'] - 30, o=tv[0]['o'] + 10)
print(json.dumps([spike_ok(tv[8], tv[8]['yahoo'], TOL), spike_ok(tv[0], tv[0]['yahoo'], TOL)]))`);
  assert.deepEqual(r, [false, true]);
});
