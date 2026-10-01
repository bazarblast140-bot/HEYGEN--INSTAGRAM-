// What is allowed onto @rajesh_technical_trader.
//
// The checked-in planets carousel used to render whenever a run fell outside
// the posting windows. It is not a finance post, and a fallback must not be
// able to reach the feed by accident.

import { FINANCE } from '../carousel/categories.js';
import { flagOn, ENABLE_AI_NEWS_CAROUSELS } from './flags.js';

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

const SOURCED = new Set(['ai-news', 'latest-news']);
const DATED = /\b(19|20)\d{2}(?:-\d{2}-\d{2})?\b/;

export function hasDatedCitation(spec = {}) {
  const blob = [spec.caption, ...(spec.slides || []).map((slide) => slide.source)].filter(Boolean).join('\n');
  return DATED.test(blob);
}

/**
 * Fresh finance generation may publish.
 * A checked-in finance spec may publish only when it is marked reviewed and
 * the caller passes the explicit review flag. Anything else is refused.
 *
 * AI and news may publish only when the flag is on and the build attached a
 * verified source from the last 48 hours. Planets, FACTVIZER, and a sourceless
 * draft stay blocked even then.
 */
export function publishDecision({
  generated = false,
  reviewed = false,
  fallback = false,
  category = '',
  spec = {},
  allowReviewed = false,
  verifiedSource = false,
  sourceFresh = false,
  aiNewsEnabled = flagOn(ENABLE_AI_NEWS_CAROUSELS),
} = {}) {
  const niche = offNicheReasons(spec);
  if (niche.length) return { ok: false, reasons: niche };

  const finance = FINANCE.includes(category);
  if (generated && finance && !fallback) return { ok: true, reasons: [] };
  if (allowReviewed && reviewed && fallback && finance) return { ok: true, reasons: [] };

  if (SOURCED.has(category)) {
    const cited = hasDatedCitation(spec);
    if (generated && !fallback && aiNewsEnabled && verifiedSource && sourceFresh && cited) {
      return { ok: true, reasons: [] };
    }
    const reasons = [];
    if (!aiNewsEnabled) reasons.push('AI and news carousels are disabled');
    if (!generated || fallback) reasons.push('checked-in or fallback content is not publishable');
    if (!verifiedSource || !sourceFresh || !cited) reasons.push('sourced carousel needs a verified fresh source');
    return { ok: false, reasons };
  }

  const reasons = [];
  if (!generated) reasons.push('checked-in or fallback content is not publishable');
  if (!finance) reasons.push('not a finance carousel');
  if (fallback && !reviewed) reasons.push('fallback is not marked reviewed');
  if (fallback && reviewed && !allowReviewed) reasons.push('reviewed fallback needs an explicit publish flag');
  return { ok: false, reasons: [...new Set(reasons)] };
}
