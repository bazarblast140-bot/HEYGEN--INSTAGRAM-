import { test } from 'node:test';
import assert from 'node:assert/strict';

import { istDate, issueTitle, normalizeUrl, recent, dedupe, readFeed, collect, buildBody, run, cleanLink, LABEL } from '../pipeline/daily-news.js';

const NOW = new Date('2026-10-04T01:45:00Z'); // 07:15 IST
const h = (n) => new Date(NOW.getTime() - n * 3600e3).toUTCString();
const rss = (items) => `<?xml version="1.0"?><rss><channel><title>Feed</title>${items.map(([t, u, d]) => `<item><title><![CDATA[${t}]]></title><link>${u}</link><pubDate>${d}</pubDate></item>`).join('')}</channel></rss>`;
const atom = (items) => `<feed xmlns="http://www.w3.org/2005/Atom">${items.map(([t, u, d]) => `<entry><title>${t}</title><link rel="alternate" href="${u}"/><updated>${new Date(d).toISOString()}</updated></entry>`).join('')}</feed>`;

test('IST date title: 07:15 IST is today, 23:59 UTC is already tomorrow in IST', () => {
  assert.equal(issueTitle(NOW), 'Daily news 2026-10-04');
  assert.equal(istDate(new Date('2026-10-03T18:31:00Z')), '2026-10-04');
  assert.equal(istDate(new Date('2026-10-03T18:29:00Z')), '2026-10-03');
});

test('parses RSS and Atom, keeps only the last 24h', async () => {
  const got = await readFeed({ name: 'R', url: 'x' }, { now: NOW.getTime(), get: async () => rss([['Fresh one', 'https://a.com/1', h(2)], ['Old one', 'https://a.com/2', h(30)]]) });
  assert.deepEqual(got.items.map((i) => i.title), ['Fresh one']);
  const at = await readFeed({ name: 'A', url: 'x' }, { now: NOW.getTime(), get: async () => atom([['Atom item', 'https://v.com/a', h(5)]]) });
  assert.equal(at.items[0].url, 'https://v.com/a');
  assert.equal(recent([{ at: NOW.getTime() - 25 * 3600e3 }, { at: 0 }], { now: NOW.getTime() }).length, 0);
});

test('a dead or stale feed is a note, never a throw', async () => {
  const dead = await readFeed({ name: 'Dead', url: 'x' }, { get: async () => { throw new Error('HTTP 404'); } });
  assert.deepEqual(dead.items, []); assert.match(dead.note, /Dead: skipped \(HTTP 404\)/);
  const stale = await readFeed({ name: 'Stale', url: 'x' }, { now: NOW.getTime(), get: async () => rss([['Old', 'https://m.com/o', 'Tue, 23 Apr 2024 13:41:02 +0530']]) });
  assert.match(stale.note, /nothing in the last 24h \(newest 2024-04-23\)/);
});

test('dedupe by normalised URL and headline, across sections', async () => {
  assert.equal(normalizeUrl('https://www.CoinDesk.com/x/?utm_source=rss#top'), 'coindesk.com/x');
  assert.equal(cleanLink('https://c.com/n?utm_source=rss&id=3'), 'https://c.com/n?id=3');
  const seen = { urls: new Set(), titles: new Set() };
  assert.equal(dedupe([{ title: 'Nifty hits record high today', url: 'https://a.com/1' }, { title: 'NIFTY hits record high, today!', url: 'https://b.com/2' }], seen).length, 1);
  const feeds = {
    one: rss([['Sebi tightens F&O rules for retail traders', 'https://et.com/sebi?utm_source=x', h(1)], ['Gold steady', 'https://et.com/gold', h(2)]]),
    two: rss([['Sebi tightens F&O rules for retail traders', 'https://www.et.com/sebi', h(1)], ['Bitcoin rises', 'https://cd.com/btc', h(3)]]),
  };
  const sections = [{ key: 'finance', title: 'Finance', feeds: [{ name: 'One', url: 'one' }] }, { key: 'crypto', title: 'Crypto', feeds: [{ name: 'Two', url: 'two' }] }];
  const out = await collect({ now: NOW.getTime(), get: async (u) => feeds[u], sections });
  assert.deepEqual(out[1].items.map((i) => i.title), ['Bitcoin rises'], 'the Sebi story is listed once, in the first section');
  const body = buildBody(out, { now: NOW });
  assert.match(body, /## 1\. Finance\n- \[Sebi tightens F&O rules for retail traders\]\(https:\/\/et\.com\/sebi\) — One, 4 Oct 06:15 IST/);
});

test('skips if today\'s issue exists; otherwise ensures the label and creates the issue', async () => {
  const calls = [];
  const api = (existing) => async (method, path, body) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path.startsWith('/issues')) return { status: 200, json: existing ? [{ title: 'Daily news 2026-10-04', html_url: 'https://gh/i/9' }] : [{ title: 'Daily news 2026-10-03' }] };
    if (method === 'GET' && path === `/labels/${LABEL}`) return { status: 404, json: {} };
    if (method === 'POST' && path === '/labels') return { status: 201, json: {} };
    if (method === 'POST' && path === '/issues') { assert.equal(body.title, 'Daily news 2026-10-04'); assert.deepEqual(body.labels, [LABEL]); return { status: 201, json: { html_url: 'https://gh/i/10' } }; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  const log = () => {};
  const skipped = await run({ now: NOW, api: api(true), get: async () => rss([]), log });
  assert.equal(skipped.skipped, true);
  assert.ok(!calls.some((c) => c.startsWith('POST')));
  const made = await run({ now: NOW, api: api(false), get: async () => { throw new Error('down'); }, log });
  assert.equal(made.url, 'https://gh/i/10', 'every feed down still makes an issue (with notes)');
  assert.ok(calls.includes('POST /labels'));
});
