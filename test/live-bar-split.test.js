// 16 Oct 2026 check run 38876553343: today's daily bar ticked mid-sweep -> two runs -> 76 bars, one unmatched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeLiveRuns } from '../pipeline/realsource/lib/capture-chart.mjs';

const r = (x0, x1, o, c) => ({ key: `${o}|${c}`, x0, x1, o, h: c + 5, l: o - 5, c });
test('a live bar that ticks during the sweep stays one bar (newest values)', () => {
  const runs = mergeLiveRuns([r(700, 708, 22671.3, 22997.35), r(709, 713, 23065.1, 23106.6), r(714, 720, 23065.1, 23100.75)]);
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[1].x0, runs[1].x1, runs[1].c], [709, 720, 23100.75]);
});
test('different opens or a gap are separate bars', () => {
  assert.equal(mergeLiveRuns([r(700, 708, 1, 2), r(709, 713, 3, 4)]).length, 2);
  assert.equal(mergeLiveRuns([r(700, 708, 3, 2), r(712, 713, 3, 4)]).length, 2);
});
test('mergeLiveRuns is called after the crosshair sweep (runs exists there)', async () => {
  const src = await (await import('node:fs/promises')).readFile(new URL('../pipeline/realsource/lib/capture-chart.mjs', import.meta.url), 'utf8');
  const call = src.indexOf('mergeLiveRuns(runs);');
  assert.ok(call > src.indexOf('const runs = [];') && call < src.indexOf('const mids = runs.map'));
});
