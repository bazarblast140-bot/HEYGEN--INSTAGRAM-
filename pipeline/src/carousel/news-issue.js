// Carousel topic candidates from the daily news issue (label grok-news).
//
// daily-news.yml (07:15 IST) files "Daily news YYYY-MM-DD" with five sections
// of RSS headlines; older issues may be titled "Grok news …". A carousel
// build reads the latest OPEN one dated today or yesterday (IST) and hands the
// slot's sections to the generator, which saves its own news fetch:
//   ai (09:30)      → Big AI news, Crypto
//   midday (12:30)  → Mutual funds (topic candidates for a calc explainer)
//   evening (16:45) → Finance/markets India, Technical analysis/outlook,
//                     next to the day's verified close (market.js)
// No issue, no matching section, or any API error → null, and the build uses
// its usual source (RSS fetch for ai, topic seeds for midday, the market
// feeds for evening). Nothing here can block a build.

const LABEL = 'grok-news';
const TITLE = /^(grok news|daily news)\b/i;

/** Section heading → key. Order matters: "market outlook" is technical, not finance. */
const KINDS = [
  ['technical', /technical|outlook/i],
  ['mf', /mutual/i],
  ['crypto', /crypto/i],
  ['ai', /\bai\b|artificial intelligence/i],
  ['finance', /financ|market|india/i],
];
// Topic-wise slots: morning AI + crypto, afternoon mutual funds, evening
// market close (finance + technical news next to the verified close).
export const SECTIONS_FOR = {
  ai: ['ai', 'crypto'],
  midday: ['mf'],
  evening: ['finance', 'technical'],
};

const MONTHS = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
const OUTLETS = [
  [/economictimes\.indiatimes\.com/, 'Economic Times'], [/livemint\.com/, 'Livemint'], [/moneycontrol\.com/, 'Moneycontrol'],
  [/techcrunch\.com/, 'TechCrunch'], [/theverge\.com/, 'The Verge'], [/coindesk\.com/, 'CoinDesk'],
  [/cointelegraph\.com/, 'Cointelegraph'], [/valueresearchonline\.com/, 'Value Research'], [/business-standard\.com/, 'Business Standard'],
];

export const istDate = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(0, 10);

function outlet(url, fallback) {
  try {
    const host = new URL(url).hostname;
    const hit = OUTLETS.find(([re]) => re.test(host));
    return hit ? hit[1] : (fallback || host.replace(/^www\./, ''));
  } catch { return fallback || null; }
}

/** "4 Oct 06:15 IST" (year from the issue) → ms, or null. */
function whenFrom(text, year) {
  const m = String(text).match(/(\d{1,2}) ([A-Za-z]{3})\w* (\d{1,2}):(\d{2}) IST/);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon < 0) return null;
  return Date.UTC(year, mon, Number(m[1]), Number(m[3]), Number(m[4])) - 330 * 60000;
}

/**
 * { key: [story] } from the issue body. Each "## …" heading is a section; each
 * "- [headline](url) — Feed, 4 Oct 06:15 IST" line is a story. A line with no
 * time is dated by the issue itself.
 */
export function parseDigest(body, { createdAt } = {}) {
  const created = createdAt ? new Date(createdAt).getTime() : Date.now();
  const year = new Date(created + 330 * 60000).getUTCFullYear();
  const out = {};
  let key = null;
  for (const line of String(body || '').split('\n')) {
    const h = line.match(/^#{2,3}\s+(?:\d+[.)]\s*)?(.+?)\s*$/);
    if (h) { key = (KINDS.find(([, re]) => re.test(h[1])) || [null])[0]; continue; }
    const m = line.match(/^\s*[-*]\s+\[((?:\\.|[^\]])+)\]\((https?:[^)\s]+)\)(.*)$/);
    if (!m || !key) continue;
    const title = m[1].replace(/\\([[\]])/g, '$1').trim();
    const rest = m[3].replace(/^\s*[—–-]\s*/, '');
    const feed = rest.split(',')[0].trim() || null;
    let at = whenFrom(rest, year) ?? created;
    if (at > created + 3600e3) at -= 365 * 86400e3; // "31 Dec" in a 1 Jan issue
    (out[key] ||= []).push({ title, url: m[2], site: outlet(m[2], feed), feed, at, date: istDate(at), from: 'daily-news' });
  }
  return out;
}

/** The latest open digest issue dated today or yesterday (IST), or null. */
export function pickIssue(issues, now = Date.now()) {
  const today = istDate(now); const yesterday = istDate(now - 86400e3);
  return (issues || [])
    .filter((i) => !i.pull_request && i.state !== 'closed' && TITLE.test(String(i.title || '').trim()))
    .map((i) => ({ i, day: (String(i.title).match(/\d{4}-\d{2}-\d{2}/) || [istDate(i.created_at)])[0] }))
    .filter(({ day }) => day === today || day === yesterday)
    .sort((a, b) => (b.day.localeCompare(a.day)) || (new Date(b.i.created_at) - new Date(a.i.created_at)))[0]?.i || null;
}

/** Stories for this slot, newest first, deduped by headline. */
export function storiesFor(slot, sections) {
  const keys = SECTIONS_FOR[slot] || [];
  const seen = new Set();
  return keys.flatMap((k) => sections[k] || [])
    .filter((s) => { const k = s.title.toLowerCase(); return !seen.has(k) && seen.add(k); })
    .sort((a, b) => b.at - a.at);
}

async function listIssues({ repo, token }) {
  const res = await fetch(`https://api.github.com/repos/${repo}/issues?labels=${LABEL}&state=open&sort=created&direction=desc&per_page=10`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'carousel-topics' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub issues ${res.status}`);
  return res.json();
}

/**
 * { issue, stories } for the slot from today's / yesterday's digest, or null
 * (no token, no issue, nothing for this slot, any error). Never throws.
 */
export async function digestStories({
  slot, now = Date.now(), repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
  list = listIssues, onNote,
} = {}) {
  try {
    if (!repo || !token || !SECTIONS_FOR[slot]) return null;
    const issue = pickIssue(await list({ repo, token }), now);
    if (!issue) { onNote?.('topics: no grok-news issue for today or yesterday — usual source'); return null; }
    const stories = storiesFor(slot, parseDigest(issue.body, { createdAt: issue.created_at }));
    if (!stories.length) { onNote?.(`topics: #${issue.number} "${issue.title}" has nothing for the ${slot} slot — usual source`); return null; }
    onNote?.(`topics: ${stories.length} headline(s) from #${issue.number} "${issue.title}"`);
    return { issue: { number: issue.number, title: issue.title, url: issue.html_url }, stories };
  } catch (err) {
    onNote?.(`topics: daily news issue unreadable (${String(err.message).slice(0, 60)}) — usual source`);
    return null;
  }
}

// The market calendar lives in market.js (full NSE 2026 holiday list).
export { NSE_HOLIDAYS, marketClosed, marketDayNote } from './market.js';
