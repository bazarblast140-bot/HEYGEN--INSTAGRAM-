// Turn a carousel spec into v3 chart-board slides.
//
// Every content slide's chart, figure strip and footnote are written here from
// calc.js output, never from model text. Finance footnotes are the calculation
// note (literally true); AI/news footnotes are the fetched outlet and date.
// There is no photograph anywhere in this path.

import { computeCalc, figureStrip } from './calc.js';
import { FINANCE } from './categories.js';

export const HANDLE = '@rajesh_technical_trader';

const KICKERS = {
  fundamentals: 'Fundamentals', options: 'Options', intraday: 'Intraday', stocks: 'Stocks',
  'market-history': 'Market history', 'personal-finance': 'Personal finance', business: 'Business',
  'risk-management': 'Risk management', 'ai-news': 'AI update', 'latest-news': 'Market news',
};

export function kickerFor(category) {
  return KICKERS[category] || 'Finance';
}

/**
 * Adds { chart, figures, footnote, kicker, page, handle, progress } to each
 * slide. Finance slides lose any model-written source; the cover borrows the
 * first content slide's chart so the hook is a picture of the answer.
 */
export function boardSlides(spec) {
  const slides = spec?.slides || [];
  const finance = FINANCE.includes(spec?.category);
  const total = slides.length;
  const calcs = slides.map((s) => (s?.calc ? computeCalc(s.calc) : null));
  const hero = calcs.find((c, i) => i > 0 && c?.ok) || null;
  return slides.map((slide, i) => {
    const calc = calcs[i];
    const cover = i === 0 || slide.band === 'center';
    const base = {
      ...slide,
      kicker: kickerFor(spec?.category),
      page: `${i + 1}/${total}`,
      handle: HANDLE,
      progress: (i + 1) / total,
      background: null,
      insets: [],
    };
    if (slide.cta) return { ...base, chart: null, figures: [], footnote: '', source: null };
    if (cover) {
      return { ...base, chart: hero?.chart || null, figures: hero ? figureStrip(hero) : [], footnote: '', source: null };
    }
    if (finance) {
      return {
        ...base,
        chart: calc?.ok ? calc.chart : null,
        figures: calc?.ok ? figureStrip(calc) : [],
        source: calc?.ok ? calc.note : null,
        footnote: calc?.ok ? calc.note : '',
      };
    }
    const source = String(slide.source || '').trim();
    return {
      ...base,
      chart: calc?.ok ? calc.chart : null,
      figures: calc?.ok ? figureStrip(calc) : [],
      footnote: source ? `Source: ${source}` : '',
    };
  });
}
