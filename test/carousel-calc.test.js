// The code computes every financial figure; the model's figures are re-read
// and must match. The live SBI EMI carousel said "₹50 लाख लोन, 8.5% ब्याज ...
// कुल ब्याज लगभग ₹52 लाख"; the formula says ₹54.14 लाख.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emi, amortization, sipFutureValue, lumpsum, cagr, realValue, pctChange, recoveryNeeded,
  computeCalc, formatINR, CALC_TYPES,
} from '../pipeline/src/carousel/calc.js';
import { parseFigures, mismatches, latinDigits } from '../pipeline/src/carousel/figures.js';
import { financeNumberProblems, hardQualityProblems } from '../pipeline/src/carousel/quality.js';
import { heavyWordsIn, heavyWordProblems, repairHeavyWords, HEAVY_WORDS } from '../pipeline/src/carousel/language.js';
import { boardSlides } from '../pipeline/src/carousel/board.js';
import { SYSTEM } from '../pipeline/src/carousel/prompt.js';
import { validateSpec } from '../pipeline/build-carousel.js';

const LOAN = { type: 'emi', principal: 5000000, rate: 8.5, years: 20 };

test('₹50 lakh at 8.5% for 20 years: EMI 43,391 and total interest ≈ ₹54.14 lakh', () => {
  const e = emi(5000000, 8.5, 20);
  assert.ok(Math.abs(e - 43391) <= 1, `EMI ${e}`);
  const r = computeCalc(LOAN);
  assert.equal(r.ok, true);
  const get = (k) => r.all.find((f) => f.key === k);
  assert.ok(Math.abs(get('totalInterest').value - 5413879) < 100, `interest ${get('totalInterest').value}`);
  assert.equal(get('totalInterest').text, '₹54.14 लाख');
  assert.equal(get('emi').text, '₹43,391');
  assert.equal(get('months').value, 240);
  assert.ok(Math.abs(get('totalPayment').value - 10413879) < 100);
  const { yearly } = amortization(5000000, 8.5, 20);
  assert.equal(yearly.length, 20);
  assert.ok(yearly.at(-1).balance < 1, 'the loan is paid off');
  assert.ok(Math.abs(yearly.reduce((s, y) => s + y.principal, 0) - 5000000) < 1);
});

test('the original wrong "₹52 लाख" fails the check; the right figure passes', () => {
  const r = computeCalc(LOAN);
  const bad = mismatches('₹50 लाख लोन, 8.5% ब्याज, 20 साल — कुल ब्याज लगभग ₹52 लाख', r.all);
  assert.equal(bad.length, 1);
  assert.equal(bad[0].token.value, 5200000);
  assert.deepEqual(mismatches('₹50 लाख, 8.5%, 20 साल: EMI ₹43,391, कुल interest ₹54.14 लाख', r.all), []);
  assert.deepEqual(mismatches('कुल interest ₹54 लाख से ज़्यादा', r.all), [], '54 vs 54.14 is rounding');
  assert.equal(mismatches('कुल ₹1 करोड़ चुकाओगे', r.all).length, 1, '1 vs 1.04 crore is 4% off, not rounding');
  assert.deepEqual(mismatches('कुल ₹1.04 करोड़ चुकाओगे', r.all), []);
  // 52% is the interest share — a percent may not stand in for a rupee figure.
  assert.deepEqual(mismatches('EMI का 52% interest', r.all), []);

  const spec = {
    category: 'personal-finance',
    slides: [
      { band: 'center', headline: '₹50 लाख का home loan', cta: false },
      { band: 'bottom', headline: 'कुल ब्याज लगभग ₹52 लाख', subline: '₹50 लाख, 8.5%, 20 साल', calc: LOAN, cta: false },
      { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
    ],
  };
  const problems = hardQualityProblems(spec, { caption: 'हुक' });
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /slide 2: "₹52 लाख" does not match any computed figure/);
});

test('lakh / crore / ₹ / % parsing in Devanagari and Latin text', () => {
  const v = (text) => parseFigures(text).map((t) => [t.value, t.kind]);
  assert.deepEqual(v('₹50 लाख'), [[5000000, 'INR']]);
  assert.deepEqual(v('₹५० लाख'), [[5000000, 'INR']]);
  assert.deepEqual(v('50 lakh'), [[5000000, 'INR']]);
  assert.deepEqual(v('₹50L'), [[5000000, 'INR']]);
  assert.deepEqual(v('Rs 54.14 lakh'), [[5414000, 'INR']]);
  assert.deepEqual(v('₹1.2 करोड़'), [[12000000, 'INR']]);
  assert.deepEqual(v('1.2 crore'), [[12000000, 'INR']]);
  assert.deepEqual(v('₹2.5Cr'), [[25000000, 'INR']]);
  assert.deepEqual(v('₹43,391'), [[43391, 'INR']]);
  assert.deepEqual(v('5,00,000 रुपये'), [[500000, 'INR']]);
  assert.deepEqual(v('₹१०,००० हर महीने'), [[10000, 'INR']]);
  assert.deepEqual(v('40 हज़ार रुपये'), [[40000, 'INR']]);
  assert.deepEqual(v('8.5%'), [[8.5, 'PCT']]);
  assert.deepEqual(v('८.५ प्रतिशत'), [[8.5, 'PCT']]);
  assert.deepEqual(v('12 percent'), [[12, 'PCT']]);
  assert.deepEqual(v('20 साल'), [[20, 'YEARS']]);
  assert.deepEqual(v('20 years'), [[20, 'YEARS']]);
  assert.deepEqual(v('240 महीने'), [[240, 'MONTHS']]);
  assert.deepEqual(v('NIFTY 50'), [[50, 'INDEX']]);
  assert.equal(latinDigits('२०२६'), '2026');
  // "L" only counts as lakh when it touches the number
  assert.deepEqual(v('50 Loan'), [[50, 'NUM']]);
});

test('standard formulas: SIP, lump sum, CAGR, inflation, % change, drawdown', () => {
  // ₹10,000 a month, 12%, 20 years, payment at the start of each month
  assert.ok(Math.abs(sipFutureValue(10000, 12, 20) - 9991479) < 5, `${sipFutureValue(10000, 12, 20)}`);
  assert.ok(Math.abs(lumpsum(100000, 12, 10) - 310584.82) < 0.1);
  assert.ok(Math.abs(cagr(100, 200, 5) - 14.87) < 0.01);
  assert.ok(Math.abs(realValue(100000, 6, 10) - 55839.48) < 0.1);
  assert.equal(pctChange(80, 100), 25);
  assert.equal(recoveryNeeded(50), 100);
  assert.ok(Math.abs(recoveryNeeded(20) - 25) < 1e-9);
  assert.equal(formatINR(5413879), '₹54.14 लाख');
  assert.equal(formatINR(10413879), '₹1.04 करोड़');
  for (const type of CALC_TYPES) assert.equal(typeof type, 'string');
  const position = computeCalc({ type: 'position', capital: 100000, riskPct: 1, entry: 500, stop: 490 });
  assert.equal(position.all.find((f) => f.key === 'qty').value, 100);
});

test('a bad calc is reported, never thrown', () => {
  assert.equal(computeCalc({ type: 'emi', principal: 5000000 }).ok, false);
  assert.match(computeCalc({ type: 'emi', principal: 5000000 }).error, /emi needs rate, years/);
  assert.match(computeCalc({ type: 'magic' }).error, /unknown calc type/);
  assert.equal(computeCalc(null).ok, false);
  const problems = financeNumberProblems({
    category: 'personal-finance',
    slides: [{ band: 'center', headline: 'x' }, { band: 'bottom', headline: 'y', calc: { type: 'emi' } }, { band: 'bottom', headline: 'सेव करो', cta: true }],
  });
  assert.match(problems[0], /slide 2 calc is invalid/);
});

test('heavy words are banned in the prompt and at the gate; plain words replace them', () => {
  for (const word of ['अवधि', 'मूलधन', 'प्रतिफल', 'निवेशकों हेतु']) {
    assert.ok(HEAVY_WORDS.some(([w]) => w === word), word);
    assert.ok(SYSTEM.includes(word), `the prompt names ${word}`);
  }
  assert.deepEqual(heavyWordsIn('मूलधन ₹50 लाख, अवधि 20 साल').map((h) => h.word), ['अवधि', 'मूलधन']);
  assert.deepEqual(heavyWordsIn('Loan amount ₹50 लाख, tenure 20 साल, ये करो'), []);
  const spec = { slides: [{ headline: 'अवधि 20 साल', subline: 'मूलधन ₹50 लाख' }], caption: 'निवेशकों हेतु' };
  assert.equal(heavyWordProblems(spec).length, 3);
  const { spec: fixed, replaced } = repairHeavyWords(spec);
  assert.equal(fixed.slides[0].headline, 'tenure 20 साल');
  assert.equal(fixed.slides[0].subline, 'principal ₹50 लाख');
  assert.equal(fixed.caption, 'investors के लिए');
  assert.equal(replaced.length, 3);
  assert.deepEqual(heavyWordProblems(fixed), []);
});

test('chart-board: every content slide gets a computed chart, no photo, and a literally true footnote', () => {
  const spec = {
    category: 'personal-finance',
    slides: [
      { band: 'center', headline: 'हुक' },
      { band: 'bottom', headline: 'EMI', calc: { ...LOAN, view: 'split' }, source: 'SBI होम लोन EMI कैलकुलेटर 2025' },
      { band: 'bottom', headline: 'Balance', calc: { ...LOAN, view: 'balance' } },
      { band: 'bottom', headline: 'हर साल', calc: { ...LOAN, view: 'yearly' } },
      { band: 'bottom', headline: 'SIP', calc: { type: 'sip', monthly: 10000, rate: 12, years: 20 } },
      { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
    ],
  };
  const out = boardSlides(spec);
  assert.equal(out.every((s) => !s.background), true, 'no stock photo');
  assert.deepEqual(out.slice(1, 5).map((s) => s.chart.kind), ['split', 'line', 'stackbars', 'line']);
  assert.equal(out[1].source, 'Calculation: standard EMI formula (monthly reducing balance)', 'the unverified SBI label is gone');
  assert.equal(out[1].footnote, out[1].source);
  assert.deepEqual(out[1].figures.map((f) => f.text), ['₹43,391', '₹54.14 लाख', '₹1.04 करोड़']);
  assert.equal(out[0].chart.kind, 'split', 'the cover shows the first chart');
  assert.equal(out.at(-1).chart, null);
  assert.deepEqual(validateSpec({ ...spec, slides: [...spec.slides.slice(0, 5), spec.slides[5]] }), []);
  const missing = validateSpec({ ...spec, slides: [spec.slides[0], { band: 'bottom', headline: 'x' }, spec.slides[5]] });
  assert.match(missing.join(' '), /slide 2 has no "calc"/);
});
