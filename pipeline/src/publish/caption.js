// One caption shape for carousels and Reels.
//
// The first line is the hook the model wrote. The close is a save / share /
// comment prompt, then a single "link in bio" line. Hashtags stay at five.
// Referral URLs do not belong in the caption.

export const ENGAGEMENT = 'Save karo, share karo, comment mein apna sawal likho.';
export const LINK_IN_BIO = 'Link in bio.';
export const MAX_HASHTAGS = 5;

// English generics that showed up on the finance account (#stockmarket #finance).
// A niche Indian-market tag is kept; these are not.
const BROAD_TAGS = new Set([
  'stockmarket', 'stockmarkets', 'stockmarketindia', 'indianstockmarket',
  'finance', 'investing', 'investment', 'investments', 'stocks', 'stock',
  'trading', 'trader', 'traders', 'money', 'business', 'wealth',
  'instagram', 'reels', 'viral', 'explore', 'fyp', 'sharemarket',
]);

const NICHE_FROM_TEXT = [
  [/bank\s*nifty|banknifty|बैंक\s*निफ्टी/i, '#banknifty'],
  [/(?<![a-z])nifty(?![a-z])|निफ्टी/i, '#nifty50'],
  [/sensex|सेंसेक्स/i, '#sensex'],
  [/roce/i, '#roce'],
  [/cash\s*flow|नकद/i, '#cashflow'],
  [/option|ऑप्शन|\btheta\b|\bvega\b/i, '#optionstrading'],
  [/intraday|\bvwap\b/i, '#intraday'],
  [/\bfii\b|\bdii\b/i, '#fiidii'],
  [/\bsip\b|mutual fund/i, '#sip'],
  [/price action|\bsupport\b|\bresistance\b/i, '#priceaction'],
];

const FALLBACK_NICHE = ['#nifty50', '#banknifty', '#nse', '#fiidii', '#priceaction'];

/**
 * The model closes with its own save/follow line, and the publisher adds one
 * more. A line that is that invitation is dropped so the caption carries the
 * fixed line once.
 */
export function isModelCtaLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (t === ENGAGEMENT) return true;
  if (/^link in bio\.?$/i.test(t)) return true;
  const save = /(सेव|save)\s*कर|(save|share)\s+karo/i.test(t);
  const follow = /(फॉलो|फ़ॉलो|follow)\s*(कर|karo)/i.test(t);
  const share = /(शेयर|share)\s*(कर|karo)/i.test(t);
  const comment = /(कमेंट|कमेन्ट|comment)\s*(कर|mein|में|karo)/i.test(t);
  const hits = [save, follow, share, comment].filter(Boolean).length;
  if (hits >= 2) return true;
  return hits === 1 && t.length < 140 && !/\d/.test(t);
}

export function nicheHashtags(tags, { caption = '', limit = MAX_HASHTAGS } = {}) {
  const kept = [];
  const seen = new Set();
  const add = (tag) => {
    const raw = String(tag || '').trim();
    if (!raw) return;
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    const key = withHash.slice(1).toLowerCase();
    if (!key || BROAD_TAGS.has(key) || seen.has(key) || kept.length >= limit) return;
    seen.add(key);
    kept.push(withHash);
  };

  for (const tag of tags) add(tag);
  const blob = `${caption}\n${tags.join(' ')}`;
  if (kept.length < limit) {
    for (const [pattern, tag] of NICHE_FROM_TEXT) {
      if (tag === '#nifty50' && (seen.has('nifty') || seen.has('nifty50'))) continue;
      if (pattern.test(blob)) add(tag);
    }
  }
  if (!kept.length) {
    for (const tag of FALLBACK_NICHE) add(tag);
  }
  return kept.slice(0, limit);
}

const URL_RE = /https?:\/\/\S+/gi;
const REFERRAL_LINE = /^(?:Zerodha|Upstox|INDmoney|Delta Exchange)\s*:/i;
const DISCLOSURE = /referral link|referral benefit|सिफ़ारिश नहीं|सिफारिश नहीं/i;

export function stripReferrals(text) {
  return String(text || '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !REFERRAL_LINE.test(trimmed) && !DISCLOSURE.test(trimmed);
    })
    .join('\n')
    .replace(URL_RE, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function shapeCaption({ caption = '', hashtags = [], brandTag, limit = MAX_HASHTAGS } = {}) {
  const cleaned = stripReferrals(caption);
  const trailing = cleaned.match(/(?:^|\n)[ \t]*(?:#[^\s#]+[ \t]*)+$/);
  const rawBody = trailing ? cleaned.slice(0, trailing.index).trim() : cleaned;
  const inline = trailing?.[0].match(/#[^\s#]+/g) || [];

  const body = rawBody
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      return !isModelCtaLine(trimmed);
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const tags = nicheHashtags([...inline, ...hashtags, brandTag], { caption: body, limit });

  return [body, ENGAGEMENT, LINK_IN_BIO, tags.length ? tags.join(' ') : null]
    .filter(Boolean)
    .join('\n\n');
}
