import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildReport, toMarkdown, mediaInsights, graphError } from '../pipeline/src/insights/report.js';

const NOW = Date.parse('2026-10-08T09:00:00Z');
const ENV = { IG_USER_ID: '1784', IG_ACCESS_TOKEN: 'IGTOK-secret', FB_PAGE_ID: '1362', FB_PAGE_TOKEN: 'FBTOK-secret' };
const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
const PERM = { error: { message: '(#10) Application does not have permission for this action', type: 'OAuthException', code: 10, fbtrace_id: 'X' } };

function mock(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: new URL(url), method: init?.method });
    return handler(new URL(url));
  };
  return { fetchImpl, calls };
}

const media = {
  data: [
    { id: 'M1', timestamp: '2026-10-08T07:39:00+0000', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', caption: 'Expense ratio\n...', permalink: 'p1', like_count: 2, comments_count: 0 },
    { id: 'M2', timestamp: '2026-10-07T12:00:00+0000', media_type: 'VIDEO', media_product_type: 'REELS', caption: 'Reel', permalink: 'p2', like_count: 1, comments_count: 1 },
    { id: 'OLD', timestamp: '2026-09-20T12:00:00+0000', media_type: 'IMAGE', caption: 'old', like_count: 9 },
  ],
};

function base(u, igInsights) {
  const p = u.pathname.replace('/v23.0/', '');
  if (p === 'debug_token') return json(200, { data: { type: 'PAGE', scopes: ['instagram_basic'], is_valid: true } });
  if (p === '1784') return json(200, { username: 'rajesh_technical_trader', followers_count: 100, media_count: 428 });
  if (p === '1784/media') return json(200, media);
  if (p.endsWith('/insights') && p.startsWith('M')) return igInsights(u, p);
  if (p === '1362/posts') return json(200, { data: [{ id: '1362_1', created_time: '2026-10-08T07:40:00+0000', message: 'FB copy', permalink_url: 'f1', reactions: { summary: { total_count: 3 } }, comments: { summary: { total_count: 0 } } }] });
  if (p === '1362_1/insights') return json(200, { data: [{ name: u.searchParams.get('metric'), values: [{ value: 7 }] }] });
  throw new Error(`unexpected ${p}`);
}

test('only GET requests, only the last N days, public counts kept when insights are refused, exact error reported', async () => {
  const { fetchImpl, calls } = mock((u) => base(u, () => json(400, PERM)));
  const r = await buildReport({ env: ENV, fetchImpl, now: NOW, days: 14 });
  assert.ok(calls.every((c) => c.method === 'GET'));
  assert.deepEqual(r.ig.map((m) => m.id), ['M1', 'M2']);
  assert.equal(r.insightsSource, null);
  assert.match(r.insightsError.IG_ACCESS_TOKEN, /does not have permission .* code 10 · OAuthException · HTTP 400/);
  assert.ok(r.insightsError.FB_PAGE_TOKEN, 'the Page token was tried once as well');
  const insightCalls = calls.filter((c) => c.url.pathname.endsWith('/insights') && c.url.pathname.includes('/M'));
  assert.equal(insightCalls.length, 2, 'stops asking after both tokens were refused');
  const md = toMarkdown(r);
  assert.match(md, /Insights unavailable — Graph refused/);
  assert.match(md, /\| 2026-10-08 \| 13:09 \| CAROUSEL_ALBUM \| n\/a \| n\/a \| 2 \| n\/a/);
  assert.doesNotMatch(md + JSON.stringify(r), /IGTOK-secret|FBTOK-secret/);
  assert.equal(r.fb.posts[0].reactions, 3);
  assert.equal(r.fb.posts[0].metrics.post_impressions_unique, 7);
});

test('insights read: unsupported metric for a Reel is retried one by one', async () => {
  const { fetchImpl } = mock((u) => base(u, (url, p) => {
    const metric = url.searchParams.get('metric');
    if (p.startsWith('M2') && metric.includes(',')) return json(400, { error: { message: 'metric[5] must be one of ...', code: 100 } });
    if (p.startsWith('M2') && (metric === 'follows' || metric === 'profile_visits')) return json(400, { error: { message: 'not supported', code: 100 } });
    return json(200, { data: metric.split(',').map((name, i) => ({ name, values: [{ value: i + 1 }] })) });
  }));
  const r = await buildReport({ env: ENV, fetchImpl, now: NOW });
  assert.equal(r.insightsSource, 'IG_ACCESS_TOKEN');
  assert.equal(r.ig[0].metrics.reach, 1);
  assert.equal(r.ig[1].metrics.reach, 1);
  assert.equal(r.ig[1].metrics.follows, undefined);
  assert.match(r.ig[1].errors.follows, /not supported · code 100/);
});

test('Page token used for insights when the IG token lacks the grant', async () => {
  const { fetchImpl } = mock((u) => base(u, (url) => (url.searchParams.get('access_token') === 'IGTOK-secret'
    ? json(403, PERM) : json(200, { data: [{ name: 'reach', values: [{ value: 42 }] }] }))));
  const r = await buildReport({ env: ENV, fetchImpl, now: NOW });
  assert.equal(r.insightsSource, 'FB_PAGE_TOKEN');
  assert.equal(r.ig[0].metrics.reach, 42);
});

test('graphError hides tokens; mediaInsights never throws', async () => {
  assert.doesNotMatch(graphError(new Error('bad url ?access_token=abc123&x=1')), /abc123/);
  const r = await mediaInsights('M1', { token: 't', fetchImpl: async () => { throw Object.assign(new Error('boom'), {}); }, metrics: ['reach'] });
  assert.match(r.errors.reach, /boom/);
});

test('workflow is manual, read-only and never touches a publishing script', () => {
  const wf = fs.readFileSync('.github/workflows/insights.yml', 'utf8');
  assert.match(wf, /on:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(wf, /schedule:|cron/);
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.doesNotMatch(wf, /publish|crosspost|fb-story|git push|git commit/);
  const src = fs.readFileSync('pipeline/src/insights/report.js', 'utf8');
  assert.doesNotMatch(src, /method: 'POST'|method: "POST"|DELETE/);
});

test('Facebook: a refused comments field falls back to fewer fields and says so', async () => {
  const { fetchImpl } = mock((u) => {
    const p = u.pathname.replace('/v23.0/', '');
    if (p === '1362/posts' && u.searchParams.get('fields').includes('comments')) {
      return json(400, { error: { message: "(#10) This endpoint requires the 'pages_read_user_content' permission", code: 10 } });
    }
    return base(u, () => json(400, PERM));
  });
  const r = await buildReport({ env: ENV, fetchImpl, now: NOW });
  assert.equal(r.fb.error, null);
  assert.equal(r.fb.posts[0].reactions, 3);
  assert.match(r.fb.fieldErrors[0], /pages_read_user_content/);
  assert.match(toMarkdown(r), /Facebook fields refused/);
});
