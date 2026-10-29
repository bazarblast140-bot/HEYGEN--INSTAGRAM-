// News-slide explainer (Rajesh, 29 Oct 2026): every real-article slide carries 1-2 short,
// simple spoken-Hindi lines ABOVE the screenshot — what the news is, and what it means
// for the viewer, e.g. "SBI Card 1 Dec se 1% fee lega." / "Matlab rent/wallet payment mehenga hoga."
// The lines come from the model pick (field "explain"); anything missing, too long or
// carrying a number that is not in the article falls back to a deterministic line built
// from the headline. This never throws and never blocks a post.
export const EXPLAIN_MAX = 70; // chars per line
const NUM = /\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
function trim(t, max = EXPLAIN_MAX) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1); const at = cut.lastIndexOf(' ');
  return `${(at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:–-]+$/, '')}…`;
}
const MEANS = {
  Market: 'Matlab: aapke portfolio par aaj iska asar dikh sakta hai.',
  Stocks: 'Matlab: is share ke investors ke liye yeh zaroori khabar hai.',
  'Mutual Funds': 'Matlab: aapke mutual fund/SIP par iska asar pad sakta hai.',
  Finance: 'Matlab: aapke paise aur kharche par iska asar pad sakta hai.',
};
/** Deterministic 2 lines from the headline (or title) + kind. */
export function fallbackExplain(A = {}) {
  const head = clean(A.title || A.headline || '');
  const l1 = head ? trim(`Khabar: ${head.replace(/[.…]+$/, '')}.`) : '';
  return [l1, MEANS[A.kicker] || MEANS.Finance].filter(Boolean);
}
/** 1-2 safe explainer lines for a news slide. `body` = article text for the number check. */
export function explainLines(A = {}, body = '') {
  try {
    const raw = Array.isArray(A.explain) ? A.explain : (typeof A.explain === 'string' ? A.explain.split(/\n+/) : []);
    const lines = raw.map(clean).filter(Boolean).slice(0, 2);
    const src = String(body || `${A.headline || ''} ${A.key?.text || ''} ${A.bodyText || ''}`);
    const ok = lines.length >= 1 && lines.every((l) => l.length <= EXPLAIN_MAX && (l.match(NUM) || []).every((n) => src.includes(n)));
    return ok ? lines : fallbackExplain(A);
  } catch { return fallbackExplain(A); }
}
