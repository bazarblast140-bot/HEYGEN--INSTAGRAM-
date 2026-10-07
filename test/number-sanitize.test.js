// 7 Oct midday (run 37588434602) was refused: the model wrote an expense-ratio
// carousel with its own 1%, 0.2%, 11%, 11.8% and corpus values. Now: code
// computes the numbers first and hands them to the prompt; after generation a
// figure the code did not compute is taken out (not the whole build); one
// retry if numbers still fail; the hard gate stays the final check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCalc } from '../pipeline/src/carousel/calc.js';
import { numberSheetPrompt, presetsFor } from '../pipeline/src/carousel/number-sheet.js';
import { buildUserPrompt } from '../pipeline/src/carousel/prompt.js';
import { sanitizeNumbers, settleNumbers, cutFigures, numbersLeft, FINANCE_FILLER } from '../pipeline/src/carousel/sanitize.js';
import { numberProblems, emptyProblems } from '../pipeline/src/carousel/quality.js';
import { SLIDES } from '../pipeline/src/carousel/categories.js';

const slide = (headline, subline, calc) => ({ band: 'bottom', headline, subline, source: null, cta: false, calc });
const cover = { band: 'center', headline: 'Expense ratio का असली असर', subline: null, source: null, cta: false, calc: null };
const follow = { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो ऐसे और calculations के लिए', source: null, cta: true, calc: null };
const LUMP = { type: 'lumpsum', amount: 100000, rate: 12, years: 20 };

/** What the model sent on 7 Oct, reduced: rates and corpus values code never computed. */
function sevenOct() {
  return {
    category: 'mutual-funds',
    topic: 'Expense ratio 1% बनाम 0.2%',
    example: LUMP,
    caption: 'Expense ratio छोटा लगता है। 1% और 0.2% में ₹1.25 लाख का फ़र्क़ है। सेव करो।',
    slides: [
      cover,
      slide('₹1 लाख, 12% पर 20 साल', '₹9.65 लाख बनते हैं', LUMP),
      slide('1% expense से return 11%', 'corpus ₹8.06 लाख', { type: 'lumpsum', amount: 100000, rate: 11, years: 20 }),
      slide('0.2% expense से return 11.8%', 'corpus ₹9.31 लाख', { type: 'lumpsum', amount: 100000, rate: 11.8, years: 20 }),
      slide('फ़र्क़ ₹1.25 लाख का', 'छोटा खर्च, बड़ा असर', { type: 'compare', unit: 'INR', items: [{ label: '1% expense', value: 806231 }, { label: '0.2% expense', value: 931425 }] }),
      slide('10 साल में भी असर', '₹3.11 लाख बनते हैं', { ...LUMP, years: 10 }),
      slide('समय सबसे बड़ा दोस्त', '30 साल में ₹29.96 लाख', { ...LUMP, years: 30 }),
      slide('Compounding का जादू', 'ज़्यादा साल, ज़्यादा फ़ायदा', LUMP),
      slide('Direct plan देखो', 'खर्च कम तो return ज़्यादा', LUMP),
      follow,
    ],
  };
}

test('expense_ratio: code computes net returns, both values and the gap', () => {
  const r = computeCalc({ type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1, 0.2] });
  assert.equal(r.ok, true);
  const v = Object.fromEntries(r.all.map((f) => [f.key, f.value]));
  assert.equal(v.net0, 11);
  assert.ok(Math.abs(v.net1 - 11.8) < 1e-9);
  assert.equal(Math.round(v.value0), Math.round(100000 * 1.11 ** 20));
  assert.equal(Math.round(v.value1), Math.round(100000 * 1.118 ** 20));
  assert.equal(Math.round(v.gap), Math.round(v.value1 - v.value0));
  const sip = computeCalc({ type: 'expense_ratio', monthly: 10000, rate: 12, years: 20, expenses: [1.5, 0.5] });
  assert.equal(sip.ok, true);
  assert.equal(computeCalc({ type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1] }).ok, false);
  assert.equal(computeCalc({ type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1, 5] }).ok, false);
});

test('an expense-ratio carousel built on the expense_ratio example passes the number gate as written', () => {
  const ex = { type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1, 0.2] };
  const spec = {
    category: 'mutual-funds', topic: 'Expense ratio का असर', example: ex, caption: 'Expense ratio छोटा दिखता है, असर बड़ा।',
    slides: [cover,
      slide('1% बनाम 0.2% expense ratio', '₹1 लाख, 12% पर 20 साल', ex),
      slide('Regular plan: return 11%', 'corpus ₹8.06 लाख', { type: 'lumpsum', amount: 100000, rate: 11, years: 20 }),
      slide('Direct plan: return 11.8%', 'corpus ₹9.31 लाख', { type: 'lumpsum', amount: 100000, rate: 11.8, years: 20 }),
      slide('फ़र्क़ ₹1.25 लाख', 'सिर्फ़ खर्च के कारण', ex),
      slide('30 साल में फ़र्क़ और बड़ा', 'समय के साथ बढ़ता है', { ...ex, years: 30 }),
      slide('Direct plan देखो', 'खर्च कम तो corpus ज़्यादा', ex),
      slide('Compounding खर्च पर भी', 'हर साल कटता है', ex),
      slide('Regular plan में commission', 'वही खर्च बढ़ाता है', ex),
      follow],
  };
  assert.deepEqual(numberProblems(spec, { caption: spec.caption }), []);
  const { actions } = sanitizeNumbers(spec);
  assert.deepEqual(actions, [], 'nothing to sanitize');
});

test('the prompt lists the code-computed numbers and forbids any other digit', () => {
  const sheet = numberSheetPrompt('mutual-funds');
  assert.match(sheet, /<computed_numbers>/);
  assert.match(sheet, /कोई और digit/);
  assert.match(sheet, /"type":"expense_ratio"/);
  assert.match(sheet, /Net return 11%/);
  assert.match(sheet, /Value @0\.2% ₹9\.31 लाख/);
  assert.ok(presetsFor('mutual-funds').length >= 4);
  assert.equal(numberSheetPrompt('options'), '', 'no presets → no sheet');
  // A retry also lists the earlier example's figures, computed.
  assert.match(numberSheetPrompt('options', { example: { type: 'option', kind: 'long_call', strike: 24000, premium: 120, lot: 75 } }), /पिछली कोशिश का example/);
  const prompt = buildUserPrompt({ category: 'mutual-funds', date: '2026-10-08' });
  assert.match(prompt, /<computed_numbers>/);
  assert.match(prompt, /expense_ratio/);
});

test('sanitizer: the 7 Oct carousel loses only what code did not compute; 10 slides; number gate clean', () => {
  const spec = sevenOct();
  assert.ok(numberProblems(spec, { caption: spec.caption }).length > 0, 'precondition: it was refused');
  const { spec: clean, actions } = sanitizeNumbers(spec);
  assert.equal(clean.slides.length, SLIDES);
  assert.deepEqual(numberProblems(clean, { caption: clean.caption }), []);
  assert.deepEqual(emptyProblems(clean), []);
  assert.ok(actions.some((a) => /chart redrawn from the worked example/.test(a)));
  assert.ok(actions.some((a) => /removed figure/.test(a)));
  assert.ok(actions.some((a) => /caption: dropped 1 sentence/.test(a)));
  for (const s of clean.slides) {
    assert.ok(String(s.headline || '').trim().length > 0);
    assert.doesNotMatch(`${s.headline} ${s.subline || ''}`, /\b0\.2%|11\.8%|\b11%/);
  }
  // Correct figures survive.
  assert.equal(clean.slides[1].headline, '₹1 लाख, 12% पर 20 साल');
  assert.equal(clean.slides[1].subline, '₹9.65 लाख बनते हैं');
  assert.equal(clean.caption, 'Expense ratio छोटा लगता है। सेव करो।');
  // Never adds a number.
  const digits = (sp) => sp.slides.map((s) => `${s.headline} ${s.subline || ''}`).join(' ').match(/\d/g)?.length || 0;
  assert.ok(digits(clean) < digits(spec));
});

test('cutFigures removes the written figure with its unit and tidies the line', () => {
  const t = (s, re) => { const toks = []; let m; const r = new RegExp(re, 'g'); while ((m = r.exec(s))) toks.push({ start: m.index, stop: m.index + m[0].length }); return cutFigures(s, toks); };
  assert.equal(t('1% expense से return 11%', '1%|11%'), 'expense से return');
  assert.equal(t('फ़र्क़ ₹1.2 लाख का', '₹1\\.2 लाख'), 'फ़र्क़');
  assert.equal(t('return (11.8%) मिलता है', '11\\.8%'), 'return मिलता है');
});

test('a headline left with almost nothing gets a plain line; a broken subline is dropped', () => {
  const spec = sevenOct();
  spec.slides[2] = slide('₹8.06 लाख', 'सिर्फ़ ₹8.06 लाख', { type: 'lumpsum', amount: 100000, rate: 11, years: 20 });
  const { spec: clean } = sanitizeNumbers(spec);
  assert.equal(clean.slides[2].headline, FINANCE_FILLER);
  assert.equal(clean.slides[2].subline, null);
  assert.deepEqual(numberProblems(clean, { caption: clean.caption }), []);
});

test('AI/news (sourced) slots: numbers not in the fetched items are removed, unbacked charts dropped, real ones kept', () => {
  const stories = [{ title: 'OpenAI raises $40 billion at a 300 billion valuation', date: '2026-10-07', summary: 'Funding round of 40 billion', site: 'reuters.com' }];
  const spec = {
    category: 'ai-news', topic: 'OpenAI funding',
    caption: 'OpenAI की funding.',
    slides: [
      { band: 'center', headline: 'OpenAI को बड़ी funding', subline: null, source: null, cta: false, calc: null },
      slide('OpenAI को $40 billion', 'valuation 300 billion, 25% ज़्यादा', null),
      slide('Investors का भरोसा', 'पिछले साल से 2.5 गुना', { type: 'compare', unit: 'num', items: [{ label: 'Then', value: 120 }, { label: 'Now', value: 300 }] }),
      follow,
    ],
  };
  const { spec: clean, actions } = sanitizeNumbers(spec, { stories });
  assert.match(clean.slides[1].headline, /40/);
  assert.match(clean.slides[1].subline, /300/);
  assert.doesNotMatch(clean.slides[1].subline, /25%/);
  assert.equal(clean.slides[2].calc, null);
  assert.ok(actions.some((a) => /chart dropped/.test(a)));
  assert.deepEqual(numberProblems(clean, { stories }), []);
});

test('settleNumbers: clean → no retry; problems left → exactly ONE retry; a failed retry keeps the first result', async () => {
  const clean = { spec: { ...sevenOct(), slides: sevenOct().slides.map((s, i) => (i >= 2 && i <= 4 ? slide('Compounding का असर', 'समय के साथ', LUMP) : s)), caption: 'ठीक है।' }, slot: 'midday', category: 'mutual-funds' };
  let calls = 0;
  const r1 = await settleNumbers(clean, { retry: async () => { calls += 1; return clean; } });
  assert.equal(r1.retried, false);
  assert.equal(calls, 0);

  // Charts had to be redrawn → one retry; the retry is clean, so it is used.
  const dirty = { spec: sevenOct(), slot: 'midday', category: 'mutual-funds' };
  let feedback = null;
  const r2 = await settleNumbers(dirty, { retry: async (fb, example) => { calls += 1; feedback = fb; assert.deepEqual(example, LUMP); return clean; } });
  assert.equal(calls, 1);
  assert.equal(r2.retried, true);
  assert.ok(feedback.length > 0);
  assert.equal(r2.written.spec.slides[2].headline, 'Compounding का असर');

  // A retry that throws keeps the sanitized first result (still number-clean).
  const r3 = await settleNumbers(dirty, { retry: async () => { throw new Error('provider down'); } });
  assert.equal(r3.retried, true);
  assert.deepEqual(numbersLeft(r3.written.spec), []);
  assert.equal(r3.written.spec.slides.length, SLIDES);
});

test('build-carousel: one retry with maxAttempts 1, topic recorded once after the numbers settle', async () => {
  const fs = await import('node:fs/promises');
  const src = await fs.readFile(new URL('../pipeline/build-carousel.js', import.meta.url), 'utf8');
  assert.match(src, /settleNumbers\(written/);
  assert.match(src, /write\(\{ maxAttempts: 1, feedback/);
  assert.equal((src.match(/record: false/g) || []).length, 2, 'generators do not record; build-carousel does');
  assert.match(src, /await recordTopic\(\{ topic: written\.spec\.topic/);
  // The final hard gate still runs on the result.
  assert.match(src, /\.\.\.hardQualityProblems\(ready, \{ stories: fetchedStories, caption \}\)/);
});
