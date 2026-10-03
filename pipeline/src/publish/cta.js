// The one "link in bio" line for the broker referral links.
//
// Instagram captions carry no URLs (they are not tappable there), so the
// referral links live in the bio and the caption points at them, once, as its
// last line. Paise Ki Pathshala writes its own version ("profile bio me link
// dekho"), so detection accepts every way this account has phrased it — a
// second CTA is never appended to a caption that already has one.

export const BROKER_CTA = 'Demat / trading account ke liye broker referral links: link in bio.';

const BIO_CTA = [
  /link\s*(?:is\s*)?in\s*(?:the\s*|my\s*|our\s*)?bio/i,
  /(?<![a-z])bio\s+(?:me|mein|men|में)\s*(?:link|links|लिंक|दिए|diya|diye|hai|है)/i,
  /(?:link|links|लिंक)\s*(?:profile\s*)?(?:bio|बायो)\s*(?:me|mein|men|में|par|पर)/i,
  /(?:बायो|bio)\s*(?:में|me|mein)\s*(?:लिंक|link)/i,
  /(?:check|dekho|dekhein|dekhen|देखो|देखें)\s*(?:the\s*|our\s*)?(?:profile\s*)?bio/i,
  /(?<![a-z])bio\s+(?:check|dekho|dekhein|dekhen|देखो|देखें)/i,
];

/** Does this text already send the reader to the bio for links? */
export function hasBioCta(text) {
  const t = String(text || '');
  return BIO_CTA.some((re) => re.test(t));
}

/** A short line whose job is only the bio CTA (safe to drop and re-add once). */
export function isBioCtaLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 160) return false;
  return hasBioCta(t);
}

/**
 * Append the CTA unless one is already there. The result stays within `limit`
 * characters: the body is trimmed, never the CTA.
 */
export function withBioCta(text, { limit = 2200, cta = BROKER_CTA } = {}) {
  const body = String(text || '').trim();
  if (hasBioCta(body)) return body.length <= limit ? body : body.slice(0, limit).trim();
  const tail = `\n\n${cta}`;
  if (!body) return cta.slice(0, limit);
  const room = Math.max(0, limit - tail.length);
  const trimmed = body.length > room ? `${body.slice(0, Math.max(0, room - 1)).trimEnd()}…` : body;
  return `${trimmed}${tail}`;
}
