// Fixed per-field character limits (limits.js), checked against the v3
// renderer by scripts/measure-limits.js. Over the limit: one shorten request,
// then a safe word-boundary trim, else a hard gate problem (slot skipped).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS, headlineLimit, overLimits, trimAtWord, enforceLimits, shortenPrompt } from '../pipeline/src/carousel/limits.js';
import { buildUserPrompt } from '../pipeline/src/carousel/prompt.js';
import { buildSourcedPrompt } from '../pipeline/src/carousel/sourced-prompt.js';

const len = (s) => [...s].length;
const words = (seed, n) => { let s = ''; while (len(s) + len(seed) + 1 <= n) s += (s ? ' ' : '') + seed; return s; };

test('the limits per slide type', () => {
  assert.deepEqual({ ...LIMITS }, { coverHeadline: 56, textHeadline: 60, chartHeadline: 48, subline: 90, source: 60, chartLabel: 16, caption: 1800 });
  const n = 10;
  assert.equal(headlineLimit({ band: 'center' }, 0, n), 56);
  assert.equal(headlineLimit({ cta: true }, 9, n), 56);
  assert.equal(headlineLimit({ calc: { type: 'compare' } }, 3, n), 48);
  assert.equal(headlineLimit({ calc: null }, 3, n), 60);
});

test('overLimits finds exactly the fields that are too long (code points, not bytes)', () => {
  const spec = {
    caption: 'छोटा caption',
    slides: [
      { band: 'center', headline: words('बाज़ार', 56) },
      { headline: `${words('SIP', 44)} plans`, subline: words('निवेश', 90), calc: { type: 'compare', items: [{ label: 'Direct plan', value: 1 }, { label: 'Regular plan with commission', value: 2 }] } },
      { headline: 'ठीक', source: 'Economic Times, 2026-10-04' },
    ],
  };
  const over = overLimits(spec).map((o) => o.label);
  assert.deepEqual(over, ['slide 2 headline', 'slide 2 chart label']);
  assert.equal(overLimits({ slides: [], caption: 'क'.repeat(1801) })[0].label, 'caption');
});

test('trimAtWord: cuts only at a space, never a number, never mid-word (Devanagari or Roman)', () => {
  const hi = 'SIP में हर महीने निवेश करने से लंबे समय में फायदा बढ़ता है और compounding साथ देती है';
  const t = trimAtWord(hi, 48);
  assert.ok(len(t) <= 48);
  assert.ok(hi.startsWith(t));
  assert.ok(/\s/.test(hi[t.length]) || hi.slice(t.length).match(/^[\s,]/), 'the cut is at a word boundary');
  assert.equal(trimAtWord('NIFTY 22610.45 पर बंद हुआ और पिछला close 22421.95 था', 30), null, 'a number in the cut tail is never dropped');
  assert.equal(trimAtWord('Supercalifragilisticexpialidociousword', 20), null, 'one long word is not split');
  assert.equal(trimAtWord('छोटा text', 20), 'छोटा text');
  assert.equal(trimAtWord('एक बहुत लंबा शब्दों वाला वाक्य', 4), null, 'keeps at least 60% of the limit or refuses');
  assert.equal(trimAtWord('Expense ratio का असर, लंबे समय तक', 24), 'Expense ratio का असर', 'trailing comma removed');
});

test('enforceLimits: one shorten request for the over fields only, then trim, else a hard problem', async () => {
  const spec = { caption: 'ok', slides: [
    { band: 'center', headline: 'Hook' },
    { headline: words('बाज़ार', 70), calc: { type: 'compare', items: [{ label: 'a', value: 1 }] } },
    { headline: 'ठीक है', subline: `${words('निवेश', 80)} 2026 में ₹500 SIP` },
  ] };
  let calls = 0; let asked = '';
  const shorten = async (prompt) => { calls += 1; asked = prompt; return { fields: [{ n: 1, text: 'बाज़ार छोटा हुआ' }] }; };
  const res = await enforceLimits(spec, { shorten });
  assert.equal(calls, 1, 'asked once');
  assert.match(asked, /slide 2 headline — ज़्यादा से ज़्यादा 48/);
  assert.match(asked, /slide 3 subline — ज़्यादा से ज़्यादा 90/);
  assert.doesNotMatch(asked, /slide 1/, 'fields inside their limit are not sent');
  assert.equal(res.spec.slides[1].headline, 'बाज़ार छोटा हुआ');
  assert.equal(res.spec.slides[0].headline, 'Hook');
  assert.equal(res.problems.length, 1, 'the subline ends in numbers: cannot be trimmed safely → gate fails');
  assert.match(res.problems[0], /slide 3 subline is \d+ characters \(limit 90\) and cannot be trimmed safely/);

  const trimOnly = await enforceLimits({ slides: [{ headline: 'x' }, { headline: words('लंबा', 75) }] }, { shorten: async () => { throw new Error('model down'); } });
  assert.deepEqual(trimOnly.problems, []);
  assert.ok(len(trimOnly.spec.slides[1].headline) <= 60);
  assert.ok(trimOnly.actions.some((a) => /trimmed slide 2 headline at a word boundary/.test(a)));

  const fine = { slides: [{ headline: 'छोटा' }] };
  let none = 0;
  assert.deepEqual((await enforceLimits(fine, { shorten: async () => { none += 1; } })).problems, []);
  assert.equal(none, 0, 'no model call when everything fits');
});

test('the prompts carry the same limits code enforces', () => {
  for (const text of [
    buildUserPrompt({ category: 'mutual-funds', date: '2026-10-05' }),
    buildSourcedPrompt({ kind: 'market', stories: [], date: '2026-10-05' }),
    shortenPrompt([{ label: 'slide 2 headline', limit: 48, length: 70, text: 'x' }]),
  ]) assert.match(text, /48/);
  assert.match(buildUserPrompt({ category: 'mutual-funds', date: '2026-10-05' }), /headline ≤ 56 characters; chart वाली slide headline ≤ 48; बिना chart वाली ≤ 60[\s\S]*subline ≤ 90; source ≤ 60; chart label[^\n]*≤ 16[\s\S]*caption ≤ 1800/);
});
