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
//   Numbers    — every number-bearing fact slide must carry a real source line
//                (not the generic filler normalizeSpec writes). For AI/news
//                slots, every number must also appear in the fetched feed items.
//                Finance slots have no fetched data to compare against, so for
//                them only the "has a real, dated source line" part is checked.
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

const YEAR = /\b(19|20)\d{2}\b/;

function slideText(slide) {
  return [slide?.headline, slide?.subline].filter(Boolean).join(' ');
}

const isFact = (slide, i) => i !== 0 && slide?.band !== 'center' && !slide?.cta;

// ---------------------------------------------------------------- Hindi

export function scriptCounts(text) {
  const t = String(text || '')
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
    problems.push(`slide text is ${Math.round(share * 100)}% Devanagari — write it in Hindi (Devanagari); only tickers/abbreviations like NIFTY, EPS and numbers may stay in English`);
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

function realSource(source) {
  const s = String(source || '').trim();
  return Boolean(s) && s !== FILLER_SOURCE;
}

/**
 * Hard part: a fact slide that states a number names a real source line.
 * Soft part: that source carries a year, and a number on the cover reappears on
 * a sourced slide (a hook number nobody sources is the easiest one to invent).
 * With fetched items (AI/news slots), every slide number must be in them.
 */
export function numberProblems(spec, { stories = null, soft = true } = {}) {
  const problems = [];
  const slides = spec?.slides || [];
  const pool = stories
    ? new Set(stories.flatMap((s) => [...numbersIn(s.title), ...numbersIn(s.date), ...numbersIn(s.summary)]))
    : null;
  slides.forEach((slide, i) => {
    const nums = numbersIn(slideText(slide));
    if (!nums.length || !isFact(slide, i)) return;
    if (!realSource(slide.source)) {
      problems.push(`slide ${i + 1} states ${nums.join(', ')} without a real source line`);
    } else if (soft && !pool && !YEAR.test(String(slide.source))) {
      problems.push(`slide ${i + 1} states ${nums.join(', ')} but its source "${slide.source}" has no year`);
    }
    if (pool) {
      const missing = nums.filter((n) => !pool.has(n));
      if (missing.length) problems.push(`slide ${i + 1} has number(s) ${missing.join(', ')} that are not in the fetched source items — use only numbers from the source`);
    }
  });
  if (soft && slides[0]) {
    const sourced = new Set(slides.flatMap((s, i) => (isFact(s, i) && realSource(s.source) ? numbersIn(slideText(s)) : [])));
    const loose = numbersIn(slideText(slides[0])).filter((n) => !sourced.has(n) && !(pool && pool.has(n)));
    if (loose.length) problems.push(`cover number(s) ${loose.join(', ')} do not appear on any sourced slide`);
  }
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
    ...numberProblems(spec, { stories, soft: true }),
    ...leakProblems(spec, { caption: spec?.caption }),
    ...emptyProblems(spec),
  ];
}

/** Hard rules on the final spec + caption. Any hit blocks the publish. */
export function hardQualityProblems(spec, { stories = null, caption = '' } = {}) {
  return [
    ...hindiProblems(spec, { min: HINDI_HARD }),
    ...numberProblems(spec, { stories, soft: false }),
    ...leakProblems(spec, { caption }),
    ...emptyProblems(spec),
  ];
}

export const UNCHECKED = [
  'finance-slot numbers are not compared with data (there is no fetched data for them); only a real, dated source line is required',
  'pictures are not checked for cut-off; only rendered text is measured',
];
