import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSpec, slideTextProblems } from '../pipeline/src/carousel/generate.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/carousel/prompt.js';

const slide = (over = {}) => ({
  band: 'bottom',
  headline: 'एक लाइन',
  subline: 'एक बात',
  source: 'NSE, 2024',
  cta: false,
  query: 'stock chart',
  person: null,
  ...over,
});

test('the last slide asks the viewer to save and follow', () => {
  const spec = normalizeSpec({
    topic: 'ROCE',
    category: 'fundamentals',
    caption: 'ROCE गिर रहा है',
    hashtags: ['#roce'],
    slides: [
      slide({ band: 'center', headline: 'ROCE गिर रहा है', subline: null, source: null }),
      ...Array.from({ length: 8 }, () => slide()),
      slide({ headline: 'Follow me', subline: null, source: null, cta: true }),
    ],
  });
  const last = spec.slides.at(-1);
  const blob = `${last.headline} ${last.subline}`;
  assert.equal(last.cta, true);
  assert.match(blob, /सेव/);
  assert.match(blob, /फ़ॉलो|फॉलो|follow/i);
  assert.equal(spec.slides[0].band, 'center');
});

test('a crowded slide is sent back to be shortened', () => {
  const problems = slideTextProblems({
    slides: [
      slide({ band: 'center', headline: 'एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह', subline: 'एक दो तीन चार पाँच छह सात आठ नौ' }),
      slide({ headline: 'एक दो तीन चार पाँच छह सात आठ नौ', subline: 'एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह' }),
    ],
  });
  assert.ok(problems.some((p) => /cover headline/.test(p)));
  assert.ok(problems.some((p) => /slide 2 headline/.test(p)));
  assert.ok(problems.some((p) => /slide 2 subline/.test(p)));
});

test('the prompt asks for a hook cover, less text, and a save follow close', () => {
  assert.match(SYSTEM, /Cover: एक bold line/);
  const text = buildUserPrompt({ category: 'fundamentals', date: '2026-10-01' });
  assert.match(text, /सेव करो और फ़ॉलो करो/);
  assert.match(text, /ज़्यादा से ज़्यादा 5/);
  assert.match(text, /कोई URL नहीं/);
});
