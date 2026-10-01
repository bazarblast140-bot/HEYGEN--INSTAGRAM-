// Turn public Instagram media into the patterns the generators are allowed to see.
// Numbers come only from the payload. A missing count stays null.

export const HASHTAG_WEEKLY_CAP = 30;
export const TREND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const ROLLING_DAYS = 30;
export const ROLLING_CAP = 250;

const IST_OFFSET_MS = Math.round(5.5 * 60 * 60 * 1000);

export function istDate(now = new Date()) {
  return new Date(new Date(now).getTime() + IST_OFFSET_MS);
}

/** Monday (IST) of the week, as YYYY-MM-DD. The hashtag budget resets on that day. */
export function weekKey(now = new Date()) {
  const ist = istDate(now);
  const day = ist.getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  const monday = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - delta));
  return monday.toISOString().slice(0, 10);
}

export function isSundayIst(now = new Date()) {
  return istDate(now).getUTCDay() === 0;
}

export function hourIst(timestamp) {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return null;
  return istDate(at).getUTCHours();
}

export function hookFromCaption(caption) {
  const line = String(caption || '').split('\n').map((part) => part.trim()).find(Boolean) || '';
  return line.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
}

export function coverStyle(hook) {
  const text = String(hook || '');
  if (/\d/.test(text)) return 'number';
  if (/\?|क्या|क्यों|कैसे|\bkya\b|\bkyun\b|\bkaise\b/i.test(text)) return 'question';
  return 'statement';
}

export function ctaType(caption) {
  const text = String(caption || '');
  if (/comment|कमेंट|कमेन्ट/i.test(text)) return 'comment';
  if (/save|सेव/i.test(text)) return 'save';
  if (/follow|फ़ॉलो|फॉलो/i.test(text)) return 'follow';
  return 'none';
}

export function formatOf(media = {}) {
  const product = String(media.media_product_type || '').toUpperCase();
  const type = String(media.media_type || '').toUpperCase();
  if (product === 'REELS' || type === 'VIDEO') return 'Reel';
  if (product.includes('CAROUSEL') || type.includes('CAROUSEL')) return 'carousel';
  return 'post';
}

export function hashtagsIn(caption) {
  return String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || [];
}

export function patternFromMedia(media, { followers = null, username = null, source, fetchedAt }) {
  const caption = String(media?.caption || '');
  const hook = hookFromCaption(caption);
  const likes = Number.isFinite(Number(media?.like_count)) ? Number(media.like_count) : null;
  const comments = Number.isFinite(Number(media?.comments_count)) ? Number(media.comments_count) : null;
  const followerCount = Number.isFinite(Number(followers)) && Number(followers) > 0 ? Number(followers) : null;
  const engagementRate = followerCount != null && likes != null && comments != null
    ? (likes + comments) / followerCount
    : null;
  return {
    source,
    username,
    permalink: media?.permalink || null,
    timestamp: media?.timestamp || null,
    fetchedAt,
    hook,
    coverStyle: coverStyle(hook),
    captionLength: caption.length,
    cta: ctaType(caption),
    hashtags: hashtagsIn(caption).slice(0, 8),
    format: formatOf(media),
    hourIst: hourIst(media?.timestamp),
    engagementRate,
    followers: followerCount,
    likes,
    comments,
  };
}

export function hashtagBudget(previous, now = new Date(), cap = HASHTAG_WEEKLY_CAP) {
  const week = weekKey(now);
  const used = previous?.hashtagSearch?.week === week ? Number(previous.hashtagSearch.used) || 0 : 0;
  return { week, used, remaining: Math.max(0, cap - used) };
}

export function mergeTrends(previous, incoming, now = new Date()) {
  const cutoff = now.getTime() - ROLLING_DAYS * 24 * 60 * 60 * 1000;
  const byLink = new Map();
  for (const item of [...(previous?.patterns || []), ...(incoming.patterns || [])]) {
    if (!item?.permalink || !item.timestamp) continue;
    const at = new Date(item.timestamp).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    byLink.set(item.permalink, item);
  }
  const patterns = [...byLink.values()]
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, ROLLING_CAP);
  return {
    updatedAt: now.toISOString(),
    patterns,
    hashtagSearch: incoming.hashtagSearch || previous?.hashtagSearch || { week: weekKey(now), used: 0 },
    notes: incoming.notes || [],
  };
}

export function freshPatterns(trends, now = new Date(), maxAgeMs = TREND_MAX_AGE_MS) {
  const at = new Date(now).getTime();
  return (trends?.patterns || []).filter((item) => {
    const then = new Date(item.fetchedAt || item.timestamp).getTime();
    return Number.isFinite(then) && at - then <= maxAgeMs && at - then >= 0;
  });
}

/** Prompt block. Empty when nothing was fetched in the last 7 days. */
export function trendPrompt(trends, now = new Date()) {
  const fresh = freshPatterns(trends, now)
    .filter((item) => item.hook)
    .sort((a, b) => (b.engagementRate || 0) - (a.engagementRate || 0))
    .slice(0, 5);
  if (!fresh.length) return '';
  const lines = fresh.map((item) => (
    `- ${item.coverStyle} hook "${item.hook}" · ${item.format} · ${item.hourIst ?? '?'}h IST · ${item.permalink}`
  ));
  return `<trending_patterns>
Public patterns from the last 7 days. Prefer a similar hook style and a related finance topic.
Do not copy captions, numbers, or these permalinks into the post. Do not invent engagement figures.
${lines.join('\n')}
</trending_patterns>`;
}

export function weeklyReport(trends, { date, summary = '' } = {}) {
  const patterns = freshPatterns(trends, new Date(`${date}T12:00:00Z`));
  const byEngagement = [...patterns].sort((a, b) => (b.engagementRate || 0) - (a.engagementRate || 0));
  const top = byEngagement.slice(0, 8);
  const formats = countBy(patterns, (item) => item.format);
  const hours = countBy(patterns.filter((item) => item.hourIst != null), (item) => `${item.hourIst}:00 IST`);
  const lines = [
    `# Weekly patterns ${date}`,
    '',
    `Posts in the last 7 days: ${patterns.length}.`,
    '',
    '## Top hooks',
    '',
  ];
  if (!top.length) lines.push('No fresh public posts were stored this week.');
  for (const item of top) {
    const rate = item.engagementRate == null ? 'n/a' : `${(item.engagementRate * 100).toFixed(2)}%`;
    lines.push(`- ${item.hook} (${item.format}, ${item.coverStyle}, engagement ${rate}) — ${item.permalink}`);
  }
  lines.push('', '## Formats', '', formatCounts(formats), '', '## Posting hours IST', '', formatCounts(hours));
  if (summary) lines.push('', '## Summary', '', summary.trim());
  lines.push('');
  return lines.join('\n');
}

function countBy(items, keyFn) {
  const counts = new Map();
  for (const item of items) {
    const key = keyFn(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatCounts(entries) {
  if (!entries.length) return 'None.';
  return entries.map(([key, count]) => `- ${key}: ${count}`).join('\n');
}

/** A model summary may only repeat numbers that are already in the report. */
export function groundedSummary(summary, sourceText) {
  const text = String(summary || '').trim();
  if (!text) return '';
  const numbers = text.match(/\d+(?:\.\d+)?/g) || [];
  const source = String(sourceText || '');
  if (numbers.some((number) => !source.includes(number))) return '';
  return text;
}
