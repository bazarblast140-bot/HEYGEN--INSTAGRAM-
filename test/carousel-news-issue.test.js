// Carousel topic candidates from the daily news issue (label grok-news).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { parseDigest, pickIssue, storiesFor, digestStories, marketClosed, marketDayNote } from '../pipeline/src/carousel/news-issue.js';
import { buildUserPrompt } from '../pipeline/src/carousel/prompt.js';
import { buildSourcedPrompt } from '../pipeline/src/carousel/sourced-prompt.js';
import { selectFresh } from '../pipeline/src/carousel/sourced.js';

const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/daily-news-issue.json', import.meta.url), 'utf8'));
const NOW = new Date('2026-10-04T04:00:00Z').getTime(); // 09:30 IST, the ai slot
const issue = (title, created, extra = {}) => ({ number: 1, title, created_at: created, state: 'open', body: fixture.body, html_url: 'https://gh/i/1', ...extra });

test('parses the real Daily news issue into its five sections', () => {
  const s = parseDigest(fixture.body, { createdAt: fixture.createdAt });
  assert.deepEqual(Object.keys(s).sort(), ['ai', 'crypto', 'finance', 'mf', 'technical']);
  const ai = s.ai[0];
  assert.ok(ai.title && /^https:\/\//.test(ai.url));
  assert.ok(['TechCrunch', 'The Verge'].includes(ai.site), 'outlet name, not the feed label');
  assert.match(ai.date, /^2026-10-0[34]$/);
  assert.ok(ai.at <= new Date(fixture.createdAt).getTime());
  assert.ok(s.finance.every((x) => x.site), 'every story has an outlet');
});

test('slot → sections: AI + Crypto at 09:30, Mutual funds at 12:30, Finance + Technical at 16:45', () => {
  const s = { ai: [{ title: 'A', at: 1 }], finance: [{ title: 'F', at: 3 }], technical: [{ title: 'T', at: 2 }], mf: [{ title: 'M', at: 4 }], crypto: [{ title: 'C', at: 5 }] };
  assert.deepEqual(storiesFor('ai', s).map((x) => x.title), ['C', 'A']);
  assert.deepEqual(storiesFor('midday', s).map((x) => x.title), ['M']);
  assert.deepEqual(storiesFor('evening', s).map((x) => x.title), ['F', 'T']);
  assert.deepEqual(storiesFor('news', s), [], 'the old news slot is gone');
});

test('only the latest open Grok news / Daily news issue of today or yesterday (IST)', () => {
  const list = [
    issue('Daily news 2026-10-02', '2026-10-02T01:45:00Z', { number: 2 }),
    issue('Grok news 2026-10-03', '2026-10-03T02:00:00Z', { number: 3 }),
    issue('Daily news 2026-10-04', '2026-10-04T01:45:00Z', { number: 4 }),
    issue('Some other issue', '2026-10-04T03:00:00Z', { number: 5 }),
  ];
  assert.equal(pickIssue(list, NOW).number, 4);
  assert.equal(pickIssue(list.slice(0, 2), NOW).number, 3, 'yesterday is fine');
  assert.equal(pickIssue(list.slice(0, 1), NOW), null, 'two days old is not');
  assert.equal(pickIssue([issue('Daily news 2026-10-04', '2026-10-04T01:45:00Z', { state: 'closed' })], NOW), null);
  assert.equal(pickIssue([issue('Grok news update', '2026-10-03T20:00:00Z')], NOW)?.title, 'Grok news update', 'no date in the title → created_at (IST)');
});

test('digestStories: stories for the slot; null (usual source) when no issue, no token or an API error', async () => {
  const got = await digestStories({ slot: 'ai', now: NOW, repo: 'o/r', token: 't', list: async () => [issue('Daily news 2026-10-04', fixture.createdAt, { number: 39 })] });
  assert.equal(got.issue.number, 39);
  assert.ok(got.stories.length >= 3);
  assert.ok(selectFresh(got.stories, NOW).length >= 3, 'fresh enough for the sourced gate (48h)');
  assert.equal(await digestStories({ slot: 'ai', now: NOW, repo: 'o/r', token: 't', list: async () => [] }), null);
  assert.equal(await digestStories({ slot: 'ai', now: NOW, repo: 'o/r', token: '', list: async () => { throw new Error('x'); } }), null);
  assert.equal(await digestStories({ slot: 'ai', now: NOW, repo: 'o/r', token: 't', list: async () => { throw new Error('GitHub issues 403'); } }), null);
});

test('finance prompt gets the headlines as topic candidates, numbers still only from calc', () => {
  const headlines = [{ title: 'Tanvi Exports files for IPO', site: 'Livemint', date: '2026-10-03', url: 'https://livemint.com/x' }];
  const p = buildUserPrompt({ category: 'personal-finance', date: '2026-10-06', headlines });
  assert.match(p, /<todays_headlines>[\s\S]*Tanvi Exports files for IPO \(Livemint, 2026-10-03\) https:\/\/livemint\.com\/x/);
  assert.match(p, /सारे numbers सिर्फ़ example\/calc से/);
  assert.doesNotMatch(buildUserPrompt({ category: 'personal-finance', date: '2026-10-06' }), /todays_headlines/, 'no issue → unchanged prompt');
});

test('no "aaj" market claims on non-trading days (2 Oct holiday, weekends; 5 Oct trades)', () => {
  assert.equal(marketClosed('2026-10-02'), 'NSE holiday');
  assert.equal(marketClosed('2026-10-03'), 'weekend');
  assert.equal(marketClosed('2026-10-04'), 'weekend');
  assert.equal(marketClosed('2026-10-05'), null);
  assert.equal(marketDayNote('2026-10-05'), '');
  assert.match(buildUserPrompt({ category: 'personal-finance', date: '2026-10-04' }), /<market_day>[\s\S]*आज market/);
  assert.match(buildSourcedPrompt({ kind: 'ai', stories: [], date: '2026-10-04' }), /<market_day>/);
  assert.doesNotMatch(buildSourcedPrompt({ kind: 'ai', stories: [], date: '2026-10-05' }), /<market_day>/);
});
