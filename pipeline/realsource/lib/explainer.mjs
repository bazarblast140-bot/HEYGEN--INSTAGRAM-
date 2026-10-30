// News-slide explainer (Rajesh, 29 Oct 2026): every real-article slide carries 1-2 short,
// simple spoken-Hindi lines ABOVE the screenshot — what the news is, and what it means
// for the viewer. Owner rule 30 Oct 2026: these lines AND the summary box below the
// screenshot are Devanagari Hindi (simple bolchaal), not Roman Hinglish/English, e.g.
// "SBI Card 1 दिसंबर से 1% फीस लेगा।" / "मतलब: किराया और वॉलेट पेमेंट महँगा होगा।"
// A few brand/finance words may stay Latin, but the line must be mostly Devanagari.
// Figures stay in Latin digits and must appear in the article. Anything missing, too long,
// Roman or with a foreign number falls back to deterministic Devanagari lines.
// This never throws and never blocks a post.
export const EXPLAIN_MAX = 80; // chars (UTF-16) per line; Devanagari matras count as chars
export const PLAIN_MAX = 190;  // summary box text below the screenshot
const NUM = /\d(?:[\d,]*\d)?(?:\.\d+)?/g;
const DEVA = /[\u0900-\u097F]/g;
const LATIN = /[A-Za-z]/g;
const DEVA_DIGIT = /[\u0966-\u096F]/;
const clean = (s) => String(s ?? '').replace(/<[^>]*>/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
/** True when the text is mostly Devanagari: >= 55% of its words are Devanagari (brand names
 * like "SBI Card" may stay Latin), and figures use Latin digits. */
export function isDevanagari(t, min = 0.55) {
  const s = String(t || '');
  const words = s.split(/[\s/]+/).filter((w) => /[A-Za-z\u0900-\u097F]/.test(w));
  const d = words.filter((w) => { const n = (w.match(DEVA) || []).length; return n > 0 && n >= (w.match(LATIN) || []).length; }).length;
  return d > 0 && d / words.length >= min && !DEVA_DIGIT.test(s);
}
function trim(t, max = EXPLAIN_MAX) {
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1); const at = cut.lastIndexOf(' ');
  return `${(at > 0 ? cut.slice(0, at) : cut).replace(/[\s,;:–।-]+$/, '')}…`;
}
const numsOk = (l, src) => (l.match(NUM) || []).every((n) => src.includes(n));
export const NEWS = {
  Market: 'खबर: आज शेयर बाज़ार की एक बड़ी खबर आई है।',
  Stocks: 'खबर: एक कंपनी के शेयर से जुड़ी अहम खबर है।',
  'Mutual Funds': 'खबर: म्यूचुअल फंड से जुड़ी एक नई खबर है।',
  Finance: 'खबर: आपके पैसे से जुड़ी एक नई खबर है।',
};
export const MEANS = {
  Market: 'मतलब: आपके पोर्टफोलियो पर आज इसका असर दिख सकता है।',
  Stocks: 'मतलब: इस शेयर के निवेशकों के लिए यह ज़रूरी खबर है।',
  'Mutual Funds': 'मतलब: आपके म्यूचुअल फंड/SIP पर इसका असर पड़ सकता है।',
  Finance: 'मतलब: आपके पैसे और खर्चे पर इसका असर पड़ सकता है।',
};
/** Deterministic Devanagari lines: the title if it is Devanagari, else a per-category line. */
export function fallbackExplain(A = {}) {
  const k = MEANS[A?.kicker] ? A.kicker : 'Finance';
  const head = clean(A?.title || '');
  const l1 = head && isDevanagari(head) ? trim(`खबर: ${head.replace(/[.…।]+$/, '')}।`) : NEWS[k];
  return [l1, MEANS[k]];
}
/** 1-2 safe Devanagari explainer lines for a news slide. `body` = article text for the number check. */
export function explainLines(A = {}, body = '') {
  try {
    const raw = Array.isArray(A.explain) ? A.explain : (typeof A.explain === 'string' ? A.explain.split(/\n+/) : []);
    const lines = raw.map(clean).filter(Boolean).slice(0, 2);
    const src = String(body || `${A.headline || ''} ${A.key?.text || ''} ${A.bodyText || ''}`);
    const ok = lines.length >= 1 && lines.every((l) => l.length <= EXPLAIN_MAX && isDevanagari(l) && numsOk(l, src));
    return ok ? lines : fallbackExplain(A);
  } catch { return fallbackExplain(A); }
}
/** Summary box text below the screenshot: the model's `plain` if Devanagari, short and number-safe; else the fallback lines. */
export function plainHindi(A = {}, body = '') {
  try {
    const p = clean(A.plain);
    const src = String(body || `${A.headline || ''} ${A.key?.text || ''} ${A.bodyText || ''}`);
    if (p && p.length <= PLAIN_MAX && isDevanagari(p) && numsOk(p, src)) return p;
  } catch { /* fall through */ }
  return fallbackExplain(A).join(' ');
}
