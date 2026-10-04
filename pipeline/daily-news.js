#!/usr/bin/env node
// Daily news digest → one repo issue "Daily news YYYY-MM-DD" (IST), label grok-news.
//
// No paid API: public RSS/Atom feeds only, parsed with the carousel's small
// regex parser (parseRss). Items from the last 24 hours, top 3-5 per section,
// deduped across sections by normalised URL and headline. A dead or stale
// feed is skipped with a note in its section; the run never fails because of
// a feed. If today's issue already exists, nothing is created.
//
//   node pipeline/daily-news.js            # create today's issue (GITHUB_TOKEN, GITHUB_REPOSITORY)
//   node pipeline/daily-news.js --dry-run  # print the issue body, create nothing
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { parseRss, fingerprint } from './src/carousel/news.js';

export const LABEL = 'grok-news';
export const HOURS = 24;
export const PER_SECTION = 5;
export const MIN_PER_SECTION = 3;

// Verified with curl on 4 Oct 2026. Feeds marked stale returned 200 but their
// newest item was months old; they stay listed so the note says so.
export const SECTIONS = [
  { key: 'ai', title: 'Big AI news', feeds: [
    { name: 'TechCrunch AI', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
    { name: 'The Verge AI', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
  ] },
  { key: 'finance', title: 'Finance/markets India', feeds: [
    { name: 'ET Markets', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
    { name: 'ET Stocks news', url: 'https://economictimes.indiatimes.com/markets/stocks/news/rssfeeds/2146842.cms' },
    { name: 'Livemint Markets', url: 'https://www.livemint.com/rss/markets' },
    { name: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/latestnews.xml' },
  ] },
  { key: 'technical', title: 'Technical analysis/market outlook', feeds: [
    { name: 'ET Markets technicals', url: 'https://economictimes.indiatimes.com/markets/technical-charts/rssfeeds/81776766.cms' },
    { name: 'ET Expert view', url: 'https://economictimes.indiatimes.com/markets/expert-view/rssfeeds/50649960.cms' },
    { name: 'Moneycontrol technicals', url: 'https://www.moneycontrol.com/rss/technicals.xml' },
  ] },
  { key: 'crypto', title: 'Crypto', feeds: [
    { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
    { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  ] },
  { key: 'mf', title: 'Mutual funds', feeds: [
    { name: 'ET Mutual Funds', url: 'https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms' },
    { name: 'ET MF news', url: 'https://economictimes.indiatimes.com/mf/mf-news/rssfeeds/1107225967.cms' },
    { name: 'Moneycontrol MF', url: 'https://www.moneycontrol.com/rss/mfnews.xml' },
    { name: 'Value Research', url: 'https://www.valueresearchonline.com/feed/' },
  ] },
];

/** YYYY-MM-DD in IST. */
export function istDate(now = new Date()) {
  return new Date(now.getTime() + 330 * 60000).toISOString().slice(0, 10);
}
export const issueTitle = (now = new Date()) => `Daily news ${istDate(now)}`;

/** Lower-case host, no www, no query/hash/trailing slash. */
export function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}`;
  } catch { return String(url || '').trim().toLowerCase(); }
}
const titleKey = (t) => fingerprint(t) || String(t).toLowerCase().trim();

/** Items newer than `hours` before now (items with no date are dropped). */
export function recent(items, { now = Date.now(), hours = HOURS } = {}) {
  const cutoff = now - hours * 3600 * 1000;
  return items.filter((i) => i.at && i.at >= cutoff && i.at <= now + 3600 * 1000);
}

/**
 * Drops items already seen (by normalised URL or headline); `seen` is shared
 * across sections. Only the items kept (up to `limit`) are marked seen, so a
 * headline a section did not show is still free for a later section.
 */
export function dedupe(items, seen = { urls: new Set(), titles: new Set() }, limit = Infinity) {
  const out = [];
  for (const i of items) {
    if (out.length >= limit) break;
    const u = normalizeUrl(i.url); const t = titleKey(i.title);
    if ((u && seen.urls.has(u)) || (t && seen.titles.has(t))) continue;
    if (u) seen.urls.add(u); if (t) seen.titles.add(t);
    out.push(i);
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RajeshTechnicalTraders-daily-news/1.0)', Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    signal: AbortSignal.timeout(15000), redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** { items, note } for one feed. Never throws. */
export async function readFeed(feed, { now = Date.now(), get = fetchText } = {}) {
  try {
    const all = parseRss(await get(feed.url), { site: feed.name }).filter((i) => i.url);
    if (!all.length) return { items: [], note: `${feed.name}: no items in the feed` };
    const fresh = recent(all, { now });
    if (!fresh.length) {
      const newest = Math.max(...all.map((i) => i.at || 0));
      return { items: [], note: newest ? `${feed.name}: nothing in the last 24h (newest ${new Date(newest).toISOString().slice(0, 10)})` : `${feed.name}: items carry no dates` };
    }
    return { items: fresh.map((i) => ({ ...i, from: feed.name })), note: null };
  } catch (err) {
    return { items: [], note: `${feed.name}: skipped (${String(err.message || err).slice(0, 60)})` };
  }
}

/** Sections with their top items and notes, deduped across sections in order. */
export async function collect({ now = Date.now(), get, sections = SECTIONS } = {}) {
  const seen = { urls: new Set(), titles: new Set() };
  const out = [];
  for (const s of sections) {
    const reads = await Promise.all(s.feeds.map((f) => readFeed(f, { now, get })));
    // Round-robin across the section's feeds, newest first within each feed.
    const lists = reads.map((r) => r.items.sort((a, b) => b.at - a.at));
    const merged = [];
    for (let i = 0; merged.length < 50 && lists.some((l) => l.length > i); i += 1) for (const l of lists) if (l[i]) merged.push(l[i]);
    out.push({ ...s, items: dedupe(merged, seen, PER_SECTION), notes: reads.map((r) => r.note).filter(Boolean) });
  }
  return out;
}

const md = (s) => String(s).replace(/([[\]])/g, '\\$1').replace(/\s+/g, ' ').trim();
const ist = (at) => new Date(at + 330 * 60000).toISOString().slice(11, 16);
const istDay = (at) => { const d = new Date(at + 330 * 60000); return `${d.getUTCDate()} ${'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[d.getUTCMonth()]}`; };
/** Link without tracking parameters. */
export const cleanLink = (url) => { try { const u = new URL(url); [...u.searchParams.keys()].filter((k) => /^utm_/i.test(k)).forEach((k) => u.searchParams.delete(k)); return u.toString(); } catch { return url; } };

export function buildBody(sections, { now = new Date() } = {}) {
  const lines = [`Headlines from public RSS feeds, last ${HOURS}h, as of ${istDate(now)} ${ist(now.getTime())} IST. No paid API.`, ''];
  sections.forEach((s, n) => {
    lines.push(`## ${n + 1}. ${s.title}`);
    if (!s.items.length) lines.push('_No fresh headlines from these feeds in the last 24h._');
    for (const i of s.items) lines.push(`- [${md(i.title)}](${cleanLink(i.url)}) — ${i.from}, ${istDay(i.at)} ${ist(i.at)} IST`);
    if (s.items.length && s.items.length < MIN_PER_SECTION) lines.push(`_Only ${s.items.length} fresh headline(s) today._`);
    for (const note of s.notes) lines.push(`> ${note}`);
    lines.push('');
  });
  lines.push('<!-- daily-news.js; sections: ai, finance, technical, crypto, mf -->');
  return lines.join('\n');
}

/** GitHub REST with GITHUB_TOKEN. */
export function github({ repo = process.env.GITHUB_REPOSITORY, token = process.env.GITHUB_TOKEN } = {}) {
  return async (method, path, body) => {
    const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'daily-news' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  };
}

/** Today's issue if it already exists (open or closed). */
export async function findExisting(api, title) {
  const { json } = await api('GET', `/issues?labels=${LABEL}&state=all&per_page=50&sort=created&direction=desc`);
  return (Array.isArray(json) ? json : []).find((i) => i.title === title && !i.pull_request) || null;
}

export async function ensureLabel(api) {
  const got = await api('GET', `/labels/${LABEL}`);
  if (got.status === 200) return 'exists';
  const made = await api('POST', '/labels', { name: LABEL, color: '1d76db', description: 'Daily news digest (public RSS) — carousel topic source' });
  return made.status === 201 ? 'created' : `could not create (${made.status})`;
}

export async function run({ now = new Date(), api = github(), get, dryRun = false, log = console.log } = {}) {
  const title = issueTitle(now);
  if (!dryRun) {
    const existing = await findExisting(api, title);
    if (existing) { log(`"${title}" already exists: ${existing.html_url} — nothing to do.`); return { skipped: true, url: existing.html_url }; }
  }
  const sections = await collect({ now: now.getTime(), get });
  const body = buildBody(sections, { now });
  for (const s of sections) log(`${s.title}: ${s.items.length} item(s)${s.notes.length ? ` — ${s.notes.join('; ')}` : ''}`);
  if (dryRun) { log(`\n# ${title}\n\n${body}`); return { dryRun: true, body }; }
  log(`label ${LABEL}: ${await ensureLabel(api)}`);
  const made = await api('POST', '/issues', { title, body, labels: [LABEL] });
  if (made.status !== 201) throw new Error(`could not create the issue (${made.status} ${JSON.stringify(made.json).slice(0, 200)})`);
  log(`created ${made.json.html_url}`);
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Created [${title}](${made.json.html_url})\n`);
  return { created: true, url: made.json.html_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({ dryRun: process.argv.includes('--dry-run') }).catch((err) => { console.error(err.message); process.exit(1); });
}
