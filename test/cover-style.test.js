import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardSlides, coverStyle } from '../pipeline/src/carousel/board.js';
import { coverHookRule, buildUserPrompt } from '../pipeline/src/carousel/prompt.js';

const spec = {
  category: 'mutual-funds',
  slides: [
    { band: 'center', headline: 'Regular plan आपसे हर साल क्या ले रहा है?', subline: 'पूरा हिसाब अंदर →', cta: false, calc: null },
    { band: 'bottom', headline: 'x', subline: 'y', cta: false, calc: { type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1, 0.2] } },
    { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true, calc: null },
  ],
};

test('default cover is unchanged: the computed figure strip stays on the cover', () => {
  assert.equal(coverStyle({}), 'answer');
  const [cover, inner] = boardSlides(spec, { env: {} });
  assert.ok(cover.figures.length > 0);
  assert.deepEqual(cover.figures, inner.figures);
  assert.equal(coverHookRule({}), '');
});

test('CAROUSEL_COVER_STYLE=curiosity hides the answer on the cover only', () => {
  const env = { CAROUSEL_COVER_STYLE: 'curiosity' };
  const [cover, inner] = boardSlides(spec, { env });
  assert.deepEqual(cover.figures, []);
  assert.ok(inner.figures.length > 0, 'inner slides keep their figures');
  assert.match(coverHookRule(env), /जवाब cover पर नहीं/);
  assert.match(coverHookRule(env), /"का असर"/);
});

test('the prompt only carries the cover rule when the variable is set', () => {
  const before = process.env.CAROUSEL_COVER_STYLE;
  delete process.env.CAROUSEL_COVER_STYLE;
  assert.doesNotMatch(buildUserPrompt({ category: 'mutual-funds', date: '2026-10-08' }), /<cover_hook>/);
  process.env.CAROUSEL_COVER_STYLE = 'curiosity';
  assert.match(buildUserPrompt({ category: 'mutual-funds', date: '2026-10-08' }), /<cover_hook>/);
  if (before === undefined) delete process.env.CAROUSEL_COVER_STYLE; else process.env.CAROUSEL_COVER_STYLE = before;
});
