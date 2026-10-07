// Number sanitizer: runs on the generated spec BEFORE the gates.
//
// The model sometimes writes a figure the code never computed ("1%", "0.2%",
// a corpus of its own). Instead of refusing the whole build, every such figure
// is taken out of the text (or the sentence of the caption that carries it is
// dropped), and a finance chart that is not built on the worked example is
// redrawn from the worked example. Nothing is ever ADDED: what is left is a
// subset of what the gates accept. Slide count never changes. The hard number
// gate (quality.js) and the post gate still run on the result.

import { computeCalc } from './calc.js';
import { parseFigures, mismatches } from './figures.js';
import { FINANCE } from './categories.js';
import { exampleProblems, workedExample, LEVERS } from './example.js';
import {
  slideCalcs, calcLabels, storyNumbers, chartBackedBy, numbersIn, numberProblems,
} from './quality.js';

// Plain lines (no number) for a headline the sanitizer emptied. Several, so
// two repaired slides never read the same (a repeated panel is refused).
export const FINANCE_FILLERS = ['पूरा हिसाब chart में देखो', 'साल-दर-साल असर chart में', 'असली फ़र्क़ chart बताता है', 'Chart में पूरा असर देखो', 'हिसाब chart में साफ़ दिखता है'];
export const NEWS_FILLERS = ['पूरी खबर आसान भाषा में', 'इस खबर का मतलब समझो', 'खबर की बड़ी बात यही है', 'आगे इस पर नज़र रखो'];
export const FINANCE_FILLER = FINANCE_FILLERS[0];
export const NEWS_FILLER = NEWS_FILLERS[0];

const isFact = (slide, i) => i !== 0 && slide?.band !== 'center' && !slide?.cta;
const words = (text) => String(text || '').trim().split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Remove the written figures at `tokens` from `text` and tidy what is left. */
export function cutFigures(text, tokens) {
  let out = String(text ?? '');
  for (const t of [...tokens].sort((a, b) => b.start - a.start)) {
    out = `${out.slice(0, t.start)} ${out.slice(t.stop)}`;
  }
  return out
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+([,.;:!?।])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/(?:^|\s)(?:से|का|की|के|और|vs|बनाम|=|→|->|—|-|\+)\s*(?=$|[,.;:!?।])/gu, ' ')
    .replace(/^[\s,;:—\-–→=+]+|[\s,;:—\-–→=+]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function fieldFix(text, bad) {
  if (!bad.length) return { text, changed: false };
  return { text: cutFigures(text, bad), changed: true };
}

/** Variants of the worked example along its what-if lever (years), for redrawn charts. */
function exampleVariants(example) {
  const out = [example];
  const lever = (LEVERS[String(example?.type || '').toLowerCase()] || []).some((re) => re.test('years'));
  const Y = Number(example?.years);
  if (lever && Number.isFinite(Y)) {
    for (const y of [Y + 5, Y + 10, Y - 5]) if (y >= 1 && computeCalc({ ...example, years: y }).ok) out.push({ ...example, years: y });
  }
  return out;
}

const stripTags = (text) => String(text || '').replace(/[@#][\w.\u0900-\u097F]+/g, ' ');

/** Drop each caption sentence for which `isBad(sentence)` is true. */
export function sanitizeCaption(caption, isBad) {
  const src = String(caption || '');
  if (!src.trim()) return { caption: src, dropped: 0 };
  let dropped = 0;
  const lines = src.split('\n').map((ln) => ln.split(/(?<=[।.!?])\s+/).filter((p) => {
    if (isBad(stripTags(p))) { dropped += 1; return false; }
    return true;
  }).join(' '));
  return { caption: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

const textKey = (slide) => `${slide?.headline || ''} ${slide?.subline || ''}`.replace(/\s+/g, ' ').trim().toLowerCase();

function fixText(slides, badFor, fillers, actions, redrawn = new Set()) {
  const out = slides.map((slide, i) => {
    const h = fieldFix(slide.headline, badFor(i, slide.headline));
    const s = fieldFix(slide.subline, badFor(i, slide.subline));
    if (!h.changed && !s.changed) return slide;
    let headline = h.text;
    let subline = slide.subline == null ? null : s.text;
    if (s.changed && words(subline) < 2) subline = null;
    if (h.changed && words(headline) < 2) {
      if (subline && words(subline) >= 3 && !s.changed) { headline = subline; subline = null; } else headline = '';
    }
    // The chart under it was redrawn and its words described another chart:
    // what is left of a cut line is not kept, a plain line goes there instead.
    if (redrawn.has(i)) {
      if (h.changed) headline = '';
      if (s.changed) subline = null;
    }
    actions.push(`slide ${i + 1}: removed figure(s) the code did not compute (${[h.changed && 'headline', s.changed && 'subline'].filter(Boolean).join(' + ')})`);
    return { ...slide, headline, subline, repaired: true };
  });
  // An emptied headline, or a repaired slide that now reads like another
  // slide, gets the next unused plain line.
  const used = new Set();
  let f = 0;
  return out.map((slide, i) => {
    if (!slide.repaired) { used.add(textKey(slide)); return slide; }
    const { repaired, ...clean } = slide;
    let next = clean;
    while ((!String(next.headline || '').trim() || used.has(textKey(next)) || out.some((o, k) => k > i && !o.repaired && textKey(o) === textKey(next))) && f < fillers.length) {
      next = { ...clean, headline: fillers[f] };
      f += 1;
    }
    used.add(textKey(next));
    return next;
  });
}

function sanitizeFinance(spec, actions) {
  let slides = [...(spec.slides || [])];
  const redrawn = new Set();
  const ex = workedExample(spec);
  if (ex.ok) {
    // Charts first: a content slide whose calc is missing, invalid, off the
    // worked example, or a compare of uncomputed values is redrawn from it.
    const problems = exampleProblems(spec, { isContent: (i) => isFact(slides[i], i) });
    const variants = exampleVariants(spec.example);
    let next = 0;
    const redraw = (i, why) => {
      redrawn.add(i);
      const calc = { ...variants[next % variants.length], ...(slides[i]?.calc?.view ? { view: slides[i].calc.view } : {}) };
      next += 1;
      slides[i] = { ...slides[i], calc };
      actions.push(`slide ${i + 1}: chart redrawn from the worked example (${why})`);
    };
    slides.forEach((slide, i) => {
      if (!isFact(slide, i)) return;
      const calc = slide.calc ? computeCalc(slide.calc) : null;
      if (!calc?.ok) return redraw(i, calc ? 'invalid calc' : 'no calc');
      if (problems.some((p) => p.startsWith(`slide ${i + 1}:`))) return redraw(i, 'numbers not from the worked example');
      return undefined;
    });
    if (exampleProblems({ ...spec, slides }, { isContent: (i) => isFact(slides[i], i) }).some((p) => p.startsWith('no slide shows'))) {
      const first = slides.findIndex((s, i) => isFact(s, i));
      if (first >= 0) {
        slides[first] = { ...slides[first], calc: { ...spec.example, ...(slides[first]?.calc?.view ? { view: slides[first].calc.view } : {}) } };
        actions.push(`slide ${first + 1}: shows the worked example itself`);
      }
    }
  }
  const calcs = slideCalcs({ slides });
  const everything = calcs.filter((c) => c?.ok).flatMap((c) => c.all);
  const allLabels = calcs.filter((c) => c?.ok).flatMap(calcLabels);
  const badFor = (i, text) => {
    if (text == null) return [];
    const own = isFact(slides[i], i) && calcs[i]?.ok;
    return mismatches(text, own ? calcs[i].all : everything, { labels: own ? calcLabels(calcs[i]) : allLabels })
      .map((m) => m.token);
  };
  slides = fixText(slides, badFor, FINANCE_FILLERS, actions, redrawn);
  const { caption, dropped } = sanitizeCaption(spec.caption, (text) => mismatches(text, everything, { labels: allLabels }).length > 0);
  if (dropped) actions.push(`caption: dropped ${dropped} sentence(s) with figures the code did not compute`);
  return { ...spec, slides, caption: caption || String(spec.topic || '') };
}

function sanitizeSourced(spec, stories, actions) {
  const pool = storyNumbers(stories);
  let slides = (spec.slides || []).map((slide, i) => {
    if (!slide?.calc) return slide;
    const calc = computeCalc(slide.calc);
    if (calc.ok && chartBackedBy(calc, pool)) return slide;
    actions.push(`slide ${i + 1}: chart dropped — its numbers are not in the fetched items`);
    return { ...slide, calc: null };
  });
  const calcs = slideCalcs({ slides });
  const allowedFor = (i) => {
    const calc = calcs[i];
    if (!calc?.ok) return pool;
    return new Set([...pool, ...calc.figures.map((f) => f.text.replace(/[^\d.]/g, '')), ...calc.figures.map((f) => String(Math.round(f.value)))]);
  };
  const badFor = (i, text) => {
    if (text == null || !isFact(slides[i], i)) return [];
    const allowed = allowedFor(i);
    return parseFigures(text).filter((t) => numbersIn(t.digits).some((n) => !allowed.has(n)));
  };
  slides = fixText(slides, badFor, NEWS_FILLERS, actions);
  return { ...spec, slides };
}

/** { spec, actions } — `stories` given = AI/news (sourced) rules, else finance rules. */
export function sanitizeNumbers(spec, { stories = null } = {}) {
  const actions = [];
  if (!spec || !Array.isArray(spec.slides)) return { spec, actions };
  if (stories) return { spec: sanitizeSourced(spec, stories, actions), actions };
  if (FINANCE.includes(spec.category)) return { spec: sanitizeFinance(spec, actions), actions };
  return { spec, actions };
}

/** Number problems left on a spec (the same rules the hard gate uses). */
export function numbersLeft(spec, { stories = null } = {}) {
  return numberProblems(spec, { stories, caption: spec?.caption ?? null });
}

const redrew = (actions) => actions.filter((a) => /chart (redrawn|dropped)/.test(a)).length;

/**
 * Sanitize a generated carousel; if number problems remain, or charts had to be
 * redrawn, make exactly ONE more model call (`retry(feedback, example)`) and
 * keep whichever sanitized result is cleaner. Never more than one retry; a
 * failed retry keeps the first result. Returns { written, retried }.
 */
export async function settleNumbers(written, { sourced = false, retry = null, onNote = () => {} } = {}) {
  const pass = (w) => {
    const stories = sourced ? (w.stories || []) : null;
    const { spec, actions } = sanitizeNumbers(w.spec, { stories });
    return { written: { ...w, spec }, actions, left: numbersLeft(spec, { stories }) };
  };
  const first = pass(written);
  first.actions.forEach((a) => onNote(`numbers: ${a}`));
  if ((!first.left.length && !redrew(first.actions)) || !retry) return { written: first.written, retried: false };

  const feedback = first.left.length
    ? first.left
    : first.actions.filter((a) => /chart (redrawn|dropped)/.test(a)).map((a) => `${a} — build every chart on the worked example / fetched numbers`);
  onNote(`numbers: ${first.left.length ? `${first.left.length} problem(s) left after the sanitizer` : `${redrew(first.actions)} chart(s) redrawn`} — one retry`);
  let again;
  try {
    again = await retry(feedback, written.spec?.example || null);
  } catch (err) {
    onNote(`numbers: retry failed (${String(err.message).slice(0, 120)}) — keeping the first result`);
    return { written: first.written, retried: true };
  }
  if (!again || again.skipped || !again.spec) return { written: first.written, retried: true };
  const second = pass(again);
  second.actions.forEach((a) => onNote(`numbers (retry): ${a}`));
  const score = (r) => r.left.length * 100 + redrew(r.actions) * 10 + r.actions.length;
  const pick = score(second) <= score(first) ? second : first;
  onNote(`numbers: using the ${pick === second ? 'retry' : 'first'} result (${pick.left.length} problem(s) left)`);
  return { written: pick.written, retried: true };
}
