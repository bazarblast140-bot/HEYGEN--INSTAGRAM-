// Code-computed numbers handed to the model BEFORE it writes.
//
// 7 Oct midday (run 37588434602): the model wrote an expense-ratio carousel
// with its own "1%", "0.2%", 11% and 11.8% and its own corpus values; none was
// computed from the worked example and the build was refused. Now code picks
// the worked examples for the slot's category, computes every figure (and the
// what-if lever variants), and the prompt lists them as the ONLY numbers the
// text may use. The number gate (quality.js) and the post gate still check
// every figure afterwards.

import { computeCalc } from './calc.js';

/** Worked examples code offers per category. Rates are stated assumptions. */
export const PRESETS = {
  'mutual-funds': [
    { name: 'SIP', calc: { type: 'sip', monthly: 10000, rate: 12, years: 15 }, lever: { key: 'years', values: [10, 20, 25] } },
    { name: 'Lumpsum', calc: { type: 'lumpsum', amount: 100000, rate: 12, years: 20 }, lever: { key: 'years', values: [10, 15, 30] } },
    { name: 'Expense ratio (regular vs direct, lumpsum)', calc: { type: 'expense_ratio', amount: 100000, rate: 12, years: 20, expenses: [1, 0.2] }, lever: { key: 'years', values: [10, 30] } },
    { name: 'Expense ratio (regular vs direct, SIP)', calc: { type: 'expense_ratio', monthly: 10000, rate: 12, years: 20, expenses: [1.5, 0.5] }, lever: { key: 'years', values: [10, 30] } },
    { name: 'Inflation vs corpus', calc: { type: 'inflation', amount: 100000, rate: 6, years: 20 }, lever: { key: 'years', values: [10, 30] } },
  ],
};

const line = (calc) => calc.all.map((f) => `${f.label} ${f.text}`).join(' · ');

/** [{ name, calc, computed, variants:[{ calc, computed }] }] for a category (empty when none). */
export function presetsFor(category) {
  return (PRESETS[category] || []).map((p) => {
    const computed = computeCalc(p.calc);
    const variants = (p.lever?.values || []).map((v) => {
      const calc = { ...p.calc, [p.lever.key]: v };
      return { calc, computed: computeCalc(calc) };
    }).filter((v) => v.computed.ok);
    return { ...p, computed, variants };
  }).filter((p) => p.computed.ok);
}

/** The figures of one computed worked example, as text lines. */
export function figureLines(computed) {
  return computed?.ok ? line(computed) : '';
}

/**
 * Prompt block: the worked examples and every number code computed for them.
 * `example` (a calc) adds the model's own earlier example (retry), computed.
 */
export function numberSheetPrompt(category, { example = null } = {}) {
  const presets = presetsFor(category);
  const own = example ? computeCalc(example) : null;
  if (!presets.length && !own?.ok) return '';
  const blocks = presets.map((p, i) => [
    `${i + 1}. ${p.name}: "example": ${JSON.stringify(p.calc)}`,
    `   code के numbers: ${line(p.computed)}`,
    ...p.variants.map((v) => `   what-if ${p.lever.key} ${v.calc[p.lever.key]}: ${line(v.computed)}`),
  ].join('\n'));
  if (own?.ok) blocks.push(`पिछली कोशिश का example ${JSON.stringify(example)}: ${line(own)}`);
  return `\n\n<computed_numbers>
ये numbers code ने निकाले हैं. Slides, caption और calc में सिर्फ़ यही numbers लिखो — कोई और digit, percent या ₹ amount नहीं (अपना कोई rate, expense या return मत गढ़ो).
${presets.length ? 'इनमें से एक worked example चुनो और उसी पर पूरा carousel बनाओ; topic भी उसी example से मेल खाए:\n' : ''}${blocks.join('\n')}
जिस संख्या की ज़रूरत हो और वह ऊपर नहीं है, उसे शब्दों में कहो ("थोड़ा ज़्यादा", "लगभग दोगुना") या chart पर छोड़ दो.
</computed_numbers>`;
}
