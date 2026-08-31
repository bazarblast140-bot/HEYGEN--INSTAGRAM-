// A ledger of what the reel has already talked about.
//
// "Har bar new topic ho" is not something a prompt can promise on its own. Ask a
// model for "today's market story" five mornings running, give it five similar
// days of numbers, and it will find the same story five times — not because it
// disobeyed, but because it has no idea it has already said this.
//
// So the last few weeks of topics are written down, handed to the model as a
// list it may not repeat, and checked again after it answers. The check matters
// more than the instruction: a prompt is a request, a rejected spec is a rule.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER = path.resolve(HERE, '..', '..', 'topic-history.json');

// Long enough that a fortnight of trading days cannot loop, short enough that a
// genuinely recurring subject (a budget, a rate decision) can come back later.
export const REMEMBER = 20;

/**
 * Reduce a topic to what makes it the same subject, not the same sentence.
 *
 * Devanagari has to survive this, and for a long time it did not: the filter
 * kept a-z0-9 and threw everything else away, so every Hindi topic fingerprinted
 * to the empty string and tooSimilar() returned false for a topic compared with
 * ITSELF. The repeat check ran on every generated carousel and could never once
 * have fired. It was found by a Venus post going out four days after a post
 * about how long a day on Venus lasts.
 */
export function fingerprint(topic) {
  const STOPWORDS = new Set([
    'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'is', 'are', 'ka',
    'ki', 'ke', 'me', 'se', 'ko', 'hai', 'kya', 'aaj', 'today', 'stock', 'market',
    'share', 'price', 'news', 'update', 'nifty', 'sensex',
    // The Hindi equivalents. Without these the fingerprint is mostly grammar.
    'की', 'के', 'का', 'को', 'में', 'से', 'पर', 'और', 'है', 'हैं', 'था', 'थे',
    'यह', 'वह', 'ये', 'वो', 'एक', 'भी', 'ही', 'तक', 'लिए', 'क्या', 'कैसे', 'क्यों',
    'आज', 'नया', 'नयी', 'बड़ा', 'बड़ी', 'सबसे', 'बारे',
  ]);

  return String(topic || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w))
    .sort()
    .join(' ');
}

/**
 * Two topics are "the same" when most of their meaningful words agree. Exact
 * string matching would let "HDFC Bank Q2 results" through the day after
 * "Q2 results of HDFC Bank".
 */
export function tooSimilar(a, b) {
  const left = new Set(fingerprint(a).split(' ').filter(Boolean));
  const right = new Set(fingerprint(b).split(' ').filter(Boolean));
  if (!left.size || !right.size) return false;

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  if (!shared) return false;

  const jaccard = shared / (left.size + right.size - shared);
  // Overlap as well as Jaccard, because the two ways a topic repeats are not the
  // same shape. "RBI repo rate cut" against "RBI policy repo rate decision" is a
  // near-equal pair that Jaccard catches. "SIP inflows record high" against
  // "Mutual fund SIP inflows hit record" is one topic sitting inside a wordier
  // one — Jaccard scores that 0.43 and waves it through, because the extra
  // qualifiers count against it. Containment is what makes it a repeat.
  const overlap = shared / Math.min(left.size, right.size);

  return jaccard >= 0.5 || (overlap >= 0.7 && shared >= 2);
}

export async function readHistory(file = LEDGER) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    // No ledger yet is not an error — it is the first morning.
    return [];
  }
}

export async function recordTopic({ topic, angle, date, file = LEDGER }) {
  if (!topic?.trim()) return;
  const entries = await readHistory(file);
  entries.push({ date, topic: topic.trim(), angle: (angle || '').trim() });
  await fs.writeFile(
    file,
    `${JSON.stringify({ entries: entries.slice(-REMEMBER) }, null, 2)}\n`,
  );
}

/** Which recent topic does this one repeat, if any? */
export function findRepeat(topic, entries) {
  return entries.find((e) => tooSimilar(topic, e.topic)) || null;
}
