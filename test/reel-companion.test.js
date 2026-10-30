import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  runCompanion, planCompanion, fbCaption, readCompanion, readFbLedger, mergeCompanion,
  ownReason, markerOf, redact, MAX_TRIES, SOURCE, paiseVideoId, storyPlan, ffmpegArgs,
  matchFbReel, titleOf, STORY_SKIPPED, FB_GRACE_MINUTES,
} from '../pipeline/src/publish/companion.js';
import { BROKER_CTA, hasBioCta } from '../pipeline/src/publish/cta.js';
import { ENGAGEMENT } from '../pipeline/src/publish/caption.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const NOW = Date.parse('2026-10-03T12:00:00Z'); // 17:30 IST

const PAISE = {
  id: '18000000000000001',
  media_type: 'VIDEO',
  media_product_type: 'REELS',
  timestamp: '2026-10-03T03:01:00+0000', // 08:31 IST
  permalink: 'https://www.instagram.com/reel/AAA/',
  media_url: 'https://scontent.cdninstagram.com/v/paise1.mp4',
  caption: 'SIP ka jaadu\n\nयह सिर्फ़ शिक्षा के लिए है — निवेश सलाह नहीं।\n\n#sip #nifty50\n\npkp:video:KVmMkKG5gzk',
};
const PAISE_WITH_CTA = {
  ...PAISE,
  id: '18000000000000002',
  timestamp: '2026-10-03T10:31:00+0000',
  caption: 'Demat / invest account chahiye ho to profile bio me link dekho. यह referral link है।\n\npkp:video:0oe9nuJyQLE',
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
    fbStory: path.join(dir, 'fb-story-history.json'),
  };
  fs.writeFileSync(files.fbStory, '[]');
  fs.writeFileSync(files.companion, JSON.stringify({ entries: companion }));
  fs.writeFileSync(files.fb, JSON.stringify(fb));
  fs.writeFileSync(files.own, JSON.stringify({ entries: own }));
  return files;
}

function fakeApi({ media = [PAISE], storyFails = null, fbFails = null, probe = () => true, release = '', pageReels = [], pageLookupOk = true } = {}) {
  const calls = { story: [], fb: [], fbStory: [], lookups: 0, probe: [], release: 0 };
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
      async findFbReel({ item }) {
        calls.lookups += 1;
        if (!pageLookupOk) return { ok: false, match: null };
        return { ok: true, match: matchFbReel(pageReels, item) };
      },
      async fbStory({ igStoryId, igMediaId, url, file }) {
        calls.fbStory.push({ igStoryId, igMediaId, url });
        n += 1;
        const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
        rows.push({ igStoryId, igMediaId, state: 'done', fbStoryId: `77${n}` });
        fs.writeFileSync(file, JSON.stringify(rows));
        return { state: 'done', fbStoryId: `77${n}` };
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

test('a Paise Reel gets NO IG Story (Paise owns it), one Facebook Reel and one FB Story, recorded on the ledgers', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 0, 'IG Story is never posted');
  assert.equal(out.stories.length, 0);
  assert.equal(calls.fb.length, 1);
  assert.equal(calls.fbStory.length, 1);
  assert.match(calls.fbStory[0].url, /companion-media/); // re-hosted, never the Meta CDN url
  assert.equal(calls.fbStory[0].igMediaId, PAISE.id);
  const entry = readCompanion(files.companion).find((e) => e.igMediaId === PAISE.id);
  assert.equal(entry.story.state, STORY_SKIPPED);
  assert.equal(entry.fb.state, 'done');
  assert.equal(entry.fbStory.state, 'done');
  assert.equal(entry.marker, 'pkp:video:KVmMkKG5gzk');
  const fb = readFbLedger(files.fb);
  assert.equal(fb.length, 1);
  assert.equal(fb[0].igMediaId, PAISE.id);
  assert.equal(fb[0].source, SOURCE);
  assert.match(calls.fb[0].caption, /link in bio\.$/);
  assert.ok(calls.fb[0].caption.startsWith('SIP ka jaadu'));
});

test('two runs over the same media never post twice (idempotent ledger)', async () => {
  const files = tmpFiles();
  const first = fakeApi();
  await runCompanion({ env: ENV, api: first.api, now: NOW, files, log: quiet });
  const snapshot = fs.readFileSync(files.companion, 'utf8');
  const second = fakeApi();
  const out = await runCompanion({ env: ENV, api: second.api, now: NOW + 3600e3, files, log: quiet });
  assert.equal(second.calls.story.length, 0);
  assert.equal(second.calls.fb.length, 0);
  assert.equal(second.calls.fbStory.length, 0);
  assert.equal(second.calls.lookups, 0, 'done ledger: not even a Page lookup');
  assert.equal(out.plan[0].action, 'skip');
  assert.equal(readFbLedger(files.fb).length, 1);
  assert.equal(fs.readFileSync(files.companion, 'utf8'), snapshot, 'ledger unchanged by the second run');
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

test('no IG Story call ever, for any Paise Reel or ledger state (even a failed/old story row)', async () => {
  const files = tmpFiles({ companion: [{ igMediaId: PAISE.id, story: { state: 'failed', tries: 1 }, fb: null }] });
  const media = [PAISE, PAISE_WITH_CTA];
  const { api, calls } = fakeApi({ media });
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  await runCompanion({ env: { ...ENV, FB_CROSSPOST: 'false' }, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length, 0);
  for (const e of readCompanion(files.companion)) assert.equal(e.story.state, STORY_SKIPPED);
  const plan = planCompanion({ media, now: NOW, fbEnabled: true });
  assert.ok(plan.every((p) => p.doStory === false));
  const src = fs.readFileSync(new URL('../pipeline/src/publish/companion.js', import.meta.url), 'utf8');
  const run = src.slice(src.indexOf('export async function runCompanion'));
  assert.doesNotMatch(run, /api\.postStory\(/, 'runCompanion never calls postStory');
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
  const lost = fakeApi({ fbFails: { stage: 'finish', error: new Error('socket hang up') } });
  await runCompanion({ env: ENV, api: lost.api, now: NOW, files: files2, log: quiet });
  assert.equal(readCompanion(files2.companion)[0].fb.state, 'uncertain');
  const retry = fakeApi();
  await runCompanion({ env: ENV, api: retry.api, now: NOW, files: files2, log: quiet });
  assert.equal(retry.calls.fb.length, 0, 'uncertain FB Reel is not posted again');
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

test('FB_CROSSPOST off: nothing posted at all (no IG Story either)', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  const out = await runCompanion({ env: { ...ENV, FB_CROSSPOST: 'false' }, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length + calls.fb.length + calls.fbStory.length, 0);
  assert.equal(out.plan[0].action, 'skip');
});

test('an unfetchable media_url falls back to the release mp4', async () => {
  const files = tmpFiles();
  const release = 'https://github.com/o/r/releases/download/ig-reel-2026-10-03/paise-short-1-1-abc.mp4';
  const { api, calls } = fakeApi({ probe: (url) => url === release, release });
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.fb[0].videoUrl, release);
  assert.equal(calls.fbStory[0].url, release);
  assert.equal(readCompanion(files.companion)[0].fb.from, 'release');
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
  assert.equal(markerOf(PAISE.caption), 'pkp:video:KVmMkKG5gzk');
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
  assert.equal(crons.length, 10);
  const ist = crons.map((c) => { const [m, h] = c.split(' ').map(Number); return (h * 60 + m + 330) % 1440; });
  for (const c of crons) assert.ok(![0, 30].includes(Number(c.split(' ')[0])), c);
  // 5–90 minutes after each Paise slot (Mon-Fri 08:45, 16:15, 18:30; Sat 11:30; old 21:00 IST).
  for (const slot of [8 * 60 + 45, 16 * 60 + 15, 18 * 60 + 30, 11 * 60 + 30, 21 * 60]) {
    const after = ist.filter((t) => t - slot >= 5 && t - slot <= 90);
    assert.ok(after.length >= 1, `no run after ${slot}`);
  }
});

test('never hands a Meta CDN media_url to Graph: pinned, then re-host, then release', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  api.pinnedVideo = async () => 'https://github.com/x/y/releases/download/companion-media/ig-pinned.mp4';
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.fb.length, 1);
  assert.ok(calls.fbStory.every((c) => c.url.includes('ig-pinned.mp4')));
  assert.ok(calls.fb.every((c) => c.videoUrl.includes('ig-pinned.mp4')));
});

// ---------------------------------------------------------------- Paise only + Story 60 s

test('only Reels that name a Paise Ki Pathshala YouTube video are handled', () => {
  assert.equal(paiseVideoId('Gold vs FD\n\npkp:video:0oe9nuJyQLE'), '0oe9nuJyQLE');
  assert.equal(paiseVideoId('SIP basics\n\npkp:sip-basics:KVmMkKG5gzk'), 'KVmMkKG5gzk', 'pkp:<topic_key>:<id>');
  assert.equal(paiseVideoId('x\npkp:gold_vs_fd:0oe9nuJyQLE #paise'), '0oe9nuJyQLE');
  assert.equal(paiseVideoId('pkp:sip:KVmMkKG5gzkX'), '', '12-char id is not a YouTube id');
  assert.equal(paiseVideoId('pkp:sip:KVmMkKG5gz'), '', '10-char id');
  assert.equal(paiseVideoId('xpkp:sip:KVmMkKG5gzk'), '', 'must be a real pkp-prefixed marker');
  assert.equal(paiseVideoId('pkp:KVmMkKG5gzk'), '', 'key and id are both required');
  assert.equal(paiseVideoId('pkp::KVmMkKG5gzk'), '', 'empty key');
  assert.equal(paiseVideoId('pkp:sip:KVmMkKG5gzk:extra'), '');
  assert.equal(paiseVideoId('Paise Ki Pathshala ka naya short https://youtube.com/shorts/KVmMkKG5gzk'), '', 'naming Paise + a YouTube link is not the marker');
  assert.equal(paiseVideoId('https://youtube.com/shorts/KVmMkKG5gzk'), '', 'a YouTube link alone is not enough');
  assert.equal(paiseVideoId('pkp:sip-magic:abc123'), '', 'an old marker without a video id is not enough');
  assert.equal(paiseVideoId('pkp:video:short'), '');
  const unmarked = { ...PAISE, id: '18000000000000077', caption: 'Some other Reel, no marker' };
  const plan = planCompanion({ media: [PAISE, unmarked, OWN], now: NOW, fbEnabled: true });
  const action = (id) => plan.find((p) => p.id === id)?.action;
  assert.equal(action(PAISE.id), 'handle');
  assert.equal(action(OWN.id), 'skip');
  assert.equal(action(unmarked.id), 'skip');
  assert.match(plan.find((p) => p.id === unmarked.id).reason, /not a Paise Ki Pathshala Reel/);
  assert.match(plan.find((p) => p.id === OWN.id).reason, /own Reel/);
  assert.equal(plan.find((p) => p.id === PAISE.id).yt, 'KVmMkKG5gzk');
});

test('Story length plan: ≤ 59.5 s as is; longer sped up by duration/59 up to 1.25x; beyond that trimmed to 59 s', () => {
  assert.deepEqual(storyPlan(45), { action: 'none' });
  assert.deepEqual(storyPlan(59.5), { action: 'none' });
  assert.deepEqual(storyPlan(63.5), { action: 'speed', factor: 1.077 }); // 0oe9nuJyQLE
  assert.ok(63.5 / storyPlan(63.5).factor <= 59);
  assert.deepEqual(storyPlan(73.75), { action: 'speed', factor: 1.25 });
  assert.deepEqual(storyPlan(80), { action: 'trim', seconds: 59 });
  assert.deepEqual(storyPlan(NaN), { action: 'unknown' });
  assert.deepEqual(ffmpegArgs({ action: 'speed', factor: 1.077 }, 'in.mp4', 'out.mp4').slice(0, 6), ['-y', '-i', 'in.mp4', '-filter_complex', '[0:v]setpts=PTS/1.077[v];[0:a]atempo=1.077[a]', '-map']);
  assert.ok(!ffmpegArgs({ action: 'speed', factor: 1.1 }, 'i', 'o', { hasAudio: false }).join(' ').includes('atempo'));
  assert.ok(ffmpegArgs({ action: 'trim', seconds: 59 }, 'i', 'o').join(' ').includes('-t 59'));
});

test('the FB Story uses the shortened copy; the Facebook Reel keeps the original', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  const asked = [];
  api.storyVideo = async ({ id, video }) => { asked.push(id); return { url: `https://github.com/x/y/releases/download/companion-media/ig-${id}-story.mp4`, from: 'story-copy (1.077x)', original: video.url }; };
  api.youtubePublic = async () => true;
  await runCompanion({ env: { ...ENV, GITHUB_REPOSITORY: 'x/y', GITHUB_TOKEN: 't' }, api, now: NOW, files, log: quiet });
  assert.deepEqual(asked, [PAISE.id]);
  assert.match(calls.fbStory[0].url, new RegExp(`ig-${PAISE.id}-story\\.mp4$`));
  assert.equal(calls.fb.length, 1);
  assert.doesNotMatch(calls.fb[0].videoUrl, /-story\.mp4$/, 'FB gets the original');
});

test('a YouTube video that is not public is skipped and nothing is recorded', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  api.youtubePublic = async (id) => (id === 'KVmMkKG5gzk' ? false : true);
  const lines = [];
  await runCompanion({ env: ENV, api, now: NOW, files, log: (l) => lines.push(l) });
  assert.equal(calls.fb.length + calls.fbStory.length, 0);
  assert.deepEqual(readCompanion(files.companion), []);
  assert.ok(lines.some((l) => /KVmMkKG5gzk is not public/.test(l)));
  api.youtubePublic = async () => null; // oEmbed unreachable: not a reason to skip
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.fb.length, 1);
  assert.equal(calls.story.length, 0);
});

test('ffmpeg: a 63.5 s clip becomes a ≤ 59.5 s Story copy', { skip: !hasFfmpeg }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-'));
  const input = path.join(dir, 'in.mp4'); const output = path.join(dir, 'out.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=128x228:r=15:d=63.5', '-f', 'lavfi', '-i', 'sine=f=440:d=63.5', '-shortest', '-c:v', 'libx264', '-c:a', 'aac', input], { stdio: 'ignore' });
  execFileSync('ffmpeg', ffmpegArgs(storyPlan(63.5), input, output), { stdio: 'ignore' });
  const d = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', output], { encoding: 'utf8' }));
  assert.ok(d <= 59.5 && d > 58, `story copy is ${d} s`);
});

test('reel-companion.yml installs ffmpeg', async () => {
  const wf = fs.readFileSync(new URL('../.github/workflows/reel-companion.yml', import.meta.url), 'utf8');
  assert.match(wf, /apt-get install[^\n]*ffmpeg/);
});

// ---------------------------------------------------------------- 7 Oct audit

test('audit: only Paise Reels with the pkp:video marker — never carousels, feed videos, own or unmarked Reels', () => {
  const t = new Date(NOW - 3600 * 1000).toISOString();
  const media = [
    PAISE,
    { ...PAISE, id: '18000000000000101', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: t },
    { ...PAISE, id: '18000000000000102', media_type: 'VIDEO', media_product_type: 'FEED', timestamp: t },
    { ...PAISE, id: '18000000000000103', caption: 'Paise Ki Pathshala https://youtu.be/KVmMkKG5gzk', timestamp: t },
    { ...PAISE, id: '18000000000000104', caption: 'pkp:video:KVmMkKG5gzk', media_type: 'IMAGE', media_product_type: 'STORY', timestamp: t },
  ];
  const plan = planCompanion({ media, now: NOW, fbEnabled: true });
  assert.deepEqual(plan.filter((p) => p.action === 'handle').map((p) => p.id), [PAISE.id]);
  assert.equal(plan.find((p) => p.id === '18000000000000103').action, 'skip');
  assert.ok(!plan.some((p) => p.id === '18000000000000101' || p.id === '18000000000000102' || p.id === '18000000000000104'), 'non-Reels are not even planned');
});

test('audit: the copy is this Reel\'s own video — re-hosted media_url is used before a time-matched release mp4', async () => {
  const files = tmpFiles();
  const release = 'https://github.com/o/r/releases/download/ig-reel-2026-10-03/paise-short-1-1-abc.mp4';
  const { api, calls } = fakeApi({ release });
  await runCompanion({ env: { ...ENV, GITHUB_REPOSITORY: 'x/y', GITHUB_TOKEN: 't' }, api, now: NOW, files, log: quiet });
  assert.equal(calls.release, 0, 'release lookup not needed');
  assert.match(calls.fb[0].videoUrl, /companion-media/);
  assert.equal(readCompanion(files.companion)[0].fb.from, 'rehost');
});

test('audit: a handled Reel is never posted again — second run, other run\'s ledger row, FB ledger row', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  await runCompanion({ env: ENV, api, now: NOW + 3600 * 1000, files, log: quiet });
  assert.equal(calls.story.length, 0);
  assert.equal(calls.fb.length, 1);
  assert.equal(calls.fbStory.length, 1);
  const files2 = tmpFiles();
  fs.writeFileSync(files2.fb, JSON.stringify([{ date: '2026-10-03', kind: 'reel', igMediaId: PAISE.id, fbId: '1', source: SOURCE }]));
  const two = fakeApi();
  await runCompanion({ env: ENV, api: two.api, now: NOW, files: files2, log: quiet });
  assert.equal(two.calls.fb.length, 0, 'FB copy already in fb-crosspost-history.json');
});

// ---------------------------------------------------------------- 30 Oct: nothing double

test('FB Reel skipped when Paise already put this Reel on the Page (title match), ledger marked from=paise', async () => {
  const files = tmpFiles();
  const pageReels = [{ id: '1642320804298508', description: 'SIP ka jaadu\n\nPaise ki pathshala ...', created_time: '2026-10-03T03:02:40+0000', permalink_url: '/reel/1642320804298508/' }];
  const { api, calls } = fakeApi({ pageReels });
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.fb.length, 0, 'no second FB Reel');
  assert.equal(calls.story.length, 0);
  const e = readCompanion(files.companion)[0];
  assert.equal(e.fb.state, 'done');
  assert.equal(e.fb.from, 'paise');
  assert.equal(e.fb.id, '1642320804298508');
  assert.equal(out.fbSkipped[0].fbId, '1642320804298508');
  assert.equal(readFbLedger(files.fb).length, 0);
  const again = fakeApi({ pageReels });
  await runCompanion({ env: ENV, api: again.api, now: NOW + 3600e3, files, log: quiet });
  assert.equal(again.calls.fb.length + again.calls.lookups, 0);
});

test('FB match by marker or YouTube id; an old same-title video or another title is not a match', () => {
  const item = PAISE;
  assert.ok(matchFbReel([{ id: '1', description: 'x pkp:video:KVmMkKG5gzk' }], item));
  assert.ok(matchFbReel([{ id: '2', description: 'https://youtu.be/KVmMkKG5gzk' }], item));
  assert.equal(matchFbReel([{ id: '3', description: 'Gold vs FD', created_time: '2026-10-03T03:05:00+0000' }], item), null);
  assert.equal(matchFbReel([{ id: '4', description: 'SIP ka jaadu', created_time: '2026-09-01T03:05:00+0000' }], item), null, 'stale');
  assert.equal(matchFbReel([{ id: '5', description: 'Short' }], { ...item, caption: 'Short\n\npkp:video:AAAAAAAAAAA' }), null, 'too-short title');
  assert.equal(titleOf('  Aaj ki  Khabar | 30 Oct \n\nbody'), 'aaj ki khabar | 30 oct');
});

test('FB Reel is NOT posted when the Page lookup fails (fail closed) and is not counted as a try', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi({ pageLookupOk: false });
  await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.fb.length, 0);
  assert.equal(readCompanion(files.companion)[0].fb, null);
});

test('FB check waits FB_GRACE_MINUTES after the IG Reel so Paise can cross-post first', async () => {
  const files = tmpFiles();
  const { api, calls } = fakeApi();
  const fresh = Date.parse(PAISE.timestamp) + (FB_GRACE_MINUTES - 5) * 60000;
  await runCompanion({ env: ENV, api, now: fresh, files, log: quiet });
  assert.equal(calls.fb.length + calls.lookups, 0);
});

test('ledger done (e.g. from=paise) is never posted; FB Story already in fb-story ledger by media id is not repeated', async () => {
  const files = tmpFiles({ companion: [{ igMediaId: PAISE.id, story: { state: 'done', from: 'paise' }, fb: { state: 'done', from: 'paise', id: '9' } }] });
  fs.writeFileSync(files.fbStory, JSON.stringify([{ igStoryId: '1790', igMediaId: PAISE.id, state: 'done', fbStoryId: '5' }]));
  const { api, calls } = fakeApi();
  const out = await runCompanion({ env: ENV, api, now: NOW, files, log: quiet });
  assert.equal(calls.story.length + calls.fb.length + calls.fbStory.length + calls.lookups, 0);
  assert.equal(out.plan[0].action, 'skip');
});
