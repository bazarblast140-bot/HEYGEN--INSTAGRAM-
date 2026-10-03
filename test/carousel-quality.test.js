import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  hindiProblems, hindiShare, numberProblems, leakProblems, emptyProblems, dropPaddedPanels,
  layoutProblems, safeArea, softQualityProblems, hardQualityProblems, FILLER_SOURCE, sourceProblems,
} from '../pipeline/src/carousel/quality.js';
import { softProblems } from '../pipeline/src/carousel/generate.js';
import { publishDecision } from '../pipeline/src/publish/allow.js';
import { shapeCaption } from '../pipeline/src/publish/caption.js';
import { BROKER_CTA } from '../pipeline/src/publish/cta.js';

// One worked example (revenue 100, cost 85 → profit 15, margin 15%); every
// slide's calc is built on it (example.js).
const good = {
  category: 'fundamentals',
  example: { type: 'margin', revenue: 100, cost: 85, unit: 'INR' },
  slides: [
    { band: 'center', headline: 'मार्जिन से असली कमाई पहचानो', subline: null, source: null, cta: false },
    { band: 'bottom', headline: 'मार्जिन 15% का मतलब', subline: 'हर ₹100 की बिक्री में ₹85 खर्च, ₹15 मुनाफ़ा', source: null, cta: false,
      calc: { type: 'margin', revenue: 100, cost: 85, unit: 'INR' } },
    { band: 'bottom', headline: 'बिक्री बड़ी, मुनाफ़ा छोटा', subline: 'हर ₹100 में सिर्फ़ ₹15 बचते हैं', source: null, cta: false,
      calc: { type: 'compare', unit: 'INR', items: [{ label: 'Sales', value: 100 }, { label: 'Profit', value: 15 }] } },
    { band: 'bottom', headline: 'सेव करो', subline: 'फ़ॉलो करो', source: null, cta: true },
  ],
};

test('Hindi: Devanagari must dominate; tickers, numbers and common English finance words do not count against it', () => {
  assert.deepEqual(hindiProblems(good), []);
  const hinglish = { slides: [{ headline: 'EMI में interest कितना जाता है', subline: 'Home loan की tenure, SIP return और tax समझो' }] };
  assert.ok(hindiShare(hinglish) > 0.95, `share ${hindiShare(hinglish)}`);
  assert.deepEqual(hindiProblems(hinglish), []);
  assert.ok(hindiShare(good) > 0.9);
  const english = {
    slides: [
      good.slides[0],
      { band: 'bottom', headline: 'Return Decomposition Formula', subline: 'Price CAGR ≈ EPS CAGR + P/E CAGR + Dividend Yield', source: 'CFA 2022' },
    ],
  };
  const problems = hindiProblems(english, { min: 0.5 });
  assert.ok(problems.some((p) => /slide 2 has no Hindi text/.test(p)), problems.join('; '));
  assert.deepEqual(hindiProblems({ slides: [{ headline: 'NIFTY 50 PE 22.5 EPS CAGR' }] }), [], 'tickers only is fine');
});

test('numbers: every finance content slide needs a calc, and every figure must match it', () => {
  assert.deepEqual(numberProblems(good), []);
  const noCalc = { ...good, slides: [good.slides[0], { ...good.slides[1], calc: null }, good.slides[3]] };
  assert.match(numberProblems(noCalc)[0], /slide 2 has no calc/);
  const wrong = { ...good, slides: [good.slides[0], { ...good.slides[1], headline: 'मार्जिन 17% का मतलब' }, good.slides[3]] };
  assert.match(numberProblems(wrong)[0], /"17%" does not match any computed figure/);
  const cover = { ...good, slides: [{ ...good.slides[0], headline: '73% लोग यह गलती करते हैं' }, ...good.slides.slice(1)] };
  assert.match(numberProblems(cover).join(' '), /slide 1: "73%"/);
  assert.match(numberProblems(good, { caption: 'मार्जिन 21% हो तो' }).join(' '), /caption: "21%"/);
});

test('sources: a finance slide shows no source label except the calculation note', () => {
  assert.deepEqual(sourceProblems(good), []);
  const labelled = { ...good, slides: [good.slides[0], { ...good.slides[1], source: 'SBI होम लोन EMI कैलकुलेटर 2025' }, good.slides[3]] };
  assert.match(sourceProblems(labelled)[0], /slide 2 shows the source label "SBI होम लोन EMI कैलकुलेटर 2025", which nothing in the pipeline verified/);
  const filler = { ...good, slides: [good.slides[0], { ...good.slides[1], source: FILLER_SOURCE }, good.slides[3]] };
  assert.equal(sourceProblems(filler).length, 1, 'the old filler label is refused too');
  const noted = { ...good, slides: [good.slides[0], { ...good.slides[1], source: 'Calculation: margin = (revenue − cost) ÷ revenue' }, good.slides[3]] };
  assert.deepEqual(sourceProblems(noted), [], 'the code-written calculation note is allowed');
  assert.match(sourceProblems(good, { caption: 'हुक\n\nस्रोत: RBI, 2025' })[0], /caption names a source/);
  const stories = [{ title: 'x', site: 'Reuters', date: '2026-10-02' }];
  const news = { slides: [{ band: 'center', headline: 'ख़बर' }, { band: 'bottom', headline: 'बात', source: 'Bloomberg, 2026-10-02' }] };
  assert.match(sourceProblems(news, { stories })[0], /not one of the fetched items/);
  assert.deepEqual(sourceProblems({ slides: [news.slides[0], { ...news.slides[1], source: 'Reuters, 2026-10-02' }] }, { stories }), []);
});

test('numbers on AI/news slides must come from the fetched items', () => {
  const stories = [{ title: 'Nvidia shares rise 4.2% after earnings', site: 'Reuters', date: '2026-10-02' }];
  const spec = {
    slides: [
      { band: 'center', headline: 'आज की AI ख़बर' },
      { band: 'bottom', headline: 'Nvidia शेयर 4.2% चढ़ा', subline: 'नतीजों के बाद', source: 'Reuters, 2026-10-02' },
      { band: 'bottom', headline: 'मार्केट कैप 5 ट्रिलियन', subline: 'नया रिकॉर्ड', source: 'Reuters, 2026-10-02' },
    ],
  };
  const problems = numberProblems(spec, { stories });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /slide 3 has number\(s\) 5 that are not in the fetched source items/);
});

test('leaked labels and placeholders are caught; handles and hashtags are not', () => {
  const leaky = {
    slides: [
      { headline: '{{headline}}' },
      { headline: 'मुख्य बात', subline: 'undefined' },
      { headline: 'label: ROCE', subline: 'NaN% रिटर्न' },
      { headline: 'मुख्य बात', subline: 'source_line यहाँ' },
      { headline: 'मुख्य बात', subline: '{"subline": "x"}' },
      { headline: 'TODO लिखना है' },
      { headline: 'ठीक', subline: 'null' },
    ],
  };
  const problems = leakProblems(leaky, { caption: 'कैप्शन' });
  assert.equal(problems.length, 8, problems.join('\n'));
  assert.deepEqual(leakProblems({ slides: [{ headline: 'फ़ॉलो करो @rajesh_technical_trader #nifty_50' }] }), []);
  assert.deepEqual(leakProblems(good, { caption: shapeCaption({ caption: 'हुक', hashtags: ['#roce'] }) }), []);
});

test('empty panels are found, and padded panels are dropped instead of shipped', () => {
  const padded = {
    slides: [
      good.slides[0], good.slides[1],
      { band: 'bottom', headline: good.slides[1].headline, subline: good.slides[1].subline, source: 'x' },
      { band: 'bottom', headline: 'सेव करो', subline: null, source: null, cta: false },
      { band: 'bottom', headline: ' … ', subline: null, source: null },
      good.slides[3],
    ],
  };
  const problems = emptyProblems(padded);
  assert.ok(problems.some((p) => /slide 3 repeats slide 2/.test(p)));
  assert.ok(problems.some((p) => /slide 5 is an empty panel/.test(p)));
  const { spec, dropped } = dropPaddedPanels(padded);
  assert.equal(dropped, 3);
  assert.equal(spec.slides.length, 3);
  assert.equal(spec.slides.at(-1).cta, true);
  assert.deepEqual(emptyProblems(spec), []);
});

test('rendered text must stay inside the 6% safe inset (which covers the 3:4 grid crop)', () => {
  const area = safeArea({ width: 1080, height: 1350 });
  assert.equal(Math.round(area.left), 65);
  assert.equal(Math.round(area.top), 81);
  const inside = [{ boxes: [{ id: 'headline', left: 80, top: 700, right: 1000, bottom: 900 }], clipped: [] }];
  assert.deepEqual(layoutProblems(inside, { width: 1080, height: 1350 }), []);
  const out = [
    { boxes: [{ id: 'headline', left: 30, top: 700, right: 1060, bottom: 900 }], clipped: ['headline'] },
    { boxes: [{ id: 'subline', left: 100, top: 700, right: 900, bottom: 1320 }], clipped: [] },
  ];
  const problems = layoutProblems(out, { width: 1080, height: 1350 });
  assert.ok(problems.some((p) => /slide 1 headline is outside/.test(p)));
  assert.ok(problems.some((p) => /slide 1 headline is cut off/.test(p)));
  assert.ok(problems.some((p) => /slide 2 subline is outside .*bottom/.test(p)));
  assert.ok(problems.some((p) => /slide 2 rendered no headline/.test(p)));
  const story = safeArea({ width: 1080, height: 1920, story: true, bottomInset: 260 });
  assert.ok(story.top >= 250 && story.bottom <= 1670);
});

test('the quality rules run inside the existing generation retries (soft) and block at the gate (hard)', () => {
  const bad = { ...good, slides: [good.slides[0], { ...good.slides[1], subline: 'undefined' }, good.slides[3]] };
  assert.ok(softProblems(bad).some((p) => /undefined/.test(p)));
  assert.ok(softQualityProblems(bad).length > 0);
  assert.ok(hardQualityProblems(bad).length > 0);
  assert.deepEqual(hardQualityProblems(good, { caption: 'ठीक' }), []);
});

test('a failed quality gate is never published', () => {
  const base = { generated: true, fallback: false, category: 'fundamentals', spec: { slides: [] } };
  assert.equal(publishDecision(base).ok, true);
  const refused = publishDecision({ ...base, quality: { ok: false, problems: ['slide 2 is outside the 6% safe area'] } });
  assert.equal(refused.ok, false);
  assert.match(refused.reasons[0], /quality gate REFUSED: slide 2/);
  assert.equal(publishDecision({ ...base, quality: { ok: true, problems: [] } }).ok, true);
});

test('captions end with one broker "link in bio" CTA and carry no URLs', () => {
  const model = [
    'Bonus के बाद return बदलता है।',
    'Zerodha: https://zerodha.com/open-account?c=KU3466',
    'Account kholne ke liye link in bio 👆',
    'Broker links bio mein hain.',
    '#bonusissue #nse',
    'Link in bio.',
  ].join('\n\n');
  const caption = shapeCaption({ caption: model, hashtags: [] });
  assert.ok(caption.endsWith(BROKER_CTA), caption);
  assert.equal((caption.match(/link in bio/gi) || []).length, 1, caption);
  assert.equal(/bio mein/i.test(caption), false);
  assert.equal(/https?:\/\//.test(caption), false);
  assert.match(caption, /#bonusissue #nse/);
  assert.equal(shapeCaption({ caption, hashtags: [] }), caption, 're-shaping is stable (no second CTA)');
});
