// One caption shape for carousels and Reels.
//
// The first line is the hook the model wrote. The close is a save / share /
// comment prompt, then a single "link in bio" line. Hashtags stay at five.
// Referral URLs do not belong in the caption.

export const ENGAGEMENT = 'Save karo, share karo, comment mein apna sawal likho.';
export const LINK_IN_BIO = 'Link in bio.';
export const MAX_HASHTAGS = 5;

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
      if (/^link in bio\.?$/i.test(trimmed)) return false;
      if (trimmed === ENGAGEMENT) return false;
      return true;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const seen = new Map();
  for (const tag of [...inline, ...hashtags, brandTag].filter(Boolean)) {
    const raw = String(tag).trim();
    if (!raw) continue;
    const withHash = raw.startsWith('#') ? raw : `#${raw}`;
    const key = withHash.slice(1).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.set(key, withHash);
  }
  const tags = [...seen.values()].slice(0, limit);

  return [body, ENGAGEMENT, LINK_IN_BIO, tags.length ? tags.join(' ') : null]
    .filter(Boolean)
    .join('\n\n');
}
