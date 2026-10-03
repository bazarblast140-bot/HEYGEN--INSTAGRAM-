// Re-render of a reviewed preview with reviewer edits (no model call), the
// contribution_split chart, and chart axis labels that are never clipped.
// From the 3 Oct evening preview run 37119847614: slide 8 repeated slide 3's
// 40 vs 10 compare, and "Operating profit" was drawn as "Operating prof".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { computeCalc } from '../pipeline/src/carousel/calc.js';
import { exampleProblems } from '../pipeline/src/carousel/example.js';
import { financeNumberProblems } from '../pipeline/src/carousel/quality.js';
import { applyEdits } from '../pipeline/src/carousel/edits.js';

await import('../pipeline/src/render/scenes/chart-labels.js');
const { fitLabel } = globalThis.ChartLabels;

const EX = { type: 'operating_leverage', sales: 100, variableCost: 60, fixedCost: 30, salesChangePct: 10, unit: 'num' };
const SPLIT = { type: 'contribution_split', sales: 100, variableCost: 60, fixedCost: 30, unit: 'num' };

test('contribution_split: contribution 40 = fixed cost 30 + operating profit 10, computed from the example', () => {
  const r = computeCalc(SPLIT);
  assert.equal(r.ok, true, r.error);
  const get = (k) => r.all.find((f) => f.key === k).value;
  assert.equal(get('contribution'), 40);
  assert.equal(get('fixedCost'), 30);
  assert.equal(get('ebit'), 10);
  assert.equal(get('fixedSharePct'), 75);
  assert.equal(r.chart.kind, 'stackbars');
  assert.deepEqual(r.chart.stacks.map((s) => [s.name, s.color, s.values[0]]), [['Fixed cost', 'red', 30], ['Operating profit', 'green', 10]]);
  assert.match(r.note, /contribution = sales − variable cost; operating profit = contribution − fixed cost/);
  assert.equal(computeCalc({ ...SPLIT, fixedCost: 50 }).ok, false, 'fixed cost above contribution is refused');

  const spec = {
    category: 'fundamentals',
    example: EX,
    slides: [
      { band: 'center', headline: 'Sales 10% बढ़े तो Profit कितना बढ़ेगा?', cta: false },
      { band: 'bottom', headline: 'Operating leverage का पूरा गणित', subline: 'Sales 100, variable cost 60, fixed cost 30, sales +10%', calc: EX, cta: false },
      { band: 'bottom', headline: 'Contribution बनाम Profit', subline: 'Fixed cost contribution का बड़ा हिस्सा खा जाता है', calc: SPLIT, cta: false },
      { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
    ],
  };
  assert.deepEqual(exampleProblems(spec), []);
  assert.deepEqual(financeNumberProblems(spec), []);
  const off = { ...spec, slides: spec.slides.map((s, i) => (i === 2 ? { ...s, calc: { ...SPLIT, fixedCost: 25 } } : s)) };
  assert.match(exampleProblems(off).join('\n'), /slide 3: Fixed cost 25 is not in the worked example/);
});

test('axis labels keep every character: wrap to two lines, then shrink', () => {
  const measure = (s, size) => s.length * size * 0.55;   // ~Inter 600 advance
  const wide = fitLabel('Operating profit', 400, measure);
  assert.deepEqual(wide, { lines: ['Operating profit'], size: 26 });
  const narrow = fitLabel('Operating profit', 160, measure);
  assert.deepEqual(narrow.lines, ['Operating', 'profit'], 'wraps at the space');
  assert.equal(narrow.size, 26, 'wrapping comes before shrinking');
  const tiny = fitLabel('Operating profit', 110, measure);
  assert.deepEqual(tiny.lines, ['Operating', 'profit']);
  assert.ok(tiny.size < 26 && tiny.size >= 16, `shrunk to ${tiny.size}`);
  assert.ok(Math.max(...tiny.lines.map((l) => measure(l, tiny.size))) <= 110);
  const word = fitLabel('Contribution', 150, measure);
  assert.deepEqual(word.lines, ['Contribution'], 'one long word shrinks instead of breaking');
  assert.ok(measure('Contribution', word.size) <= 150);
  for (const f of [wide, narrow, tiny, word]) assert.ok(!f.lines.join(' ').includes('…'));

  // The chart data is no longer cut to 14 characters either.
  const cmp = computeCalc({ type: 'compare', unit: 'num', items: [{ label: 'Contribution', value: 40 }, { label: 'Operating profit', value: 10 }] });
  assert.deepEqual(cmp.chart.labels, ['Contribution', 'Operating profit']);
});

test('the board draws axis labels through the fitter, never the raw string', async () => {
  const html = await fs.readFile(new URL('../pipeline/src/render/scenes/board.html', import.meta.url), 'utf8');
  assert.match(html, /<script src="chart-labels.js"><\/script>/);
  assert.doesNotMatch(html, /text\(svg, cx, box\.y1 \+ \d+, (c\.labels\[i\]|label)/, 'no unfitted axis label');
  assert.match(html, /probe\.remove\(\)/, 'the measuring probe is not left in the chart');
});

test('reviewer edits apply exactly, or the re-render stops', async () => {
  const spec = {
    category: 'fundamentals',
    caption: 'Sales सिर्फ़ 10% बढ़े, पर profit 40% उछला — यही operating leverage है।',
    slides: [
      { band: 'center', headline: 'कवर', cta: false },
      { band: 'bottom', headline: 'A', subline: 'B', calc: { type: 'compare', unit: 'num', items: [{ label: 'x', value: 1 }, { label: 'y', value: 2 }] }, cta: false },
      { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
    ],
  };
  const file = JSON.parse(await fs.readFile(new URL('../pipeline/specs/edits/2026-10-03-evening-run37119847614.json', import.meta.url), 'utf8'));
  assert.deepEqual(file.edits.map((e) => e.op), ['calc', 'caption_replace']);
  const edits = [{ ...file.edits[0], slide: 2 }, file.edits[1]];
  const { spec: out, applied } = applyEdits(spec, edits);
  assert.equal(out.slides[1].calc.type, 'contribution_split');
  assert.equal(out.slides[1].headline, 'A', 'headline untouched');
  assert.equal(out.slides[1].subline, 'B', 'subline untouched');
  assert.match(out.caption, /profit 40% बढ़ गया —/);
  assert.doesNotMatch(out.caption, /उछला/);
  assert.equal(applied.length, 2);
  assert.equal(spec.slides[1].calc.type, 'compare', 'the source spec is not mutated');
  assert.throws(() => applyEdits(spec, [{ op: 'caption_replace', from: 'नहीं है', to: 'x' }]), /caption does not contain/);
  assert.throws(() => applyEdits(spec, [{ op: 'calc', slide: 9, calc: SPLIT }]), /slide 9, which does not exist/);
  assert.throws(() => applyEdits(spec, [{ op: 'calc', slide: 1, calc: SPLIT }]), /cover or the follow card/);
  assert.throws(() => applyEdits(spec, [{ op: 'delete', slide: 2 }]), /unknown edit op/);
});
