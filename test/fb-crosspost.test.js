import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  enabled, crossPostCarousel, crossPostReel, whoami,
  alreadyCrossPosted, record, readLedger, istDay,
} from '../pipeline/src/publish/facebook.js';

function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const hit = routes.find(([re]) => re.test(u));
    const body = hit ? hit[1](u, init, calls) : { error: { message: 'no route' } };
    return { ok: !body.error, status: body.error ? 400 : 200, json: async () => body };
  };
  return { impl, calls };
}

test('off unless FB_CROSSPOST is exactly true', () => {
  assert.equal(enabled({}), false);
  assert.equal(enabled({ FB_CROSSPOST: 'false' }), false);
  assert.equal(enabled({ FB_CROSSPOST: 'true' }), true);
});

test('a carousel becomes unpublished photos attached to one feed post, in order', async () => {
  let n = 0;
  const { impl, calls } = fakeFetch([
    [/\/photos/, () => ({ id: `p${++n}` })],
    [/\/feed/, () => ({ id: 'PAGE_POST' })],
  ]);
  const out = await crossPostCarousel({ pageId: '1', token: 't', imageUrls: ['a', 'b', 'c'], caption: 'cap', fetchImpl: impl });
  assert.equal(out.id, 'PAGE_POST');
  const feed = calls.at(-1).init.body;
  assert.equal(feed.get('message'), 'cap');
  assert.equal(JSON.parse(feed.get('attached_media[0]')).media_fbid, 'p1');
  assert.equal(JSON.parse(feed.get('attached_media[2]')).media_fbid, 'p3');
  assert.equal(calls.filter((c) => /photos/.test(c.url)).every((c) => c.init.body.get('published') === 'false'), true);
});

test('a reel goes start, hosted-URL upload, finish as PUBLISHED with the caption', async () => {
  const { impl, calls } = fakeFetch([
    [/rupload/, () => ({ success: true })],
    [/video_reels/, (u, init) => (init.body.get('upload_phase') === 'start'
      ? { video_id: 'V1', upload_url: 'https://rupload.facebook.com/x/V1' } : { success: true })],
  ]);
  const out = await crossPostReel({ pageId: '1', token: 't', videoUrl: 'https://h/reel.mp4', caption: 'cap', fetchImpl: impl });
  assert.equal(out.id, 'V1');
  assert.equal(calls[1].init.headers.file_url, 'https://h/reel.mp4');
  const fin = calls[2].init.body;
  assert.equal(fin.get('upload_phase'), 'finish');
  assert.equal(fin.get('video_state'), 'PUBLISHED');
  assert.equal(fin.get('description'), 'cap');
});

test('a failed upload throws, so the CLI can soft-fail it', async () => {
  const { impl } = fakeFetch([
    [/rupload/, () => ({ error: { message: 'cannot fetch' } })],
    [/video_reels/, () => ({ video_id: 'V1' })],
  ]);
  await assert.rejects(() => crossPostReel({ pageId: '1', token: 't', videoUrl: 'u', fetchImpl: impl }), /cannot fetch/);
});

test('the ledger stops a second copy of the same Instagram media id', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fb-')), 'l.json');
  assert.deepEqual(readLedger(file), []);
  record(file, { date: istDay(), kind: 'reel', igMediaId: '42', fbId: 'V1' });
  assert.equal(alreadyCrossPosted(readLedger(file), '42'), true);
  assert.equal(alreadyCrossPosted(readLedger(file), '43'), false);
});

test('whoami names the missing permissions without exposing the token', async () => {
  const { impl } = fakeFetch([
    [/debug_token/, () => ({ data: { type: 'PAGE', scopes: ['pages_read_engagement'] } })],
    [/\/me\?/, () => ({ id: '9', name: 'Page' })],
  ]);
  const w = await whoami({ token: 'SECRET', pageId: '9', fetchImpl: impl });
  assert.equal(w.name, 'Page');
  assert.deepEqual(w.missing, ['pages_manage_posts']);
  assert.equal(JSON.stringify(w).includes('SECRET'), false);
});
