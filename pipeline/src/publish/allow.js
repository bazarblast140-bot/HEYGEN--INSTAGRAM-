// What is allowed onto @rajesh_technical_trader.
//
// The checked-in planets carousel used to render whenever a run fell outside
// the posting windows. It is not a finance post, and a fallback must not be
// able to reach the feed by accident.

import { FINANCE } from '../carousel/categories.js';

export const ACCOUNT_BRAND = 'Rajesh Technical Traders';

const FILLER = /रोज़ एक नया तथ्य/;

export function offNicheReasons(spec = {}) {
  const slides = spec.slides || [];
  const blob = [
    spec.brand,
    spec.topic,
    spec.caption,
    ...slides.flatMap((s) => [s.headline, s.subline, s.query, s.source]),
  ].filter(Boolean).join('\n');
  const reasons = [];
  if (/FACTVIZER/i.test(blob)) reasons.push('brand or copy still says FACTVIZER');
  if (/ग्रहों|शुक्र|बृहस्पति|milky way|planetary fact|planet facts/i.test(blob)) {
    reasons.push('topic is not finance');
  }
  const filler = slides.filter((s) => FILLER.test(String(s.headline || ''))).length;
  if (filler > 1) reasons.push('filler slides');
  return reasons;
}

/**
 * Fresh finance generation may publish.
 * A checked-in finance spec may publish only when it is marked reviewed and
 * the caller passes the explicit review flag. Anything else is refused.
 */
export function publishDecision({
  generated = false,
  reviewed = false,
  fallback = false,
  category = '',
  spec = {},
  allowReviewed = false,
} = {}) {
  const niche = offNicheReasons(spec);
  const finance = FINANCE.includes(category) && niche.length === 0;
  if (generated && finance && !fallback) return { ok: true, reasons: [] };
  if (allowReviewed && reviewed && fallback && finance) return { ok: true, reasons: [] };

  const reasons = [...niche];
  if (!generated) reasons.push('checked-in or fallback content is not publishable');
  if (!finance) reasons.push('not a finance carousel');
  if (fallback && !reviewed) reasons.push('fallback is not marked reviewed');
  if (fallback && reviewed && !allowReviewed) reasons.push('reviewed fallback needs an explicit publish flag');
  return { ok: false, reasons: [...new Set(reasons)] };
}
