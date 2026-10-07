// Read every figure a model wrote on a slide and check it against the code.
//
// "₹50 लाख लोन, 8.5% ब्याज ... कुल ब्याज लगभग ₹52 लाख" parses to
//   ₹5,000,000 · 8.5% · ₹5,200,000
// and each is compared with the slide's computed figures (calc.js) of the same
// kind: money with money, percent with percent. ₹52 लाख is 3.9% away from the
// ₹54.14 लाख the EMI formula gives, so the post is blocked. Rounding is fine:
// "₹54 लाख" is within half a lakh of 54.14 and within 1%.
//
// Handles Devanagari and Latin digits, Indian grouping (5,00,000), ₹ / Rs /
// रु / रुपये, लाख / lakh / L, करोड़ / crore / Cr, हज़ार / thousand / K,
// % / प्रतिशत / percent, साल / वर्ष / years, महीने / months.

const DEV_DIGITS = '०१२३४५६७८९';
export function latinDigits(text) {
  return String(text ?? '').replace(/[०-९]/g, (d) => String(DEV_DIGITS.indexOf(d)));
}

const MULT = [
  [/^(?:करोड़|करोड|crores?|cr)(?![\p{L}\p{M}])/iu, 1e7, 'INR'],
  [/^(?:लाख़?|lakhs?|lacs?|L)(?![\p{L}\p{M}])/u, 1e5, 'INR'],
  [/^(?:lakhs?|lacs?)(?![\p{L}\p{M}])/iu, 1e5, 'INR'],
  [/^(?:हज़ार|हजार|thousand|k|K)(?![\p{L}\p{M}])/u, 1e3, 'INR'],
];
const UNIT_AFTER = [
  [/^(?:%|प्रतिशत|percent|per cent)/iu, 'PCT'],
  [/^(?:रुपये|रुपए|रुपया|rupees?|rs\.?)(?![\p{L}\p{M}])/iu, 'INR'],
  [/^(?:साल|वर्ष|years?|yrs?|y)(?![\p{L}\p{M}])/iu, 'YEARS'],
  [/^(?:महीने|महीनों|महीना|माह|months?|mo)(?![\p{L}\p{M}])/iu, 'MONTHS'],
  [/^(?:x|गुना)(?![\p{L}\p{M}])/iu, 'MULTIPLE'],
];
const CURRENCY_BEFORE = /(?:₹|rs\.?|inr|रु\.?)\s*$/iu;
const INDEX_BEFORE = /(?:nifty|sensex|निफ्टी|सेंसेक्स|bank\s*nifty)\s*$/iu;
const NUMBER = /(?<![\p{L}\p{M}\d.])\d+(?:,\d+)*(?:\.\d+)?/gu;

/**
 * [{ raw, value, kind: 'INR'|'PCT'|'YEARS'|'MONTHS'|'MULTIPLE'|'NUM', step }]
 * `step` is the precision as written, in the same base unit as value
 * (₹54 लाख → step 1e5, ₹54.1 लाख → 1e4, 8.5% → 0.1).
 */
export function parseFigures(text) {
  const t = latinDigits(text);
  const out = [];
  for (const m of t.matchAll(NUMBER)) {
    const digits = m[0].replace(/,/g, '');
    let value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const decimals = (digits.split('.')[1] || '').length;
    let step = 10 ** -decimals;
    const before = t.slice(Math.max(0, m.index - 12), m.index);
    let rest = t.slice(m.index + m[0].length);
    const ws = rest.match(/^\s*/)[0];
    let tail = rest.slice(ws.length);
    let kind = CURRENCY_BEFORE.test(before) ? 'INR' : 'NUM';
    let end = m.index + m[0].length;
    for (const [re, mult] of MULT) {
      const hit = tail.match(re);
      // a bare "L"/"k" must touch the number ("50L"), words may be spaced
      if (hit && (ws === '' || hit[0].length > 1)) {
        value *= mult; step *= mult; kind = 'INR';
        end += ws.length + hit[0].length;
        rest = t.slice(end); tail = rest.replace(/^\s*/, '');
        break;
      }
    }
    let unitEnd = end;
    for (const [re, k] of UNIT_AFTER) {
      const hit = tail.match(re);
      if (!hit) continue;
      if (k === 'INR') kind = 'INR';
      else if (kind === 'NUM') kind = k;
      unitEnd = end + (rest.length - tail.length) + hit[0].length;
      break;
    }
    if (kind === 'NUM' && INDEX_BEFORE.test(before)) kind = 'INDEX';
    const currency = before.match(CURRENCY_BEFORE);
    const lead = currency ? '₹' : '';
    // start/stop: the whole written figure ("₹1.2 लाख", "11.8%", "20 साल"),
    // for the sanitizer that removes a figure the code did not compute.
    // latinDigits() keeps string length, so these index the original text.
    const start = currency ? m.index - currency[0].length : m.index;
    out.push({ raw: `${lead}${t.slice(m.index, end)}`, value, kind, step, digits: digits.replace(/\.0+$/, ''), start, stop: unitEnd });
  }
  return out;
}

export const TOLERANCE = 0.01;      // beyond rounding, 1% is a wrong number
export const ROUNDING_CAP = 0.025;  // "₹54 लाख" for 54.14 is rounding; "₹1 करोड़" for 1.04 is not

const UNIT_OF = { '₹': 'INR', '%': 'PCT', years: 'YEARS', months: 'MONTHS', '': 'NUM' };

function close(token, value) {
  // The sign is said in words ("40% कम", "₹20 पीछे"), so magnitudes are compared.
  value = Math.abs(value);
  const diff = Math.abs(token.value - value);
  const base = Math.max(Math.abs(value), 1e-9);
  if (diff / base <= TOLERANCE) return true;
  return diff <= token.step / 2 + 1e-9 && diff / base <= ROUNDING_CAP;
}

function compatible(token, figure) {
  const unit = UNIT_OF[figure.unit] ?? 'NUM';
  if (token.kind === 'INR') return unit === 'INR';
  if (token.kind === 'PCT') return unit === 'PCT';
  if (token.kind === 'YEARS') return unit === 'YEARS' || (unit === 'MONTHS' && false);
  if (token.kind === 'MONTHS') return unit === 'MONTHS';
  if (token.kind === 'MULTIPLE') return unit === 'NUM';
  return true; // a bare number may be any figure
}

/** Numbers that are not claims: a year, a small count ("3 गलतियाँ"), an index name. */
export function harmless(token) {
  if (token.kind === 'INDEX') return true;
  if (token.kind !== 'NUM') return false;
  if (Number.isInteger(token.value) && token.value >= 1900 && token.value <= 2100) return true;
  return Number.isInteger(token.value) && token.value >= 0 && token.value <= 10;
}

/**
 * Every figure in `text` must equal (within rounding) one of `figures`
 * ({ value, unit, text }). Returns [{ token, nearest }] for the ones that don't.
 */
export function mismatches(text, figures = [], { labels = [] } = {}) {
  const bad = [];
  // Numbers inside the calc's own category labels ("Year 3", "15 yrs") are
  // names of bars, not claims.
  const named = new Set(labels.flatMap((l) => parseFigures(l).map((t) => t.value)));
  for (const token of parseFigures(text)) {
    if (harmless(token)) continue;
    if (['NUM', 'YEARS', 'MONTHS'].includes(token.kind) && named.has(token.value)) continue;
    const pool = figures.filter((f) => compatible(token, f));
    if (pool.some((f) => close(token, f.value))) continue;
    const nearest = pool.slice().sort((a, b) => Math.abs(a.value - token.value) - Math.abs(b.value - token.value))[0] || null;
    bad.push({ token, nearest });
  }
  return bad;
}

export function describe({ token, nearest }) {
  const shown = token.kind === 'PCT' ? `${token.raw}%` : token.raw;
  if (nearest) {
    const off = Math.abs(token.value - nearest.value) / Math.max(Math.abs(nearest.value), 1e-9);
    return `"${shown}" does not match any computed figure (closest: ${nearest.label || nearest.key} ${nearest.text}, ${(off * 100).toFixed(1)}% off) — use the figure the code computes`;
  }
  return `"${shown}" is not a computed figure or a calc input`;
}
