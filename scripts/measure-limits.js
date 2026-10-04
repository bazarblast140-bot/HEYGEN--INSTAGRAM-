// Render one slide of each type with every field exactly at its limit and
// check the text stays inside the 6% safe area at the normal (not tight) sizes.
//   node scripts/measure-limits.js
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { renderSlides, WIDTH, HEIGHT } from '../pipeline/render-slides.js';
import { boardSlides } from '../pipeline/src/carousel/board.js';
import { layoutProblems } from '../pipeline/src/carousel/quality.js';
import { LIMITS } from '../pipeline/src/carousel/limits.js';

const fill = (seed, n) => { let s = ''; while ([...s].length < n) s += (s ? ' ' : '') + seed; return [...s].slice(0, n).join(''); };
const DEV = 'बाज़ार में म्यूचुअल फंड निवेश';
const ROM = 'Mutual fund SIP returns';
for (const [name, seed] of [['devanagari', DEV], ['roman', ROM], ['mixed', `${DEV} ${ROM}`]]) {
  const label = fill(seed, LIMITS.chartLabel);
  const spec = {
    topic: 'limits', category: 'mutual-funds', brand: 'Rajesh Technical Traders',
    slides: [
      { band: 'center', headline: fill(seed, LIMITS.coverHeadline), subline: fill(seed, LIMITS.subline), cta: false, calc: null },
      { band: 'bottom', headline: fill(seed, LIMITS.chartHeadline), subline: fill(seed, LIMITS.subline), source: fill(seed, LIMITS.source), cta: false,
        calc: { type: 'compare', unit: 'INR', items: [{ label, value: 1000 }, { label, value: 1500 }, { label, value: 1800 }, { label, value: 2400 }] } },
      { band: 'bottom', headline: fill(seed, LIMITS.textHeadline), subline: fill(seed, LIMITS.subline), source: fill(seed, LIMITS.source), cta: false, calc: null },
      { band: 'bottom', headline: fill(seed, LIMITS.coverHeadline), subline: fill(seed, LIMITS.subline), cta: true, calc: null },
    ],
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'limits-'));
  const { measures } = await renderSlides({ spec: { ...spec, slides: boardSlides(spec) }, outDir, tight: false, format: 'png' });
  const problems = layoutProblems(measures, { width: WIDTH, height: HEIGHT });
  console.log(`${name.padEnd(10)} ${problems.length ? `FAIL\n  ${problems.join('\n  ')}` : 'ok — every field at its limit is inside the safe area'}  (${outDir})`);
}
