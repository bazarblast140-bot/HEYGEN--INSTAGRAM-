import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  coverStyle, freshPatterns, groundedSummary, hashtagBudget, hookFromCaption,
  isSundayIst, mergeTrends, patternFromMedia, trendPrompt, weekKey, weeklyReport,
} from '../pipeline/src/research/patterns.js';
import { collectResearch, permissionError } from '../pipeline/src/research/collect.js';
import { runResearch } from '../pipeline/research.js';

const media = {
  caption: 'Nifty 25000 ke neeche kyun aaya?\nSave karo\n#nifty50',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  like_count: 1000,
  comments_count: 200,
  timestamp: '2026-10-01T04:00:00+0000',
  permalink: 'https://www.instagram.com/reel/abc/',
};

test('a caption becomes a hook, a style, and an engagement rate', () => {
  const pattern = patternFromMedia(media, {
    followers: 100000, username: 'example', source: 'business_discovery', fetchedAt: '2026-10-01T05:30:00Z',
  });
  assert.equal(hookFromCaption(media.caption), 'Nifty 25000 ke neeche kyun aaya?');
  assert.equal(pattern.coverStyle, 'number');
  assert.equal(pattern.format, 'Reel');
  assert.equal(pattern.cta, 'save');
  assert.equal(pattern.hourIst, 9);
  assert.equal(pattern.engagementRate, 0.012);
  assert.deepEqual(pattern.hashtags, ['#nifty50']);
  assert.equal(coverStyle('Kya hoga kal?'), 'question');
});

test('the hashtag budget resets each IST week and stops at 30', () => {
  const now = new Date('2026-10-01T00:00:00Z');
  assert.equal(weekKey(now), '2026-09-28');
  const first = hashtagBudget({ hashtagSearch: { week: '2026-09-21', used: 30 } }, now);
  assert.equal(first.remaining, 30);
  const spent = hashtagBudget({ hashtagSearch: { week: '2026-09-28', used: 28 } }, now);
  assert.equal(spent.remaining, 2);
});

test('stale patterns are omitted from the prompt and the weekly file keeps permalinks', () => {
  const trends = {
    patterns: [
      { ...patternFromMedia(media, { followers: 10, username: 'a', source: 'business_discovery', fetchedAt: '2026-10-01T00:00:00Z' }) },
      {
        permalink: 'https://www.instagram.com/p/old/',
        timestamp: '2026-08-01T00:00:00Z',
        fetchedAt: '2026-08-01T00:00:00Z',
        hook: 'old hook',
        engagementRate: 0.5,
      },
    ],
  };
  const prompt = trendPrompt(trends, new Date('2026-10-03T00:00:00Z'));
  assert.match(prompt, /Nifty 25000/);
  assert.match(prompt, /Do not copy captions/);
  assert.equal(prompt.includes('old hook'), false);
  assert.equal(freshPatterns(trends, new Date('2026-10-20T00:00:00Z')).length, 0);
  const report = weeklyReport(trends, { date: '2026-10-04' });
  assert.match(report, /instagram.com\/reel\/abc/);
  assert.equal(groundedSummary('Engagement was 99% and 7 posts.', report), '');
  assert.match(groundedSummary('Seven days of public posts.', report), /Seven days/);
});

test('an unresolved handle and a permission error are skipped', async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('pranjalkamra')) {
      return json({
        business_discovery: {
          username: 'pranjalkamra',
          followers_count: 50000,
          media: { data: [media] },
        },
      });
    }
    if (text.includes('ig_hashtag_search')) return json({ data: [{ id: '1789' }] });
    if (text.includes('top_media')) return json({ data: [{ ...media, permalink: 'https://www.instagram.com/p/tag/' }] });
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Unsupported get request. Object does not exist', code: 100 } }),
    };
  };
  const notes = [];
  const result = await collectResearch({
    competitors: {
      accounts: [{ username: 'pranjalkamra' }, { username: 'missing_handle' }],
      hashtags: ['nifty50'],
    },
    token: 'test-token',
    igUserId: '1784',
    previous: { hashtagSearch: { week: '2026-09-28', used: 29 } },
    now: new Date('2026-10-01T00:00:00Z'),
    fetchImpl,
    onNote: (line) => notes.push(line),
  });
  assert.equal(result.patterns.length, 2);
  assert.equal(result.hashtagSearch.used, 30);
  assert.match(notes.join('\n'), /skip @missing_handle/);
  assert.equal(permissionError({ code: 190, message: 'token' }), true);

  const blocked = await collectResearch({
    competitors: { accounts: [], hashtags: ['nifty50', 'sensex'] },
    token: 'test-token',
    igUserId: '1784',
    previous: { hashtagSearch: { week: '2026-09-28', used: 0 } },
    now: new Date('2026-10-01T00:00:00Z'),
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Application does not have permission', code: 10 } }),
    }),
  });
  assert.equal(blocked.patterns.length, 0);
  assert.equal(blocked.hashtagSearch.used, 1);
  assert.match(blocked.notes.join('\n'), /permission/);
});

test('a missing token does not fail the run, and Sunday writes the report', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'research-'));
  const competitorsPath = path.join(dir, 'competitors.json');
  const trendsPath = path.join(dir, 'trends.json');
  await fs.writeFile(competitorsPath, JSON.stringify({
    accounts: [{ username: 'pranjalkamra', status: 'to-verify' }],
    hashtags: ['nifty50'],
  }));
  const quiet = await runResearch({
    now: new Date('2026-10-01T00:00:00Z'),
    competitorsPath,
    trendsPath,
    reportsDir: path.join(dir, 'reports'),
    token: '',
    igUserId: '',
    onNote() {},
  });
  assert.match(quiet.trends.notes.join('\n'), /missing/);
  assert.equal(quiet.reportPath, null);
  assert.equal(isSundayIst(new Date('2026-10-03T18:30:00Z')), true);

  const sunday = await runResearch({
    now: new Date('2026-10-03T18:30:00Z'),
    competitorsPath,
    trendsPath,
    reportsDir: path.join(dir, 'reports'),
    token: '',
    igUserId: '',
    onNote() {},
  });
  assert.match(sunday.reportPath, /weekly-2026-10-04\.md/);
  const markdown = await fs.readFile(sunday.reportPath, 'utf8');
  assert.match(markdown, /Weekly patterns 2026-10-04/);
});

test('merge keeps the newest copy of a permalink and drops a month-old post', () => {
  const merged = mergeTrends(
    { patterns: [{ permalink: 'https://ig/1', timestamp: '2026-09-20T00:00:00Z', hook: 'old copy' }] },
    {
      patterns: [
        { permalink: 'https://ig/1', timestamp: '2026-09-20T00:00:00Z', hook: 'new copy' },
        { permalink: 'https://ig/2', timestamp: '2026-08-01T00:00:00Z', hook: 'too old' },
      ],
      hashtagSearch: { week: '2026-09-28', used: 1 },
      notes: [],
    },
    new Date('2026-10-01T00:00:00Z'),
  );
  assert.equal(merged.patterns.length, 1);
  assert.equal(merged.patterns[0].hook, 'new copy');
});

function json(body) {
  return { ok: true, status: 200, json: async () => body };
}
