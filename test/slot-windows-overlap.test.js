// 7 Oct: ai and midday lost to late or dropped GitHub crons. Windows are now
// 3h after the slot time, with a 20-min fallback cron through each window, and
// "already posted" is decided per slot (ledger key / recorded media id), not by
// matching a post's time to a window — ai and midday overlap 12:00–12:30 IST.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CRON_SLOTS, WINDOWS, resolveRun, slotsAt, slotFor, istParts } from '../pipeline/src/carousel/categories.js';
import { postedSlots, carouselOnInstagram } from '../pipeline/src/publish/same-day.js';
import { countsFor, builtSlot } from '../pipeline/build-cap.js';
import { missedSlots } from '../pipeline/src/health/missed-publish.js';
import { approvalProblems, startedInWindow } from '../pipeline/approve-build.js';
import { attachMediaId } from '../pipeline/src/script/topics.js';

const env = { ENABLE_AI_NEWS_CAROUSELS: 'true' };
const ist = (date, hhmm) => new Date(`${date}T${hhmm}:00+05:30`);
const D = '2026-10-08'; // a Thursday, NSE trading day
const carousel = (id, hhmm, date = D) => ({ id, media_type: 'CAROUSEL_ALBUM', timestamp: ist(date, hhmm).toISOString() });
const wf = await fs.readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');

/** Every UTC fire time of a cron like "13,33,53 4-6 * * *", as IST minutes. */
function fireTimes(cron) {
  const [m, h] = cron.split(' ');
  const mins = m.split(',').map(Number);
  const [h0, h1 = h0] = h.split('-').map(Number);
  const out = [];
  for (let hour = h0; hour <= h1; hour += 1) for (const minute of mins) out.push({ utcH: hour, utcM: minute, ist: (hour * 60 + minute + 330) % 1440 });
  return out;
}

test('windows: ai 09:00–12:30, midday 12:00–15:30 (3h after the slot), evening unchanged; all same IST day before 23:00', () => {
  assert.deepEqual(WINDOWS.ai, { start: 540, end: 750 });
  assert.deepEqual(WINDOWS.midday, { start: 720, end: 930 });
  assert.deepEqual(WINDOWS.evening, { start: 990, end: 1200 });
  for (const w of Object.values(WINDOWS)) assert.ok(w.start >= 0 && w.end <= 23 * 60 && w.start < w.end);
});

test('fallback crons fire every 20 min inside their own window, never :00/:30, outside the 22:30–01:30 UTC band', () => {
  const fallbacks = Object.entries(CRON_SLOTS).filter(([c]) => c.includes(','));
  assert.deepEqual(fallbacks, [['13,33,53 4-6 * * *', 'ai'], ['16,36,56 7-9 * * *', 'midday']]);
  for (const [cron, slot] of fallbacks) {
    assert.match(wf, new RegExp(`- cron: '${cron.replace(/\*/g, '\\*')}'`), `${cron} is scheduled in carousel.yml`);
    const times = fireTimes(cron);
    assert.equal(times.length, 9);
    times.forEach((t, i) => {
      assert.ok(t.ist >= WINDOWS[slot].start && t.ist < WINDOWS[slot].end, `${cron} → ${t.ist}`);
      assert.ok(t.utcM !== 0 && t.utcM !== 30);
      assert.ok(t.utcH >= 2 && t.utcH < 22);
      if (i) assert.equal(t.ist - times[i - 1].ist, 20);
      const now = new Date(Date.UTC(2026, 9, 8, t.utcH, t.utcM, 40));
      const d = resolveRun({ event: 'schedule', cron, now, entries: [], env });
      assert.equal(d.reason, 'due', `${cron} at ${t.utcH}:${t.utcM} UTC`);
      assert.equal(d.slot, slot);
    });
  }
});

test('a late cron is accepted up to 3h after the slot time, then stale; never across midnight', () => {
  assert.equal(resolveRun({ event: 'schedule', cron: '0 4 * * *', now: ist(D, '12:20'), env }).reason, 'due');
  assert.equal(resolveRun({ event: 'schedule', cron: '0 4 * * *', now: ist(D, '12:31'), env }).reason, 'stale');
  assert.equal(resolveRun({ event: 'schedule', cron: '0 7 * * *', now: ist(D, '15:25'), env }).reason, 'due');
  // 7 Oct: midday crons arrived ~7h late (19:53 IST) — still stale.
  assert.equal(resolveRun({ event: 'schedule', cron: '0 7 * * *', now: ist(D, '19:53'), env }).reason, 'stale');
  // A cron delivered after midnight is a new IST day and outside every window.
  assert.equal(resolveRun({ event: 'schedule', cron: '16,36,56 7-9 * * *', now: ist('2026-10-09', '00:20'), env }).reason, 'stale');
  // Evening keeps its trading-day check.
  assert.equal(resolveRun({ event: 'schedule', cron: '15 11 * * *', now: ist('2026-10-10', '16:50'), env }).reason, 'market-closed');
});

test('a run with no slot inside the overlap takes the earliest slot not yet in the ledger', () => {
  assert.deepEqual(slotsAt(ist(D, '12:10'), env), ['ai', 'midday']);
  assert.equal(slotFor(ist(D, '12:10'), env), 'ai');
  assert.equal(resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: ist(D, '12:10'), entries: [], env }).slot, 'ai');
  const aiDone = [{ date: `${D} ai`, topic: 'x' }];
  const d = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: ist(D, '12:10'), entries: aiDone, env });
  assert.equal(d.slot, 'midday');
  assert.equal(d.pending, true);
  const both = [...aiDone, { date: `${D} midday`, topic: 'y' }];
  assert.equal(resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: ist(D, '12:10'), entries: both, env }).reason, 'duplicate');
});

test('overlap: a late AI post (ledger mediaId) does not make midday look posted', () => {
  const media = [carousel('1801', '12:20')];
  const entries = [{ date: `${D} ai`, topic: 'AI', mediaId: '1801' }];
  const now = ist(D, '12:46');
  assert.equal(carouselOnInstagram({ media, slot: 'midday', now, entries }), null);
  const d = resolveRun({ event: 'schedule', cron: '16,36,56 7-9 * * *', now, entries, env });
  assert.equal(d.pending, true);
  assert.equal(postedSlots({ media, entries, now }).ai.via, 'ledger');
});

test('overlap: an early midday post does not make a late AI run think it posted (and the reverse ledger row)', () => {
  const media = [carousel('1802', '12:05')];
  const entries = [{ date: `${D} midday`, topic: 'MF', mediaId: '1802' }];
  const now = ist(D, '12:25');
  assert.equal(carouselOnInstagram({ media, slot: 'ai', now, entries }), null);
  assert.equal(resolveRun({ event: 'schedule', cron: '13,33,53 4-6 * * *', now, entries, env }).pending, true);
  // midday itself stays posted
  assert.equal(resolveRun({ event: 'schedule', cron: '16,36,56 7-9 * * *', now: ist(D, '12:46'), entries, env }).reason, 'duplicate');
});

test('overlap: the Facebook copy ledger (slot + igMediaId) claims a post when the topic commit was lost', () => {
  const media = [carousel('1803', '12:15')];
  const fbEntries = [{ date: D, kind: 'carousel', slot: 'ai', igMediaId: '1803', fbId: 'x' }];
  const now = ist(D, '12:46');
  assert.equal(carouselOnInstagram({ media, slot: 'midday', now, entries: [], fbEntries }), null);
  assert.equal(postedSlots({ media, fbEntries, now }).ai.via, 'fb-ledger');
  // Old FB rows without a slot claim nothing (they could not say which slot).
  const old = [{ date: D, kind: 'carousel', igMediaId: '1803' }];
  assert.ok(carouselOnInstagram({ media, slot: 'midday', now, entries: [], fbEntries: old }));
});

test('overlap: an unrecorded post inside 12:00–12:30 counts for both open slots (fail closed, never a double post)', () => {
  const media = [carousel('1804', '12:20')];
  const now = ist(D, '12:46');
  const posted = postedSlots({ media, now });
  assert.equal(posted.ai.ambiguous, true);
  assert.equal(posted.midday.ambiguous, true);
  assert.ok(carouselOnInstagram({ media, slot: 'midday', now }));
  // Outside the overlap it is unambiguous.
  assert.deepEqual(Object.keys(postedSlots({ media: [carousel('1805', '13:10')], now: ist(D, '13:20') })), ['midday']);
  assert.deepEqual(Object.keys(postedSlots({ media: [carousel('1806', '10:10')], now: ist(D, '10:20') })), ['ai']);
  // A post a few minutes after the ai window (run started 12:28) still counts for ai, not only midday.
  assert.ok(postedSlots({ media: [carousel('1807', '12:34')], now: ist(D, '12:46') }).ai);
});

test('overlap: an older ledger row with no mediaId claims its own post, so the other slot stays open', () => {
  const media = [carousel('1808', '12:10')];
  const entries = [{ date: `${D} ai`, topic: 'AI' }];
  assert.equal(carouselOnInstagram({ media, slot: 'midday', now: ist(D, '12:46'), entries }), null);
  // ...but a second, unrecorded post is still seen.
  const two = [...media, carousel('1809', '13:00')];
  assert.ok(carouselOnInstagram({ media: two, slot: 'midday', now: ist(D, '13:20'), entries }));
});

test('yesterday\'s carousels never count for today', () => {
  const media = [carousel('1810', '12:20', '2026-10-07')];
  assert.deepEqual(postedSlots({ media, now: ist(D, '12:46') }), {});
});

test('build cap counts builds per slot from the step name, even inside the overlap', () => {
  const job = (name, conclusion = 'failure') => ({ jobs: [{ steps: [{ name, conclusion }] }] });
  const at1210 = { run_started_at: ist(D, '12:10').toISOString() };
  assert.equal(builtSlot(job('Build the carousel (ai)')), 'ai');
  assert.equal(countsFor('midday', job('Build the carousel (ai)'), at1210), false);
  assert.equal(countsFor('ai', job('Build the carousel (ai)'), at1210), true);
  assert.equal(countsFor('midday', job('Build the carousel (midday)', 'success'), at1210), true);
  assert.equal(countsFor('midday', job('Build the carousel (midday)', 'skipped'), at1210), false);
  // Older runs ("Build the carousel") fall back to the window the run started in.
  assert.equal(countsFor('ai', job('Build the carousel'), at1210), true);
  assert.equal(countsFor('evening', job('Build the carousel'), at1210), false);
  assert.match(wf, /- name: Build the carousel \(\$\{\{ steps\.slot\.outputs\.slot \}\}\)/);
});

test('missed-publish is slot-aware: a late AI post does not hide a missing midday', () => {
  const media = [carousel('1811', '12:20')];
  const carouselEntries = [{ date: `${D} ai`, topic: 'AI', mediaId: '1811' }];
  const missed = missedSlots({ now: ist(D, '13:05'), env, carouselEntries, media, reelPublishEntries: [] });
  assert.ok(missed.includes('midday'));
  assert.ok(!missed.includes('ai'));
});

test('post gate: a run that started inside its window may post a few minutes after it closes, same day only', async () => {
  const started = ist(D, '12:27');
  assert.equal(startedInWindow('ai', started, ist(D, '12:33')), true);
  assert.equal(startedInWindow('ai', started, ist(D, '12:50')), false, 'not long after');
  assert.equal(startedInWindow('ai', ist(D, '12:35'), ist(D, '12:40')), false, 'started outside');
  assert.equal(startedInWindow('ai', null, ist(D, '12:33')), false);
  const report = { publishable: true, format: 'jpeg', files: ['x.jpg'], slot: 'ai', istDate: D };
  const strict = await approvalProblems(report, { now: ist(D, '12:33'), files: false });
  const graced = await approvalProblems(report, { now: ist(D, '12:33'), files: false, startedAt: started.toISOString() });
  assert.ok(strict.some((p) => /window is closed/.test(p)));
  assert.deepEqual(graced, []);
  assert.match(wf, /SLOT_STARTED_AT: \$\{\{ steps\.slot\.outputs\.started \}\}/);
});

test('after publish the media id is written onto the slot\'s ledger row; the FB copy records the slot', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'carousel-history.json');
  await fs.writeFile(file, JSON.stringify({ entries: [{ date: `${D} ai`, topic: 'a' }, { date: `${D} midday`, topic: 'b' }], stories: ['s'] }));
  assert.equal(await attachMediaId({ key: `${D} midday`, mediaId: '18123456789', file }), true);
  assert.equal(await attachMediaId({ key: `${D} evening`, mediaId: '18123456789', file }), false);
  assert.equal(await attachMediaId({ key: `${D} ai`, mediaId: 'not-an-id', file }), false);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(data.entries[1], { date: `${D} midday`, topic: 'b', mediaId: '18123456789' });
  assert.equal(data.entries[0].mediaId, undefined);
  assert.deepEqual(data.stories, ['s']);
  assert.match(wf, /fb-crosspost\.js --kind carousel --ig-media "\$ID" --slot "\$\{\{ steps\.slot\.outputs\.slot \|\| steps\.approve\.outputs\.slot \}\}"/);
  const pub = await fs.readFile(new URL('../pipeline/publish-carousel.js', import.meta.url), 'utf8');
  assert.match(pub, /attachMediaId\(\{ key: `\$\{report\.istDate\} \$\{report\.slot\}`, mediaId, file: LEDGER \}\)/);
});

test('istParts helper sanity for the test clock', () => {
  assert.deepEqual(istParts(ist(D, '12:20')), { date: D, minutes: 740 });
});
