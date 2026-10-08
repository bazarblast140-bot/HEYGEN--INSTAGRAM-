// Facebook Page Story after every IG Story (carousel: photo story; Reel
// companion: video story). All Graph calls here go to a mocked fetch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  postPhotoStory, postVideoStory, fbStory, isMetaCdn, explainFbError, readStoryLedger, mergeStoryLedger, storyBlocked,
} from '../pipeline/src/publish/fb-story.js';
import { postCarouselStories } from '../pipeline/fb-story.js';
import { runCompanion, readCompanion } from '../pipeline/src/publish/companion.js';

const PAGE = '1362385786947916';
const TOKEN = 'FBPAGETOKEN-secret-789';
const ENV = { FB_CROSSPOST: 'true', FB_PAGE_ID: PAGE, FB_PAGE_TOKEN: TOKEN };
const IMG = 'https://github.com/o/r/releases/download/carousel-2026-10-08-1/story-1.jpg';
const VID = 'https://github.com/o/r/releases/download/companion-media/ig-18000000000000001-story.mp4';
const NOW = Date.parse('2026-10-08T11:30:00Z');

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** A fetch mock: `routes` maps a path fragment to a response (or a function). Records every call. */
function mockFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    calls.push({ url: u, method: init.method || 'GET', body, headers: init.headers || {} });
    const key = Object.keys(routes).find((k) => u.includes(k) && (!routes[k].when || routes[k].when(body)));
    if (!key) throw new Error(`unexpected fetch ${u}`);
    const r = routes[key];
    const out = typeof r.res === 'function' ? r.res(body, u) : r.res;
    if (out instanceof Error) throw out;
    return out;
  };
  return { fetchImpl, calls };
}

function ledgerFile(rows = []) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fbstory-')), 'fb-story-history.json');
  fs.writeFileSync(f, JSON.stringify(rows));
  return f;
}

const photoRoutes = () => ({
  [`${PAGE}/photos`]: { res: json(200, { id: 'PHOTO1' }) },
  [`${PAGE}/photo_stories`]: { res: json(200, { success: true, post_id: 'STORY_P1' }) },
});
const videoRoutes = () => ({
  [`${PAGE}/video_stories`]: { res: (b) => (b.upload_phase === 'start'
    ? json(200, { video_id: 'VID1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/VID1' })
    : json(200, { success: true, post_id: 'STORY_V1' })) },
  'rupload.facebook.com': { res: json(200, { success: true }) },
});

test('photo story: unpublished photo from the re-hosted URL, then photo_stories with its id', async () => {
  const { fetchImpl, calls } = mockFetch(photoRoutes());
  const id = await postPhotoStory({ pageId: PAGE, token: TOKEN, imageUrl: IMG, fetchImpl });
  assert.equal(id, 'STORY_P1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, new RegExp(`/${PAGE}/photos$`));
  assert.deepEqual({ url: calls[0].body.url, published: calls[0].body.published }, { url: IMG, published: 'false' });
  assert.match(calls[1].url, new RegExp(`/${PAGE}/photo_stories$`));
  assert.equal(calls[1].body.photo_id, 'PHOTO1');
  assert.equal(calls[1].body.access_token, TOKEN);
});

test('video story: start, upload with file_url = the re-hosted URL, finish with the video id', async () => {
  const { fetchImpl, calls } = mockFetch(videoRoutes());
  const stages = [];
  const id = await postVideoStory({ pageId: PAGE, token: TOKEN, videoUrl: VID, fetchImpl, onStage: (s) => stages.push(s) });
  assert.equal(id, 'STORY_V1');
  assert.deepEqual(stages, ['start', 'upload', 'publish']);
  assert.equal(calls[0].body.upload_phase, 'start');
  assert.match(calls[1].url, /rupload\.facebook\.com\/video-upload\/v23\.0\/VID1/);
  assert.equal(calls[1].headers.file_url, VID);
  assert.equal(calls[1].headers.Authorization, `OAuth ${TOKEN}`);
  assert.deepEqual({ phase: calls[2].body.upload_phase, id: calls[2].body.video_id }, { phase: 'finish', id: 'VID1' });
});

test('a Meta CDN URL is never handed to Graph', async () => {
  assert.equal(isMetaCdn('https://scontent.cdninstagram.com/v/x.mp4'), true);
  assert.equal(isMetaCdn('https://video.xx.fbcdn.net/v/x.mp4'), true);
  assert.equal(isMetaCdn(VID), false);
  const { fetchImpl, calls } = mockFetch({});
  await assert.rejects(postVideoStory({ pageId: PAGE, token: TOKEN, videoUrl: 'https://video.xx.fbcdn.net/v/x.mp4', fetchImpl }), /Meta CDN/);
  const file = ledgerFile();
  const r = await fbStory({ kind: 'video', igStoryId: '1790001', url: 'https://scontent.cdninstagram.com/v/x.mp4', env: ENV, file, fetchImpl, log: () => {} });
  assert.equal(r.state, 'skipped');
  assert.equal(calls.length, 0);
});

test('off unless FB_CROSSPOST=true with FB_PAGE_ID and the FB_PAGE_TOKEN secret (no IG-token fallback)', async () => {
  const { fetchImpl, calls } = mockFetch(photoRoutes());
  const file = ledgerFile();
  const args = { kind: 'photo', igStoryId: '1790001', url: IMG, file, fetchImpl, log: () => {} };
  assert.equal((await fbStory({ ...args, env: { ...ENV, FB_CROSSPOST: 'false' } })).state, 'skipped');
  assert.equal((await fbStory({ ...args, env: { FB_CROSSPOST: 'true', FB_PAGE_ID: PAGE, IG_ACCESS_TOKEN: 'ig' } })).state, 'skipped');
  assert.equal((await fbStory({ ...args, env: { FB_CROSSPOST: 'true', FB_PAGE_TOKEN: TOKEN } })).state, 'skipped');
  assert.equal(calls.length, 0);
  assert.deepEqual(readStoryLedger(file), []);
});

test('ledger: one FB Story per IG Story — a second call for the same IG Story posts nothing', async () => {
  const { fetchImpl, calls } = mockFetch(photoRoutes());
  const file = ledgerFile();
  const args = { kind: 'photo', igStoryId: '1790001', igMediaId: '1801', url: IMG, source: 'carousel', env: ENV, file, fetchImpl, now: NOW, log: () => {} };
  const first = await fbStory(args);
  assert.deepEqual(first, { state: 'done', fbStoryId: 'STORY_P1' });
  const second = await fbStory(args);
  assert.equal(second.state, 'skipped');
  assert.equal(calls.length, 2, 'only the first call reached Graph');
  const rows = readStoryLedger(file);
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    date: '2026-10-08', igStoryId: '1790001', igMediaId: '1801', kind: 'photo', source: 'carousel', at: new Date(NOW).toISOString(), state: 'done', fbStoryId: 'STORY_P1',
  });
});

test('a Graph error is logged clearly (message, code, fbtrace, hint), recorded, and never thrown', async () => {
  const err = { error: { message: '(#200) Permissions error', type: 'OAuthException', code: 200, fbtrace_id: 'TRACE1' } };
  const { fetchImpl } = mockFetch({ [`${PAGE}/photos`]: { res: json(403, err) } });
  const file = ledgerFile();
  const lines = [];
  const r = await fbStory({ kind: 'photo', igStoryId: '1790002', url: IMG, env: ENV, file, fetchImpl, log: (l) => lines.push(l) });
  assert.equal(r.state, 'failed');
  const line = lines.join('\n');
  assert.match(line, /Facebook photo story FAILED at photo/);
  assert.match(line, /Permissions error · code 200 · OAuthException · fbtrace TRACE1 · HTTP 403/);
  assert.match(line, /pages_manage_posts/);
  assert.doesNotMatch(line, new RegExp(TOKEN));
  assert.equal(readStoryLedger(file)[0].state, 'failed');
  assert.equal(storyBlocked(readStoryLedger(file), '1790002'), null, 'a failed attempt posted nothing; it does not block');
  assert.match(explainFbError(Object.assign(new Error('x'), { details: { error: { message: 'bad token', code: 190 } } })), /invalid or expired/);
});

test('a lost response on the final publish call is "uncertain" and never retried', async () => {
  const routes = videoRoutes();
  routes[`${PAGE}/video_stories`] = { res: (b) => (b.upload_phase === 'start'
    ? json(200, { video_id: 'VID1', upload_url: 'https://rupload.facebook.com/video-upload/v23.0/VID1' })
    : new TypeError('fetch failed')) };
  const { fetchImpl, calls } = mockFetch(routes);
  const file = ledgerFile();
  const r = await fbStory({ kind: 'video', igStoryId: '1790003', url: VID, env: ENV, file, fetchImpl, log: () => {} });
  assert.equal(r.state, 'uncertain');
  const before = calls.length;
  assert.equal((await fbStory({ kind: 'video', igStoryId: '1790003', url: VID, env: ENV, file, fetchImpl, log: () => {} })).state, 'skipped');
  assert.equal(calls.length, before);
});

test('a network error before anything was created is a plain failure, still not thrown', async () => {
  const { fetchImpl } = mockFetch({ [`${PAGE}/photos`]: { res: new TypeError('fetch failed') } });
  const r = await fbStory({ kind: 'photo', igStoryId: '1790004', url: IMG, env: ENV, file: ledgerFile(), fetchImpl, log: () => {} });
  assert.equal(r.state, 'failed');
});

test('ledger merge keeps every carousel frame and lets a done row win over a failed one', () => {
  const a = [{ igStoryId: '1', igMediaId: 'P', state: 'failed' }, { igStoryId: '2', igMediaId: 'P', state: 'done' }];
  const b = [{ igStoryId: '1', igMediaId: 'P', state: 'done' }, { igStoryId: '3', igMediaId: 'P', state: 'done' }];
  const m = mergeStoryLedger(a, b);
  assert.deepEqual(m.map((r) => [r.igStoryId, r.state]), [['1', 'done'], ['2', 'done'], ['3', 'done']]);
});

test('carousel: each IG Story frame the publish step posted becomes one FB photo story', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stories-'));
  const storiesFile = path.join(dir, 'stories.json');
  fs.writeFileSync(storiesFile, JSON.stringify({ igMediaId: '1801', stories: [{ igStoryId: '1790011', imageUrl: IMG }, { igStoryId: '1790012', imageUrl: IMG.replace('story-1', 'story-2') }] }));
  let n = 0;
  const { fetchImpl, calls } = mockFetch({
    [`${PAGE}/photos`]: { res: () => json(200, { id: `PHOTO${++n}` }) },
    [`${PAGE}/photo_stories`]: { res: (b) => json(200, { success: true, post_id: `S_${b.photo_id}` }) },
  });
  const file = ledgerFile();
  const out = await postCarouselStories({ storiesFile, env: ENV, file, fetchImpl, log: () => {}, now: NOW });
  assert.deepEqual(out.map((r) => r.state), ['done', 'done']);
  assert.equal(calls.filter((c) => c.url.endsWith('/photo_stories')).length, 2);
  assert.deepEqual(readStoryLedger(file).map((r) => [r.igStoryId, r.igMediaId, r.kind]), [['1790011', '1801', 'photo'], ['1790012', '1801', 'photo']]);
  // Re-running the step (same stories.json) posts nothing new.
  const again = await postCarouselStories({ storiesFile, env: ENV, file, fetchImpl, log: () => {}, now: NOW });
  assert.deepEqual(again.map((r) => r.state), ['skipped', 'skipped']);
  // No IG Story this run → nothing.
  assert.deepEqual(await postCarouselStories({ storiesFile: path.join(dir, 'none.json'), env: ENV, file, fetchImpl, log: () => {} }), []);
});

// ---------------------------------------------------------------- Reel companion

const PAISE = {
  id: '18000000000000001', media_type: 'VIDEO', media_product_type: 'REELS',
  timestamp: '2026-10-08T03:01:00+0000', permalink: 'https://www.instagram.com/reel/AAA/',
  media_url: 'https://scontent.cdninstagram.com/v/paise1.mp4', caption: 'SIP\n\npkp:video:KVmMkKG5gzk',
};
const CENV = { ...ENV, ENABLE_REEL_COMPANION: 'true', IG_USER_ID: '1784', IG_ACCESS_TOKEN: 'IGTOKEN-secret-123', GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 't' };

function companionFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-fbs-'));
  const files = {
    companion: path.join(dir, 'c.json'), fb: path.join(dir, 'fb.json'), own: path.join(dir, 'own.json'), fbStory: path.join(dir, 'fb-story-history.json'),
  };
  fs.writeFileSync(files.companion, JSON.stringify({ entries: [] }));
  fs.writeFileSync(files.fb, '[]');
  fs.writeFileSync(files.own, JSON.stringify({ entries: [] }));
  fs.writeFileSync(files.fbStory, '[]');
  return files;
}

function companionApi(fetchImpl) {
  const calls = { story: [], fbReel: 0 };
  return {
    calls,
    api: {
      async listMedia() { return { ok: true, items: [PAISE], reason: 'ok' }; },
      async probeVideo() { return true; },
      async releaseVideo() { return ''; },
      async rehostVideo() { return 'https://github.com/o/r/releases/download/companion-media/ig-18000000000000001.mp4'; },
      async storyVideo({ id }) { return { url: `https://github.com/o/r/releases/download/companion-media/ig-${id}-story.mp4`, from: 'story-copy (1.077x)' }; },
      async postStory({ onStage }) { calls.story.push(1); onStage?.('publish'); return '17900000000000001'; },
      async postFbReel({ onStage }) { calls.fbReel += 1; onStage?.('finish'); return { id: 'R1', url: 'https://www.facebook.com/reel/R1' }; },
      async fbStory(args) { return fbStory({ ...args, fetchImpl }); },
    },
  };
}

test('companion: after the IG Story, the same (re-hosted, ≤60 s) video goes up as an FB Page video story', async () => {
  const { fetchImpl, calls } = mockFetch(videoRoutes());
  const files = companionFiles();
  const { api } = companionApi(fetchImpl);
  const out = await runCompanion({ env: CENV, api, now: NOW, files, log: () => {} });
  assert.equal(out.stories.length, 1);
  assert.deepEqual(out.fbStories.map((s) => [s.igStoryId, s.state, s.fbStoryId]), [['17900000000000001', 'done', 'STORY_V1']]);
  const upload = calls.find((c) => c.url.includes('rupload'));
  assert.equal(upload.headers.file_url, 'https://github.com/o/r/releases/download/companion-media/ig-18000000000000001-story.mp4');
  assert.equal(readStoryLedger(files.fbStory)[0].source, 'reel-companion');
  // A second run does nothing new (IG Story done → no FB Story attempt either).
  const before = calls.length;
  await runCompanion({ env: CENV, api, now: NOW + 3600000, files, log: () => {} });
  assert.equal(calls.length, before);
});

test('companion: an FB Story failure never marks the IG Story failed and never stops the FB Reel', async () => {
  const { fetchImpl } = mockFetch({ [`${PAGE}/video_stories`]: { res: json(400, { error: { message: 'Unsupported post request', code: 100, fbtrace_id: 'T9' } }) } });
  const files = companionFiles();
  const { api, calls } = companionApi(fetchImpl);
  const lines = [];
  const out = await runCompanion({ env: CENV, api, now: NOW, files, log: (l) => lines.push(l) });
  assert.equal(readCompanion(files.companion)[0].story.state, 'done');
  assert.equal(calls.fbReel, 1);
  assert.equal(out.fb.length, 1);
  assert.equal(out.fbStories[0].state, 'failed');
  assert.ok(lines.some((l) => /Facebook video story FAILED at start: Unsupported post request · code 100 · fbtrace T9/.test(l)));
  assert.deepEqual(out.failures, []);
});

test('companion: a crashing FB Story helper is contained too', async () => {
  const files = companionFiles();
  const { api, calls } = companionApi(null);
  api.fbStory = async () => { throw new Error('boom'); };
  const out = await runCompanion({ env: CENV, api, now: NOW, files, log: () => {} });
  assert.equal(readCompanion(files.companion)[0].story.state, 'done');
  assert.equal(calls.fbReel, 1);
  assert.deepEqual(out.failures, []);
});

test('companion: FB_CROSSPOST off → no FB Story call', async () => {
  const { fetchImpl, calls } = mockFetch(videoRoutes());
  const files = companionFiles();
  const { api } = companionApi(fetchImpl);
  await runCompanion({ env: { ...CENV, FB_CROSSPOST: 'false' }, api, now: NOW, files, log: () => {} });
  assert.equal(calls.length, 0);
  assert.deepEqual(readStoryLedger(files.fbStory), []);
});

// ---------------------------------------------------------------- wiring

test('workflows: FB Story step after the FB copy, never fails the job, commits its ledger; nothing backfilled', () => {
  const wf = fs.readFileSync('.github/workflows/carousel.yml', 'utf8');
  const at = (name) => wf.indexOf(`- name: ${name}`);
  const step = wf.slice(at('Story to the Facebook Page')).split('\n      - ')[0];
  assert.ok(at('Publish to Instagram') < at('Copy to the Facebook Page') && at('Copy to the Facebook Page') < at('Story to the Facebook Page'));
  assert.match(step, /if: \$\{\{ always\(\) && steps\.publish\.outcome == 'success' && vars\.FB_CROSSPOST == 'true' \}\}/);
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /FB_PAGE_TOKEN: \$\{\{ secrets\.FB_PAGE_TOKEN \}\}/);
  assert.doesNotMatch(step, /IG_ACCESS_TOKEN/);
  assert.match(step, /node pipeline\/fb-story\.js --stories pipeline\/out\/stories\.json/);
  assert.match(step, /GITHUB_STEP_SUMMARY/);
  assert.match(step, /git add pipeline\/fb-story-history\.json/);
  const comp = fs.readFileSync('.github/workflows/reel-companion.yml', 'utf8');
  assert.match(comp, /git add .*pipeline\/fb-story-history\.json/);
  const script = fs.readFileSync('pipeline/reel-companion.js', 'utf8');
  assert.match(script, /files: \[COMPANION_LEDGER, FB_LEDGER, FB_STORY_LEDGER\]/);
  const pub = fs.readFileSync('pipeline/publish-carousel.js', 'utf8');
  assert.match(pub, /'stories\.json'/);
  // Started empty on 7 Oct (no backfill): every row is a live story from then on.
  const ledger = JSON.parse(fs.readFileSync('pipeline/fb-story-history.json', 'utf8'));
  assert.ok(Array.isArray(ledger));
  for (const row of ledger) {
    assert.ok(row.date >= '2026-10-07', `no backfilled row: ${row.date}`);
    assert.ok(row.igStoryId && row.state);
  }
});
