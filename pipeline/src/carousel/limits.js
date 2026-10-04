// Fixed character limits per slide field, so text from the daily news issue
// fits the v3 chart-board without anyone shortening it by hand.
//
// Measured against the renderer's 6% safe area (950 px of usable width on a
// 1080x1350 slide) at the v3 sizes in scenes/board.html, before the 0.86
// "tight" re-render: every limit below renders inside the safe area at the
// normal sizes with Devanagari + Roman text (test/slide-limits.test.js has the
// table; scripts/measure-limits is the render check).
//   cover / CTA headline   104→64 px, 3 lines  → 56 chars
//   text-board headline     88→54 px, 3 lines  → 60 chars
//   chart-slide headline    70→46 px, 2 lines  → 48 chars
//   subline                 50/42→30 px, 2 lines → 90 chars
//   source / footnote       23 px, 1–2 lines   → 60 chars
//   chart label             26 px axis (2 lines) and the 24 px figure strip (1 line, clipped) → 16 chars
//   caption (body, before hashtags and the brand line; Instagram max 2200) → 1800 chars
//
// Enforcement (enforceLimits): over the limit → the model is asked ONCE to
// shorten only those fields; still over → trimmed at a word boundary when that
// is safe (the cut tail has no number, the kept text keeps most of it, no word
// is split); otherwise a hard problem and the slot is skipped.

export const LIMITS = Object.freeze({
  coverHeadline: 56,
  textHeadline: 60,
  chartHeadline: 48,
  subline: 90,
  source: 60,
  chartLabel: 16,
  caption: 1800,
});

const len = (s) => [...String(s ?? '')].length; // code points, not UTF-16 units

/** Which headline limit applies to slide i of n. */
export function headlineLimit(slide, i, n) {
  if (i === 0 || slide?.band === 'center' || slide?.cta || i === n - 1) return LIMITS.coverHeadline;
  return slide?.calc ? LIMITS.chartHeadline : LIMITS.textHeadline;
}

function labelPaths(calc) {
  if (!calc || typeof calc !== 'object') return [];
  const out = [];
  for (const k of ['fromLabel', 'toLabel']) if (typeof calc[k] === 'string') out.push([k]);
  (calc.items || []).forEach((it, j) => { if (typeof it?.label === 'string') out.push(['items', j, 'label']); });
  (calc.labels || []).forEach((l, j) => { if (typeof l === 'string') out.push(['labels', j]); });
  return out;
}

const getIn = (o, p) => p.reduce((a, k) => (a == null ? a : a[k]), o);
function setIn(o, p, v) {
  if (!p.length) return v;
  const [k, ...rest] = p;
  const copy = Array.isArray(o) ? [...o] : { ...o };
  copy[k] = setIn(o?.[k], rest, v);
  return copy;
}

/** Every field over its limit: [{ path, label, limit, length, text }]. */
export function overLimits(spec) {
  const slides = spec?.slides || [];
  const out = [];
  const check = (path, label, limit) => {
    const text = getIn(spec, path);
    if (typeof text === 'string' && len(text) > limit) out.push({ path, label, limit, length: len(text), text });
  };
  slides.forEach((s, i) => {
    check(['slides', i, 'headline'], `slide ${i + 1} headline`, headlineLimit(s, i, slides.length));
    check(['slides', i, 'subline'], `slide ${i + 1} subline`, LIMITS.subline);
    check(['slides', i, 'source'], `slide ${i + 1} source`, LIMITS.source);
    check(['slides', i, 'footnote'], `slide ${i + 1} footnote`, LIMITS.source);
    for (const p of labelPaths(s.calc)) check(['slides', i, 'calc', ...p], `slide ${i + 1} chart label`, LIMITS.chartLabel);
  });
  check(['caption'], 'caption', LIMITS.caption);
  return out;
}

const NUMBERISH = /[\d०-९₹%$]/;
const TRAIL = /[\s,;:–—\-/(|]+$/u;

/**
 * Cut at the last word boundary that fits, or null when that is not safe:
 * no number may be cut (the dropped tail has no digit, ₹ or %), at least 60%
 * of the limit is kept, and the cut is only ever at whitespace — a word,
 * Devanagari or Roman, is never split.
 */
export function trimAtWord(text, limit) {
  const chars = [...String(text ?? '')];
  if (chars.length <= limit) return String(text ?? '');
  let cut = -1;
  for (let i = Math.min(limit, chars.length - 1); i > 0; i -= 1) {
    if (/\s/.test(chars[i])) { cut = i; break; }
  }
  if (cut <= 0) return null;
  const kept = chars.slice(0, cut).join('').replace(TRAIL, '');
  const dropped = chars.slice(cut).join('');
  if (NUMBERISH.test(dropped)) return null;
  if (len(kept) < Math.ceil(limit * 0.6)) return null;
  if (/\(|\[/.test(kept) && !/\)|\]/.test(kept.slice(kept.lastIndexOf('(')))) return null; // no dangling bracket
  return kept;
}

/** The one shorten request: only the fields that are over, nothing else. */
export function shortenPrompt(over) {
  return `कुछ fields slide पर fit नहीं होते. सिर्फ़ इन्हीं को छोटा करो, मतलब और हर number वैसा ही रखो, Simple Hinglish में, कोई नई बात या संख्या मत जोड़ो:
${over.map((o, k) => `${k + 1}. ${o.label} — ज़्यादा से ज़्यादा ${o.limit} characters (अभी ${o.length}): "${o.text}"`).join('\n')}
सिर्फ़ यह JSON भेजो: {"fields":[{"n":1,"text":"छोटा text"}, ...]}`;
}

/**
 * Bring every field inside its limit.
 * shorten(prompt) → { fields:[{n,text}] } is the single model call (optional).
 * Returns { spec, actions, problems } — problems non-empty means skip the slot.
 */
export async function enforceLimits(spec, { shorten = null } = {}) {
  let out = spec;
  const actions = [];
  let over = overLimits(out);
  if (!over.length) return { spec: out, actions, problems: [] };

  if (shorten) {
    try {
      const reply = await shorten(shortenPrompt(over));
      for (const f of reply?.fields || []) {
        const o = over[Number(f?.n) - 1];
        if (!o || typeof f.text !== 'string' || !f.text.trim()) continue;
        out = setIn(out, o.path, f.text.trim());
        actions.push(`shortened ${o.label} (${o.length}→${len(f.text.trim())})`);
      }
    } catch (err) {
      actions.push(`shorten request failed: ${String(err.message).slice(0, 80)}`);
    }
    over = overLimits(out);
  }

  const problems = [];
  for (const o of over) {
    const t = trimAtWord(o.text, o.limit);
    if (t == null) {
      problems.push(`${o.label} is ${o.length} characters (limit ${o.limit}) and cannot be trimmed safely`);
    } else {
      out = setIn(out, o.path, t);
      actions.push(`trimmed ${o.label} at a word boundary (${o.length}→${len(t)})`);
    }
  }
  return { spec: out, actions, problems };
}

/** Prompt lines with the limits (the model sees the same numbers code enforces). */
export function limitsPrompt() {
  return `Character limits (code इन्हें check करता है; ज़्यादा हुआ तो slide skip हो सकती है):
- cover और आख़िरी slide headline ≤ ${LIMITS.coverHeadline} characters; chart वाली slide headline ≤ ${LIMITS.chartHeadline}; बिना chart वाली ≤ ${LIMITS.textHeadline}
- subline ≤ ${LIMITS.subline}; source ≤ ${LIMITS.source}; chart label (fromLabel/toLabel/items.label) ≤ ${LIMITS.chartLabel}
- caption ≤ ${LIMITS.caption} characters (hashtags अलग)`;
}
