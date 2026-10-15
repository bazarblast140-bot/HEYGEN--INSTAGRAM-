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
