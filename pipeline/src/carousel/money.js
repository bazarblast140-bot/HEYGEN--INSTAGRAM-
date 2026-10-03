// Sources on the money slots.
//
// Until PR #22 a money slide had to carry a dated source line ("RBI, साप्ताहिक
// सांख्यिकीय पूरक, सितंबर 2025"). That rule rewarded the wrong thing: the live
// SBI EMI post carried "SBI होम लोन EMI कैलकुलेटर 2025" under a figure nobody
// had fetched from SBI, and its maths was wrong. A dated label made an
// invented figure look checked.
//
// Finance carousels are calculations now. The code computes every figure
// (calc.js) and the slide shows what is literally true — "Calculation: standard
// EMI formula" — and nothing else. Any other source label on a finance slide is
// a label nothing in the pipeline verified, and is refused (quality.js
// sourceProblems). Only the AI/news slots, which fetch real items with a URL
// and publisher, may cite an outlet.

import { FINANCE } from './categories.js';
import { sourceProblems } from './quality.js';

export function isMoney(category) {
  return FINANCE.includes(category);
}

/** Unverified source labels on a money spec (empty for non-money specs). */
export function checkMoneySources(spec) {
  if (!isMoney(spec?.category)) return [];
  return sourceProblems(spec);
}
