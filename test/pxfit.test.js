// 23 Oct 2026 run 39923059630: "5m price->pixel fit is poor (kept 36/178)". An OLS start
// line dragged by a few gross outliers rejected most good pairs; Theil-Sen start fixes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const py = (code) => JSON.parse(execFileSync('python3', ['-c', `import sys, json, random; sys.path.insert(0, 'pipeline/realsource/lib')\nfrom pxfit import *\n${code}`]).toString());
const SETUP = `
random.seed(7)
good = [(p, 120483.57 - 5.27 * p + random.uniform(-1.5, 1.5)) for p in [22370 + i * 2.3 for i in range(160)]]
bad = [(22400 + i * 20, 120483.57 - 5.27 * (22400 + i * 20) + 400) for i in range(18)]   # 10% gross outliers
`;
test('robust fit keeps the good pairs despite gross outliers', () => {
  const r = py(`${SETUP}
a, b, kept, res = robust_fit(good + bad)
a0, b0 = ols(good + bad); k0 = [pp for pp in good + bad if abs(pp[1] - (a0 + b0 * pp[0])) <= 4]
print(json.dumps([len(kept), round(b, 2), max(res) <= 4, len(k0)]))`);
  assert.equal(r[0], 160); assert.equal(r[1], -5.27); assert.equal(r[2], true); assert.ok(r[3] < 0.7 * 178);
});
test('a genuinely wrong axis still fails the unchanged 70% / 4 px gate', () => {
  const r = py(`
random.seed(3)
ps = [(22370 + i * 2.3, random.uniform(0, 2000)) for i in range(178)]
a, b, kept, res = robust_fit(ps)
print(json.dumps(len(kept) >= 0.7 * 178 and max(res) <= 4))`);
  assert.equal(r, false);
});
