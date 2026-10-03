import { computeCalc } from './calc.js';
import { mismatches, describe } from './figures.js';
import { stripAllowedEnglish, heavyWordProblems } from './language.js';
import { FINANCE } from './categories.js';

// Pre-publish quality rules for carousels.
//
// Two tiers, so no rule adds a paid loop:
//   * softQualityProblems — handed back to the model inside the existing
//     three-attempt generation loop (MAX_MODEL_ATTEMPTS), exactly like the
//     echo and money-source checks.
//   * gateCarousel — run on the final spec and on the rendered slides. A hard
//     problem blocks the publish (report.publishable=false, quality.ok=false).
//     Layout problems get one free re-render with tighter type first; padded
//     empty panels are dropped (repair) rather than blocking.
//
// What each rule can and cannot see:
//   Hindi      — script share of the slide text, after removing tickers/ALL-CAPS
//                abbreviations, numbers, hashtags and handles. Reliable.
//   Numbers    — finance slots: every content slide carries a structured calc
//                ({type:'emi', principal, rate, years} ...) and calc.js computes
//                every figure. Each number the model wrote is re-read
//                (figures.js) and must match an input or a computed figure
//                within rounding (>1% off blocks). AI/news slots: every number
//                must appear in the fetched feed items (or be computed by code
//                from numbers that do).
//   Sources    — finance slides show no source label, only the literally true
//                calculation note from calc.js. AI/news slides may cite only an
//                outlet that is in the fetched items.
//   Language   — Devanagari share after removing tickers and the encouraged
//                English finance words (EMI, interest, loan, tenure, SIP ...);
//                heavy words (अवधि, मूलधन, प्रतिफल ...) are banned.
//   Cut-off    — rendered glyph boxes (DOM Range rects in the slide scene)
//                against a 6% inset, which also covers Instagram's 3:4 grid crop
//                of a 4:5 post. Reliable for text; pictures are not checked.
//   Empty      — no headline content, or a padded duplicate panel.
//   Leaks      — '{{', 'undefined', 'null', 'NaN', 'TODO', 'label:', raw JSON keys.

export const SAFE_INSET = 0.06;
export const GRID_CROP_3x4 = (1080 - (1350 * 3) / 4) / 2 / 1080; // ≈3.1% each side of a 4:5 post
export const STORY_SAFE_TOP = 250;
export const HINDI_SOFT = 0.6;
export const HINDI_HARD = 0.5;
export const FILLER_SOURCE = 'NSE / BSE public market data, 2024';

function slideText(slide) {
  return [slide?.headline, slide?.subline].filter(Boolean).join(' ');
}

const isFact = (slide, i) => i !== 0 && slide?.band !== 'center' && !slide?.cta;

// ---------------------------------------------------------------- Hindi

export function scriptCounts(text) {
  const t = stripAllowedEnglish(String(text || '')
    .replace(/https?:\/\/\S+/g, ' '))
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#][\w\u0900-\u097F]+/g, ' ')
    .replace(/\b[A-Z][A-Z0-9&/.\-]+\b/g, ' ')   // NIFTY, EPS, P/E, CAGR, HDFC
    .replace(/[0-9]/g, ' ');
  return {
    devanagari: (t.match(/[\u0900-\u097F]/g) || []).length,
    latin: (t.match(/[A-Za-z]/g) || []).length,
  };
}

export function hindiShare(spec) {
  let d = 0;
  let l = 0;
  for (const slide of spec?.slides || []) {
    const c = scriptCounts(slideText(slide));
    d += c.devanagari;
    l += c.latin;
  }
  return d + l === 0 ? 1 : d / (d + l);
}

export function hindiProblems(spec, { min = HINDI_SOFT } = {}) {
  const problems = [];
  const share = hindiShare(spec);
  if (share < min) {
    problems.push(`slide text is ${Math.round(share * 100)}% Devanagari — write simple Hinglish: Hindi in Devanagari, with common finance words (EMI, interest, loan, tenure, SIP, return, tax) in English`);
  }
  (spec?.slides || []).forEach((slide, i) => {
    const c = scriptCounts(slideText(slide));
    if (c.devanagari === 0 && c.latin >= 8) problems.push(`slide ${i + 1} has no Hindi text — write it in Devanagari`);
  });
  return problems;
}

// ---------------------------------------------------------------- numbers

export function numbersIn(text) {
  return (String(text || '').match(/\d+(?:[.,]\d+)*/g) || [])
    .map((n) => n.replace(/,/g, ''))
    .map((n) => n.replace(/\.0+$/, ''));
}

const stripTags = (text) => String(text || '').replace(/[@#][\w.\u0900-\u097F]+/g, ' ');

/** The computed calc for every slide (null where there is none). */
export function slideCalcs(spec) {
  return (spec?.slides || []).map((slide) => (slide?.calc ? computeCalc(slide.calc) : null));
}

/**
 * Finance: each content slide needs a valid calc; every figure in its text is
 * an input or a computed figure (within rounding). The cover, the follow card
 * and the caption are checked against every slide's figures.
 */
export function financeNumberProblems(spec, { caption = null } = {}) {
  const problems = [];
  const slides = spec?.slides || [];
  const calcs = slideCalcs(spec);
  const everything = calcs.filter((c) => c?.ok).flatMap((c) => c.all);
  slides.forEach((slide, i) => {
    const text = slideText(slide);
    const calc = calcs[i];
    if (isFact(slide, i)) {
      if (!calc) { problems.push(`slide ${i + 1} has no calc — every content slide needs structured inputs for its chart (e.g. {"type":"emi","principal":5000000,"rate":8.5,"years":20})`); return; }
      if (!calc.ok) { problems.push(`slide ${i + 1} calc is invalid: ${calc.error}`); return; }
      for (const m of mismatches(text, calc.all)) problems.push(`slide ${i + 1}: ${describe(m)}`);
    } else {
      for (const m of mismatches(text, everything)) problems.push(`slide ${i + 1}: ${describe(m)}`);
    }
  });
  const cap = caption ?? spec?.caption;
  if (cap) for (const m of mismatches(stripTags(cap), everything)) problems.push(`caption: ${describe(m)}`);
  return problems;
}

/** AI/news: numbers come from the fetched items, or from code over those numbers. */
export function sourcedNumberProblems(spec, { stories }) {
  const problems = [];
  const slides = spec?.slides || [];
  const pool = new Set(stories.flatMap((s) => [...numbersIn(s.title), ...numbersIn(s.date), ...numbersIn(s.summary)]));
  const calcs = slideCalcs(spec);
  slides.forEach((slide, i) => {
    let allowed = pool;
    const calc = calcs[i];
    if (calc?.ok) {
      const inputs = calc.inputs.map((f) => String(Number(f.value.toFixed(4))));
      const missingInputs = inputs.filter((n) => !pool.has(n));
      if (missingInputs.length) problems.push(`slide ${i + 1} chart uses ${missingInputs.join(', ')}, which are not in the fetched source items`);
      else allowed = new Set([...pool, ...calc.figures.map((f) => f.text.replace(/[^\d.]/g, '')), ...calc.figures.map((f) => String(Math.round(f.value)))]);
    } else if (calc && !calc.ok) {
      problems.push(`slide ${i + 1} chart calc is invalid: ${calc.error}`);
    }
    const nums = numbersIn(slideText(slide));
    if (!nums.length || !isFact(slide, i)) return;
    const missing = nums.filter((n) => !allowed.has(n));
    if (missing.length) problems.push(`slide ${i + 1} has number(s) ${missing.join(', ')} that are not in the fetched source items — use only numbers from the source`);
  });
  return problems;
}

export function numberProblems(spec, { stories = null, caption = null } = {}) {
  if (stories) return sourcedNumberProblems(spec, { stories });
  if (FINANCE.includes(spec?.category)) return financeNumberProblems(spec, { caption });
  return [];
}

// ---------------------------------------------------------------- sources

const SOURCE_WORD = /(?:स्रोत|source)\s*:/i;

/**
 * No source label unless it is verified. Finance: a slide may show only its
 * calculation note (written by code from calc.js), and the caption names no
 * source. AI/news: a cited outlet must be one of the fetched items.
 */
export function sourceProblems(spec, { stories = null, caption = null } = {}) {
  const problems = [];
  const slides = spec?.slides || [];
  if (stories) {
    const sites = [...new Set(stories.map((s) => String(s.site || '').toLowerCase()).filter(Boolean))];
    slides.forEach((slide, i) => {
      const cited = String(slide.source || '').toLowerCase();
      if (!cited || !isFact(slide, i)) return;
      if (!sites.some((site) => cited.includes(site))) problems.push(`slide ${i + 1} cites "${slide.source}", which is not one of the fetched items`);
    });
    return problems;
  }
  if (spec?.category && !FINANCE.includes(spec.category)) {
    slides.forEach((slide, i) => {
      if (String(slide.source || '').trim() && isFact(slide, i)) problems.push(`slide ${i + 1} cites "${slide.source}" but no fetched items back it`);
    });
    return problems;
  }
  const calcs = slideCalcs(spec);
  slides.forEach((slide, i) => {
    const shown = String(slide.source || '').trim();
    if (!shown) return;
    const note = calcs[i]?.ok ? calcs[i].note : null;
    if (shown !== note) problems.push(`slide ${i + 1} shows the source label "${shown}", which nothing in the pipeline verified — finance slides carry no source label`);
  });
  const cap = caption ?? spec?.caption;
  if (cap && SOURCE_WORD.test(cap)) problems.push('caption names a source that nothing in the pipeline verified — remove the "स्रोत:" line');
  return problems;
}

// ---------------------------------------------------------------- leaks

const LEAK_ANY = [
  [/\{\{|\}\}/, '"{{"'],
  [/\bundefined\b/i, '"undefined"'],
  [/\bnull\b/i, '"null"'],
  [/\bNaN\b/, '"NaN"'],
  [/\b(?:TODO|TBD|FIXME|XXX)\b/, 'a TODO marker'],
  [/lorem ipsum/i, 'lorem ipsum'],
  [/\[object Object\]/, '[object Object]'],
  [/"[A-Za-z_]+"\s*:/, 'a raw JSON key'],
];
const LEAK_TEXT = [
  [/(?:^|\s)(?:label|headline|subline|source|caption|topic|query|band|cta|hashtags|slides?|person|title|text|body)\s*:/i, 'a field label ("label:")'],
  [/<\/?[a-z_]+>/i, 'a placeholder tag'],
  [/\b[a-z]+_[a-z_]+\b/, 'a snake_case key'],
];

export function leakProblems(spec, { caption = '' } = {}) {
  const problems = [];
  const check = (where, text, rules) => {
    // @handles and #tags legitimately carry underscores.
    const t = String(text || '').replace(/[@#][\w.\u0900-\u097F]+/g, ' ');
    for (const [re, what] of rules) {
      if (re.test(t)) { problems.push(`${where} contains ${what}`); return; }
    }
  };
  (spec?.slides || []).forEach((slide, i) => {
    for (const field of ['headline', 'subline', 'callout']) {
      if (slide?.[field] == null) continue;
      check(`slide ${i + 1} ${field}`, slide[field], [...LEAK_ANY, ...LEAK_TEXT]);
    }
    if (slide?.source != null) check(`slide ${i + 1} source`, slide.source, LEAK_ANY);
  });
  if (caption) check('caption', caption, LEAK_ANY);
  return problems;
}

// ---------------------------------------------------------------- empty panels

const CONTENT = /[\p{L}\p{N}]/u;

export function emptyProblems(spec) {
  const problems = [];
  const seen = new Map();
  (spec?.slides || []).forEach((slide, i) => {
    if (!CONTENT.test(String(slide?.headline || ''))) problems.push(`slide ${i + 1} is an empty panel (no headline text)`);
    if (isFact(slide, i)) {
      const key = slideText(slide).replace(/\s+/g, ' ').trim().toLowerCase();
      if (key && seen.has(key)) problems.push(`slide ${i + 1} repeats slide ${seen.get(key) + 1} (padded panel)`);
      else if (key) seen.set(key, i);
    }
  });
  return problems;
}

/**
 * Repair: drop fact panels that are padding — a copy of another slide, or a
 * filler ("सेव करो") with no subline and no source. Never drops the cover or
 * the follow card, never goes below 3 slides.
 */
export function dropPaddedPanels(spec) {
  const slides = spec?.slides || [];
  const seen = new Set();
  const kept = [];
  let dropped = 0;
  slides.forEach((slide, i) => {
    const last = i === slides.length - 1;
    if (!isFact(slide, i) || last) { kept.push(slide); return; }
    const key = slideText(slide).replace(/\s+/g, ' ').trim().toLowerCase();
    const filler = !slide.subline && !String(slide.source || '').trim()
      && /^(सेव करो|फ़ॉलो करो|फॉलो करो|save|follow)/i.test(String(slide.headline || '').trim());
    const empty = !CONTENT.test(String(slide.headline || ''));
    if ((seen.has(key) || filler || empty) && slides.length - dropped > 3) { dropped += 1; return; }
    seen.add(key);
    kept.push(slide);
  });
  return { spec: { ...spec, slides: kept }, dropped };
}

// ---------------------------------------------------------------- layout

/** The rectangle text must stay inside, for a frame of this size. */
export function safeArea({ width, height, story = false, bottomInset = 0, inset = SAFE_INSET }) {
  const x = Math.max(inset, story ? 0 : GRID_CROP_3x4) * width;
  const top = story ? Math.max(STORY_SAFE_TOP, inset * height) : inset * height;
  const bottom = story ? Math.max(bottomInset - 10, inset * height) : inset * height;
  return { left: x, right: width - x, top, bottom: height - bottom };
}

/**
 * `measures` is what slide.html's __slide.measure() returns for one slide:
 * { boxes: [{ id, left, top, right, bottom, text }], clipped: [id...] }.
 */
export function layoutProblems(measures, { width, height, story = false, bottomInset = 0, inset = SAFE_INSET } = {}) {
  const area = safeArea({ width, height, story, bottomInset, inset });
  const problems = [];
  (measures || []).forEach((m, i) => {
    const n = i + 1;
    for (const box of m?.boxes || []) {
      const out = [];
      if (box.left < area.left - 0.5) out.push(`left ${Math.round(box.left)}px`);
      if (box.right > area.right + 0.5) out.push(`right ${Math.round(width - box.right)}px`);
      if (box.top < area.top - 0.5) out.push(`top ${Math.round(box.top)}px`);
      if (box.bottom > area.bottom + 0.5) out.push(`bottom ${Math.round(height - box.bottom)}px`);
      if (out.length) problems.push(`slide ${n} ${box.id} is outside the ${Math.round(inset * 100)}% safe area (${out.join(', ')} from the edge)`);
    }
    for (const id of m?.clipped || []) problems.push(`slide ${n} ${id} is cut off (text overflows its box)`);
    if (m && m.boxes && !m.boxes.some((b) => b.id === 'headline')) problems.push(`slide ${n} rendered no headline (empty panel)`);
  });
  return problems;
}

// ---------------------------------------------------------------- tiers

/** Fed back to the model inside the existing attempt loop. */
export function softQualityProblems(spec, { stories = null } = {}) {
  return [
    ...hindiProblems(spec, { min: HINDI_SOFT }),
    ...heavyWordProblems(spec),
    ...numberProblems(spec, { stories }),
    ...sourceProblems(spec, { stories }),
    ...leakProblems(spec, { caption: spec?.caption }),
    ...emptyProblems(spec),
  ];
}

/** Hard rules on the final spec + caption. Any hit blocks the publish. */
export function hardQualityProblems(spec, { stories = null, caption = '' } = {}) {
  return [
    ...hindiProblems(spec, { min: HINDI_HARD }),
    ...heavyWordProblems(spec, { caption }),
    ...numberProblems(spec, { stories, caption }),
    ...sourceProblems(spec, { stories, caption }),
    ...leakProblems(spec, { caption }),
    ...emptyProblems(spec),
  ];
}

export const UNCHECKED = [
  'finance calc inputs (e.g. an 8.5% rate) are the model\'s assumptions; the code computes every figure from them but does not check the rate against a bank\'s live card',
  'chart graphics are not measured for cut-off; only rendered text is measured',
];
