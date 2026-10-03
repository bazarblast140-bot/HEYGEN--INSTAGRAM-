import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { decideFallbackReel } from '../pipeline/src/publish/same-day.js';

const EVENING = new Date('2026-10-03T16:17:00Z'); // 21:47 IST
const env = { IG_USER_ID: '17841410293109609', IG_ACCESS_TOKEN: 'tok', IG_SURFACE: 'facebook' };

function emptyLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-'));
  const file = path.join(dir, 'reel-publish-history.json');
  fs.writeFileSync(file, JSON.stringify({ entries: [] }));
  return file;
}

const listing = (items) => async () => ({ ok: true, json: async () => ({ data: items }) });
const noSleep = async () => {};

test('a Paise Reel already on Instagram today soft-skips the fallback before any paid step', async () => {
  const decision = await decideFallbackReel({
    now: EVENING, env, publishFile: emptyLedger(), sleep: noSleep,
    fetcher: listing([{ id: '18000000000000001', media_type: 'VIDEO', media_product_type: 'REELS', timestamp: '2026-10-03T03:01:00+0000' }]),
  });
  assert.equal(decision.pending, false);
  assert.equal(decision.via, 'instagram');
});

test('yesterday\'s Reel or a carousel today does not count; the fallback is due', async () => {
  const decision = await decideFallbackReel({
    now: EVENING, env, publishFile: emptyLedger(), sleep: noSleep,
    fetcher: listing([
      { id: '1', media_product_type: 'REELS', media_type: 'VIDEO', timestamp: '2026-10-02T15:31:00+0000' }, // 21:01 IST yesterday
      { id: '2', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-03T07:00:00+0000' },
    ]),
  });
  assert.equal(decision.pending, true);
});

test('an unreadable media list fails closed after one retry', async () => {
  let calls = 0;
  const decision = await decideFallbackReel({
    now: EVENING, env, publishFile: emptyLedger(), sleep: noSleep,
    fetcher: async () => { calls += 1; return { ok: false, status: 500, json: async () => ({}) }; },
  });
  assert.equal(calls, 2);
  assert.equal(decision.pending, false);
  assert.equal(decision.reason, 'unverified');

  let n = 0;
  const recovered = await decideFallbackReel({
    now: EVENING, env, publishFile: emptyLedger(), sleep: noSleep,
    fetcher: async () => { n += 1; return n === 1 ? { ok: false, status: 500, json: async () => ({}) } : { ok: true, json: async () => ({ data: [] }) }; },
  });
  assert.equal(recovered.pending, true);
});

test('force still builds', async () => {
  const decision = await decideFallbackReel({ now: EVENING, env, force: true, publishFile: emptyLedger(), sleep: noSleep, fetcher: listing([]) });
  assert.equal(decision.pending, true);
  assert.equal(decision.reason, 'forced');
});

test('build-reel runs the guard before the voice check, DeepSeek and ElevenLabs, and keeps the Rudra guard', () => {
  const wf = fs.readFileSync('.github/workflows/build-reel.yml', 'utf8');
  const day = wf.indexOf('node pipeline/reel-status.js');
  for (const later of ['Check the reel voice (Rudra)', 'DEEPSEEK_API_KEY', 'ELEVENLABS_API_KEY', 'run: npm ci']) {
    assert.ok(day > 0 && day < wf.indexOf(later), later);
  }
  assert.match(wf, /REEL_VOICE_NAME: \$\{\{ vars\.REEL_VOICE_NAME \|\| 'Rudra' \}\}/);
  assert.match(wf, /steps\.day\.outputs\.pending == 'true'/);
  const status = fs.readFileSync('pipeline/reel-status.js', 'utf8');
  assert.match(status, /decideFallbackReel/);
  assert.match(status, /soft skip/);
});

test('slot health checks the Reel only after the fallback window, never in the morning', async () => {
  const { missedSlots, SLOT_TIMES, GRACE_MINUTES } = await import('../pipeline/src/health/missed-publish.js');
  const due = SLOT_TIMES.reel.minute + (SLOT_TIMES.reel.grace ?? GRACE_MINUTES);
  assert.ok(due >= 22 * 60 + 41, 'after the last catch-up');
  const wf = fs.readFileSync('.github/workflows/slot-health.yml', 'utf8');
  assert.equal(wf.includes("cron: '7 2 * * *'"), false);
  assert.match(wf, /cron: '37 17 \* \* \*'/); // 23:07 IST
  const carousels = [{ date: '2026-10-03 midday' }, { date: '2026-10-03 evening' }];
  // 20:07 IST: no Reel yet, not reported.
  assert.deepEqual(missedSlots({ now: new Date('2026-10-03T14:37:00Z'), env: {}, carouselEntries: carousels }), []);
  // 23:07 IST: a Paise Reel on IG satisfies the slot.
  assert.deepEqual(missedSlots({
    now: new Date('2026-10-03T17:37:00Z'), env: {}, carouselEntries: carousels,
    media: [{ id: '1', media_product_type: 'REELS', timestamp: '2026-10-03T03:01:00+0000' }],
  }), []);
  assert.deepEqual(missedSlots({ now: new Date('2026-10-03T17:37:00Z'), env: {}, carouselEntries: carousels }), ['reel']);
});
