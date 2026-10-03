import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runCompanion, planCompanion, fbCaption, readCompanion, readFbLedger, mergeCompanion,
  ownReason, markerOf, redact, MAX_TRIES, SOURCE,
} from '../pipeline/src/publish/companion.js';
import { BROKER_CTA, hasBioCta } from '../pipeline/src/publish/cta.js';
import { ENGAGEMENT } from '../pipeline/src/publish/caption.js';

const NOW = Date.parse('2026-10-03T12:00:00Z'); // 17:30 IST

const PAISE = {
  id: '18000000000000001',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  timestamp: '2026-10-03T03:01:00+0000', // 08:31 IST
  permalink: 'https://www.instagram.com/reel/AAA/',
  media_url: 'https://scontent.cdninstagram.com/v/paise1.mp4',
  caption: 'SIP ka jaadu\n\nयह सिर्फ़ शिक्षा के लिए है — निवेश सलाह नहीं।\n\n#sip #nifty50\n\npkp:sip-magic:abc123',
};
const PAISE_WITH_CTA = {
  ...PAISE,
  id: '18000000000000002',
  timestamp: '2026-10-03T10:31:00+0000',
  caption: 'Demat / invest account chahiye ho to profile bio me link dekho. यह referral link है।\n\npkp:x:1',
};
const OWN = {
  id: '17980532652088741',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  timestamp: '2026-10-03T03:02:18+0000',
  caption: `Own reel\n\n${ENGAGEMENT}\n\n#nifty50`,
  media_url: 'https://scontent.cdninstagram.com/v/own.mp4',
};
const CAROUSEL = { id: '18000000000000009', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-03T07:00:00+0000' };
const OLD = { ...PAISE, id: '18000000000000003', timestamp: '2026-10-01T03:00:00+0000' };

const ENV = {
  ENABLE_REEL_COMPANION: 'true',
  IG_USER_ID: '17841410293109609',
  IG_ACCESS_TOKEN: 'IGTOKEN-secret-value-123',
  IG_SURFACE: 'facebook',
  FB_CROSSPOST: 'true',
  FB_PAGE_ID: '1362385786947916',
  FB_PAGE_TOKEN: 'FBTOKEN-secret-value-456',
};

function tmpFiles({ own = [], fb = [], companion = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-'));
  const files = {
    companion: path.join(dir, 'reel-companion-history.json'),
    fb: path.join(dir, 'fb-crosspost-history.json'),
    own: path.join(dir, 'reel-publish-history.json'),
  };
  fs.writeFileSync(files.companion, JSON.stringify({ entries: companion }));
  fs.writeFileSync(files.fb, JSON.stringify(fb));
  fs.writeFileSync(files.own, JSON.stringify({ entries: own }));
  return files;
}

function fakeApi({ media = [PAISE], storyFails = null, fbFails = null, probe = () => true, release = '' } = {}) {
  const calls = { story: [], fb: [], probe: [], release: 0 };
  let n = 0;
  return {
    calls,
    api: {
      async listMedia() { return { ok: true, items: media, reason: 'ok' }; },
      async probeVideo(url) { calls.probe.push(url); return probe(url); },
      async releaseVideo() { calls.release += 1; return release; },
      async rehostVideo({ sourceUrl }) { calls.rehost = (calls.rehost || 0) + 1; return sourceUrl ? `https://github.com/x/y/releases/download/companion-media/ig.mp4` : ''; },
      async postStory({ videoUrl, onStage }) {
        calls.story.push(videoUrl);
        if (storyFails) { onStage?.(storyFails.stage || 'container'); throw storyFails.error; }
        onStage?.('publish');
        n += 1;
        return `1790000000000000${n}`;
      },
      async postFbReel({ caption, videoUrl, onStage }) {
        calls.fb.push({ caption, videoUrl });
        if (fbFails) { onStage?.(fbFails.stage || 'upload'); throw fbFails.error; }
        onStage?.('finish');
        n += 1;
        return { id: `99000${n}`, url: `https://www.facebook.com/reel/99000${n}` };
      },
    },
  };
}

const quiet = () => {};

test('a Paise Reel gets one Story and one Facebook Reel, recorded on both ledgers', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 1);
  assert.equal(calls.fb.length, 1);
  assert.match(calls.story[0], /companion-media/); // re-hosted, never the Meta CDN url
  assert.equal(out.stories[0].igMediaId, PAISE.id);
  const entry = readCompanion(files.companion).find((e) => e.igMediaId === PAISE.id);
  assert.equal(entry.story.state, 'done');
  assert.equal(entry.fb.state, 'done');
  assert.equal(entry.marker, 'pkp:sip-magic:abc123');
  const fb = readFbLedger(files.fb);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].igMediaId, PAISE.id);
  assert.equal(fb[0].source, SOURCE);
  assert.match(calls.fb[0].caption, /link in bio\.$/);
  assert.ok(calls.fb[0].caption.startsWith('SIP ka jaadu'));
});

test('two runs over the same media never post twice', async () => {
  const files = tmpFiles();
  const first = fakeApi();
  await runCompanion({ env: ENV, api: first.api, now: NOW, files, log: quiet });
  const second = fakeApi();
  const out = await runCompanion({ env: ENV, api: second.api, now: NOW + 3600e3, files, log: quiet });
  assert.equal(second.calls.story.length, 0);
  assert.equal(second.calls.fb.length, 0);
  assert.equal(out.plan[0].action, 'skip');
  assert.equal(readFbLedger(files.fb).length, 1);
});

test('an overlapping run that recorded the Story first is respected (ledger re-read before each post)', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  let synced = 0;
  // Between planning and posting another run finishes and its ledger lands.
  const sync = async () => {
    synced += 1;
    if (synced === 1) {
      const other = { igMediaId: PAISE.id, story: { state: 'done', id: '1799', tries: 1 }, fb: null };
      fs.writeFileSync(files.companion, JSON.stringify({ entries: [other] }));
      fs.writeFileSync(files.fb, JSON.stringify([{ igMediaId: PAISE.id, fbId: '42', kind: 'reel', source: SOURCE }]));
    }
  };
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet, sync });
  assert.equal(calls.story.length, 0);
  assert.equal(calls.fb.length, 0);
  assert.equal(readCompanion(files.companion)[0].story.id, '1799');
});

test('merging two ledgers keeps the stronger result per media id', () => {
  const a = [{ igMediaId: '1', story: { state: 'failed', tries: 1 }, fb: { state: 'done', id: 'F' } }];
  const b = [{ igMediaId: '1', story: { state: 'done', id: 'S' }, fb: { state: 'failed', tries: 2 } }];
  const [m] = mergeCompanion(a, b);
  assert.equal(m.story.id, 'S');
  assert.equal(m.fb.id, 'F');
});

test('own Reels are skipped: publish ledger, own FB cross-post, or own caption CTA', async () => {
  const files = tmpFiles({
    own: [{ date: '2026-10-03', mediaId: OWN.id }],
    fb: [{ date: '2026-10-03', kind: 'reel', igMediaId: '18000000000000005', fbId: '1' }],
  });
  const ownCrossPosted = { ...PAISE, id: '18000000000000005', caption: 'x' };
  const ownByCaption = { ...OWN, id: '18000000000000006' };
  const { api, calls } = fakeApi({ media: [OWN, ownCrossPosted, ownByCaption, CAROUSEL, OLD] });
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 0);
  assert.equal(calls.fb.length, 0);
  assert.equal(out.plan.length, 3, 'carousel and >36h-old Reel are not even listed');
  for (const p of out.plan) assert.match(p.reason, /own Reel/);
  assert.equal(ownReason(PAISE, {}), '');
});

test('soft-fail: a Story error does not block Facebook, and is retried later up to the cap', async () => {
  const files = tmpFiles();
  const lines = [];
  const bad = fakeApi({ storyFails: { error: Object.assign(new Error('boom access_token=IGTOKEN-secret-value-123'), { status: 400 }) } });
  const out = await runCompanion({ env: ENV, api: bad.api, now: NOW, files, log: (l) => lines.push(l) });
  assert.equal(bad.calls.story.length, 1);
  assert.equal(bad.calls.fb.length, 1, 'Facebook still posted');
  assert.equal(out.failures.length, 1);
  assert.equal(lines.join('\n').includes('IGTOKEN-secret-value-123'), false, 'token never printed');
  assert.equal(JSON.stringify(readCompanion(files.companion)).includes('IGTOKEN'), false);

  // Later run: the Story is retried, Facebook is not repeated.
  const again = fakeApi();
  await runCompanion({ env: ENV, api: again.api, now: NOW, files, log: quiet });
  assert.equal(again.calls.story.length, 1);
  assert.equal(again.calls.fb.length, 0);
  assert.equal(readCompanion(files.companion)[0].story.state, 'done');
});

test('a failing part gives up after MAX_TRIES; an uncertain publish is never retried', async () => {
  const files = tmpFiles();
  for (let i = 0; i < MAX_TRIES + 1; i += 1) {
    const { api } = fakeApi({ fbFails: { error: Object.assign(new Error('nope'), { status: 500 }) } });
    await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  }
  const entry = readCompanion(files.companion)[0];
  assert.equal(entry.fb.tries, MAX_TRIES);
  const plan = planCompanion({ media: [PAISE], now: NOW, companion: readCompanion(files.companion), fbEnabled: true });
  assert.equal(plan[0].fb, 'gave-up');

  const files2 = tmpFiles();
  const lost = fakeApi({ storyFails: { stage: 'publish', error: new Error('socket hang up') } });
  await runCompanion({ env: ENV, api: lost.api, now: NOW, files: files2, log: quiet });
  assert.equal(readCompanion(files2.companion)[0].story.state, 'uncertain');
  const retry = fakeApi();
  await runCompanion({ env: ENV, api: retry.api, now: NOW, files: files2, log: quiet });
  assert.equal(retry.calls.story.length, 0, 'uncertain Story is not posted again');
});

test('nothing throws: a broken media list or a crashing API is a logged line', async () => {
  const files = tmpFiles();
  const lines = [];
  const api = { async listMedia() { return { ok: false, items: [], reason: 'HTTP 500' }; } };
  await runCompanion({ env: ENV, api, now: NOW, files, log: (l) => lines.push(l) });
  assert.match(lines.join('\n'), /could not list Instagram media/);
  const crash = { async listMedia() { throw new Error('kaput'); } };
  const out = await runCompanion({ env: ENV, api: crash, now: NOW, files, log: quiet });
  assert.equal(out.failures[0].part, 'run');
});

test('off unless ENABLE_REEL_COMPANION is true; dry run posts and writes nothing', async () => {
  const files = tmpFiles();
  const off = fakeApi();
  const skipped = await runCompanion({ env: { ...ENV, ENABLE_REEL_COMPANION: '' }, api: off.api, now: NOW, files, log: quiet });
  assert.equal(skipped.skipped, true);
  assert.equal(off.calls.story.length + off.calls.fb.length, 0);

  const dry = fakeApi({ media: [PAISE, OWN] });
  const lines = [];
  const plan = await runCompanion({
    env: { ...ENV, ENABLE_REEL_COMPANION: '' }, api: dry.api, now: NOW, files, dryRun: true, log: (l) => lines.push(l),
  });
  assert.equal(dry.calls.story.length + dry.calls.fb.length, 0);
  assert.equal(plan.plan.find((p) => p.id === PAISE.id).action, 'handle');
  assert.match(lines.join('\n'), /DRY RUN/);
  assert.deepEqual(readCompanion(files.companion), []);
});

test('FB_CROSSPOST off: Story only', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  await runCompanion({ env: { ...ENV, FB_CROSSPOST: 'false' }, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 1);
  assert.equal(calls.fb.length, 0);
});

test('an unfetchable media_url falls back to the release mp4', async () => {
  const files = tmpFiles();
  const release = 'https://github.com/o/r/releases/download/ig-reel-2026-10-03/paise-short-1-1-abc.mp4';
  const { api, calls } = fakeApi({ probe: (url) => url === release, release });
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story[0], release);
  assert.equal(calls.fb[0].videoUrl, release);
  assert.equal(out.stories[0].from, 'release');
});

test('Facebook caption: CTA appended once, never duplicated, kept inside the limit', () => {
  const plain = fbCaption('Hook\n\n#sip');
  assert.ok(plain.endsWith(BROKER_CTA));
  assert.equal(fbCaption(plain), plain);
  assert.equal(fbCaption(PAISE_WITH_CTA.caption), PAISE_WITH_CTA.caption.trim(), 'Paise bio CTA counts');
  const long = fbCaption('x'.repeat(5000));
  assert.ok(long.length <= 2200);
  assert.ok(long.endsWith(BROKER_CTA));
  assert.ok(hasBioCta('Link in bio 👆'));
  assert.ok(hasBioCta('Broker links bio mein hain'));
  assert.equal(hasBioCta('Biometric data aur biology'), false);
});

test('marker and redaction helpers', () => {
  assert.equal(markerOf(PAISE.caption), 'pkp:sip-magic:abc123');
  assert.equal(markerOf('none'), '');
  assert.equal(redact('GET x?access_token=abc&y=1'), 'GET x?access_token=***&y=1');
  assert.equal(redact('token SECRETSECRET here', ['SECRETSECRET']), 'token *** here');
});

test('the workflow serialises runs, never cancels one, and offers a dry run', () => {
  const wf = fs.readFileSync('.github/workflows/reel-companion.yml', 'utf8');
  assert.match(wf, /^name: Reel companion$/m);
  assert.match(wf, /group: reel-companion/);
  assert.match(wf, /cancel-in-progress: false/);
  assert.match(wf, /dry-run:/);
  assert.match(wf, /ENABLE_REEL_COMPANION: \$\{\{ vars\.ENABLE_REEL_COMPANION \}\}/);
  assert.match(wf, /FB_CROSSPOST: \$\{\{ vars\.FB_CROSSPOST \}\}/);
  assert.match(wf, /continue-on-error: true/);
  const crons = [...wf.matchAll(/cron: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(crons.length, 6);
  const ist = crons.map((c) => { const [m, h] = c.split(' ').map(Number); return (h * 60 + m + 330) % 1440; });
  for (const c of crons) assert.ok(![0, 30].includes(Number(c.split(' ')[0])), c);
  // 30–90 minutes after each Paise slot (08:30, 16:00, 21:00 IST).
  for (const slot of [8 * 60 + 30, 16 * 60, 21 * 60]) {
    const after = ist.filter((t) => t - slot >= 20 && t - slot <= 90);
    assert.ok(after.length >= 1, `no run after ${slot}`);
  }
});

test('never hands a Meta CDN media_url to Graph: pinned, then release, then re-host', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  api.pinnedVideo = async () => 'https://github.com/x/y/releases/download/companion-media/ig-pinned.mp4';
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 1);
  assert.ok( calls.story.every((u) => u.includes('ig-pinned.mp4')));
  assert.ok(calls.fb.every((c) => c.videoUrl.includes('ig-pinned.mp4')));
});
