// One extra rule for the money slots, and only for them.
//
// The evening post cites RBI, SEBI, NSE and the World Bank. That is what makes
// it worth reading, and it is also what makes it dangerous: an invented figure
// with "स्रोत: RBI" under it is more convincing than the same figure with no
// source at all. The model cannot be stopped from being wrong, but it can be
// stopped from being vague, and vagueness is where invention hides — "RBI" and
// "ऐतिहासिक आँकड़े" name no document anyone could check, while "RBI, साप्ताहिक
// सांख्यिकीय पूरक, सितंबर 2025" names one.
//
// So a money slide's source must carry a year. It is a weak test and it is
// honestly all a word check can do here: it does not know whether 880 tonnes of
// gold is the right number. What it does is make the model reach for a real
// publication instead of a label, and a source with a date is a source a reader
// can go and check.
//
// ADVISORY, like every other check in softProblems. A missing year is a reason
// to ask for a better draft while attempts remain; it is never a reason for the
// account to go a day without a post.

import { FINANCE } from './categories.js';

const YEAR = /\b(19|20)\d{2}\b/;

export function isMoney(category) {
  return FINANCE.includes(category);
}

export function checkMoneySources(spec) {
  if (!isMoney(spec?.category)) return [];

  const problems = [];
  const slides = spec.slides || [];

  slides.forEach((slide, i) => {
    const n = i + 1;
    if (slide.band === 'center' || slide.cta) return;   // cover and follow card cite nothing
    if (!slide.subline) return;                          // no claim, nothing to source
    if (!slide.source) return;                           // already caught as a hard problem
    if (!YEAR.test(slide.source)) {
      problems.push(`slide ${n} cites "${slide.source}" with no year — name the report and its date, e.g. "RBI, साप्ताहिक सांख्यिकीय पूरक, सितंबर 2025"`);
    }
  });

  return problems;
}
