// How many slides a post carries lives in one place, and the prompt and the
// validator must not drift apart from it. They did not used to: "6" was written
// into the validator and four separate lines of two prompts, so raising it
// meant finding all five.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SLIDES } from '../pipeline/src/carousel/categories.js';
import { validateShape } from '../pipeline/src/carousel/generate.js';
import { SYSTEM as FACT_SYSTEM, buildUserPrompt } from '../pipeline/src/carousel/prompt.js';
import { SYSTEM as NEWS_SYSTEM } from '../pipeline/src/carousel/news-prompt.js';
import { MAX_ITEMS } from '../pipeline/src/publish/carousel.js';

const slide = (i, n) => ({
  band: i === 0 ? 'center' : 'bottom',
  headline: `slide ${i + 1}`,
  subline: i === 0 || i === n - 1 ? null : 'आँकड़ा\nदूसरी पंक्ति',
  source: i === 0 || i === n - 1 ? null : 'NASA',
  cta: i === n - 1,
  query: 'venus planet',
});

const spec = (n) => ({ topic: 'शुक्र ग्रह का दिन', slides: Array.from({ length: n }, (_, i) => slide(i, n)) });

test('Instagram would take this many', () => {
  assert.ok(SLIDES > 1 && SLIDES <= MAX_ITEMS, `${SLIDES} slides is outside 2..${MAX_ITEMS}`);
});

test('a spec of exactly SLIDES slides passes on count', () => {
  const problems = validateShape(spec(SLIDES), []);
  assert.deepEqual(problems.filter((p) => p.includes('slides —')), []);
});

test('one slide too few or too many is rejected', () => {
  for (const n of [SLIDES - 1, SLIDES + 1]) {
    const problems = validateShape(spec(n), []);
    assert.ok(problems.some((p) => p.includes(`${n} slides`)), `${n} slides was accepted`);
  }
});

// The real drift: the validator is raised and a prompt still asks for six.
test('both prompts ask for the same number the validator enforces', () => {
  const user = buildUserPrompt({ category: 'space', date: '2026-08-31', recentTopics: [] });
  for (const [name, text] of [['fact system', FACT_SYSTEM], ['fact user', user], ['news system', NEWS_SYSTEM]]) {
    assert.ok(text.includes(`${SLIDES} slides`), `${name} prompt does not ask for ${SLIDES} slides`);
    assert.ok(!/\b6 slides\b/.test(text), `${name} prompt still asks for 6 slides`);
  }
});
