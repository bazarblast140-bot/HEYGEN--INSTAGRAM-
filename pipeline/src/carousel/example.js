// One worked example per finance carousel.
//
// The 3 Oct evening preview (operating leverage) contradicted itself: slide 2
// said sales +20% → profit +50% (leverage 2.5), slide 3 said 40/10 = 4x,
// slide 5 charted "fixed 30, variable 20, leverage 3" with no sales at all, and
// slide 9 compared 15% with 50% — every one a "compare" of the model's own
// numbers. Now the model names ONE example (spec.example, e.g. sales 100,
// variable cost 60, fixed cost 30); code computes it (contribution 40, EBIT 10,
// leverage 4x), and every slide must be built on it:
//   - a slide's calc inputs must be example inputs or figures computed from the
//     example, except the one "what-if" lever its type allows (e.g. the sales
//     change % for operating leverage) — whose result code computes;
//   - a "compare" chart may only line up values code computed (from the example
//     or from another slide's calc), never free numbers;
//   - at least one slide shows the example itself.
// The slide text is then checked against its calc (financeNumberProblems), so
// text, chart and example all agree.

import { computeCalc } from './calc.js';

/** Inputs a slide may change from the example — the what-if lever; code computes the result. */
export const LEVERS = {
  operating_leverage: [/^salesChangePct$/],
  emi_compare: [/^years\d+$/],
  sip: [/^years$/],
  lumpsum: [/^years$/],
  inflation: [/^years$/],
  drawdown: [/^loss\d+$/],
};

const same = (a, b) => Math.abs(a - b) <= Math.max(1e-6, Math.abs(b) * 0.005);
const has = (pool, v) => pool.some((p) => same(v, p));
const isLever = (type, key) => (LEVERS[type] || []).some((re) => re.test(key));
const fmt = (v) => String(Number(Number(v).toFixed(2)));

/** Computed worked example of a finance spec, or { ok:false, error }. */
export function workedExample(spec) {
  const ex = spec?.example;
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return { ok: false, error: 'no worked example' };
  if (String(ex.type || '').toLowerCase() === 'compare') return { ok: false, error: 'the worked example cannot be a "compare" — give real inputs (e.g. operating_leverage sales/variableCost/fixedCost)' };
  return computeCalc(ex);
}

/**
 * Problems that make a finance carousel internally inconsistent. `isContent(i)`
 * says whether slide i is a content slide (cover and follow card are skipped).
 */
export function exampleProblems(spec, { isContent = (i, n) => i > 0 && i < n - 1 } = {}) {
  const slides = spec?.slides || [];
  const example = workedExample(spec);
  if (!example.ok) {
    return [`${example.error === 'no worked example' ? 'no worked example' : `worked example is invalid: ${example.error}`} — give ONE "example" for the whole carousel (e.g. {"type":"operating_leverage","sales":100,"variableCost":60,"fixedCost":30,"salesChangePct":10}); every slide's calc must use its numbers`];
  }
  const base = example.all.map((f) => f.value);
  const problems = [];
  const calcs = slides.map((s) => (s?.calc ? computeCalc(s.calc) : null));
  // Values code computed from the example: the example itself, plus every
  // non-compare slide calc that is built on it.
  const computed = [...base];
  const consistent = calcs.map((calc, i) => {
    if (!calc?.ok || calc.type === 'compare' || !isContent(i, slides.length)) return false;
    const off = calc.inputs.filter((f) => !isLever(calc.type, f.key) && !has(base, f.value));
    off.forEach((f) => problems.push(`slide ${i + 1}: ${f.label} ${fmt(f.value)} is not in the worked example (${example.inputs.map((x) => `${x.label} ${fmt(x.value)}`).join(', ')}) — use the example's numbers; only the what-if lever may change`));
    if (!off.length) computed.push(...calc.all.map((f) => f.value));
    return !off.length;
  });
  calcs.forEach((calc, i) => {
    if (!calc?.ok || calc.type !== 'compare' || !isContent(i, slides.length)) return;
    calc.inputs.filter((f) => !has(computed, f.value)).forEach((f) => problems.push(
      `slide ${i + 1}: compare value "${f.label}" ${fmt(f.value)} is not computed from the worked example — a finance compare may only show numbers code computed; use the matching calc type instead`,
    ));
  });
  const shown = calcs.some((calc, i) => consistent[i] && calc.type === example.type
    && example.inputs.filter((f) => !isLever(example.type, f.key)).every((f) => calc.inputs.some((g) => g.key === f.key && same(g.value, f.value))));
  if (!shown) problems.push(`no slide shows the worked example itself — put {"type":"${example.type}", ...same inputs} on slide 2`);
  return problems;
}
