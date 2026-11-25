// One caption shape for carousels and Reels.
//
// The first line is the hook the model wrote. The close is a save / share /
// comment prompt, the hashtags (five at most), and then the caption ENDS with
// one "link in bio" line for the broker referral links. Referral URLs do not
// belong in the caption; any "link in bio" line the model wrote is dropped so
// the CTA appears exactly once.

import { BROKER_CTA, isBioCtaLine } from './cta.js';

export const ENGAGEMENT = 'Save karo, share karo, comment mein apna sawal likho.';
// CAPTION_CTA_STYLE=question: one concrete ask instead of three generic ones.
// 0 comments on 67 posts (24 Sep–8 Oct) with the line above. It promises a
// reply, so it only makes sense if comments are answered.
export const QUESTION_ENGAGEMENT = 'Is hisaab par aapka sawal? Comment karo 👇 har sawal ka jawab milega. Save karo, baad mein kaam aayega.';

export function engagementLine(env = process.env) {
  return String(env.CAPTION_CTA_STYLE || '').trim().toLowerCase() === 'question' ? QUESTION_ENGAGEMENT : ENGAGEMENT;
}
export const LINK_IN_BIO = BROKER_CTA;
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
// `\b` is ASCII-only, so Devanagari invitations ("सेव करें") need a letter boundary.
const EDGE = String.raw`(?:^|[^\p{L}\p{N}])`;
const END = String.raw`(?=$|[^\p{L}\p{N}])`;
const INVITE = String.raw`(?:karo|karein|karen|kar|करो|करें|करे|कर)`;

function ctaHits(text) {
  const t = String(text || '');
  const save = new RegExp(`${EDGE}(?:save|सेव)${END}(?:\\s*,|\\s*${INVITE})`, 'iu').test(t);
  const share = new RegExp(`${EDGE}share\\s*,`, 'iu').test(t)
    || new RegExp(`${EDGE}(?:share|शेयर)\\s*${INVITE}`, 'iu').test(t);
  const comment = /aapka view|आपका व्यू|apna sawal/i.test(t)
    || new RegExp(`${EDGE}(?:comment|कमेंट|कमेन्ट)\\s*(?:${INVITE}|mein|में)`, 'iu').test(t)
    || (new RegExp(`${EDGE}comment${END}`, 'iu').test(t) && new RegExp(`${EDGE}(?:save|share)${END}`, 'iu').test(t));
  const follow = new RegExp(`${EDGE}(?:follow|फॉलो|फ़ॉलो)\\s*${INVITE}`, 'iu').test(t);
  return [save, share, comment, follow].filter(Boolean).length;
}

export function isModelCtaLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (t === ENGAGEMENT || t === QUESTION_ENGAGEMENT) return true;
  if (/^link in bio\.?$/i.test(t) || isBioCtaLine(t)) return true;
  const hits = ctaHits(t);
  if (hits >= 2) return true;
  return hits === 1 && t.length < 140 && !/\d/.test(t);
}

/** Drop save/share/comment sentences so the standard CTA is the only one. */
export function stripCtaSentences(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line
      .split(/(?<=[.?!।])\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence && !isModelCtaLine(sentence))
      .join(' ')
      .trim())
    .filter((line, index, lines) => line || (index > 0 && lines[index - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

export function shapeCaption({ caption = '', hashtags = [], brandTag, limit = MAX_HASHTAGS, env = process.env } = {}) {
  // A bio line the model (or an earlier shaping) put after its hashtags would
  // hide the tag row; drop those lines first, the CTA is re-added once below.
  const cleaned = stripReferrals(caption)
    .split('\n')
    .filter((line) => !isBioCtaLine(line))
    .join('\n')
    .trim();
  const trailing = cleaned.match(/(?:^|\n)[ \t]*(?:#[^\s#]+[ \t]*)+$/);
  const rawBody = trailing ? cleaned.slice(0, trailing.index).trim() : cleaned;
  const inline = trailing?.[0].match(/#[^\s#]+/g) || [];

  const body = stripCtaSentences(rawBody);

  const tags = nicheHashtags([...inline, ...hashtags, brandTag], { caption: body, limit });

  return [body, engagementLine(env), tags.length ? tags.join(' ') : null, LINK_IN_BIO]
    .filter(Boolean)
    .join('\n\n');
}
