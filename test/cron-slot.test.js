// The slot a run is for comes from the cron entry, not the clock.
//
// GitHub fired these entries six to eight hours late, every time. The 00:37
// morning entry arrived at 07:05, where slotFor() sees hour 7 and answers
// "midday" -- so the morning post was not dropped or failed, it was relabelled
// on arrival and the ledger recorded a midday post instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { CRON_SLOTS, slotForCron, slotFor, SLOTS, resolveRun } from '../pipeline/src/carousel/categories.js';

const WORKFLOW = new URL('../.github/workflows/carousel.yml', import.meta.url);

test('a late run keeps the slot it was scheduled for, and does not backfill it', () => {
  // 16:45 IST evening cron, delivered around 06:07 IST the next morning.
  const late = new Date('2026-10-06T00:37:00Z');
  assert.equal(slotFor(late), null, 'precondition: the clock is outside every window');
  assert.equal(slotForCron('15 11 * * *'), 'evening');
  const decision = resolveRun({ event: 'schedule', cron: '15 11 * * *', now: late, entries: [] });
  assert.equal(decision.slot, 'evening', 'not relabelled by the clock');
  assert.equal(decision.pending, false);
  assert.equal(decision.reason, 'stale');
  // A late catch-up still inside the window (16:30–20:00 IST) on a trading day does post.
  const inside = resolveRun({ event: 'schedule', cron: '56 11 * * *', now: new Date('2026-10-05T13:10:00Z'), entries: [] });
  assert.equal(inside.pending, true);
});

test("today's 16:45 market slot never backfills at 20:00 IST", () => {
  const evening = new Date('2026-10-05T14:30:00Z'); // 20:00 IST, Monday
  for (const cron of ['15 11 * * *', '22 11 * * *', '37 11 * * *', '56 11 * * *']) {
    const d = resolveRun({ event: 'schedule', cron, now: evening, entries: [] });
    assert.equal(d.slot, 'evening');
    assert.equal(d.pending, false, cron);
    assert.equal(d.reason, 'stale');
  }
  const asked = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'evening', now: evening, entries: [] });
  assert.equal(asked.pending, false);
  assert.equal(asked.reason, 'wrong-time');
});

test('the market slot runs only on NSE trading days', () => {
  const at = (d) => new Date(`${d}T11:15:00Z`); // 16:45 IST
  for (const [date, why] of [['2026-10-02', 'NSE holiday'], ['2026-10-03', 'weekend'], ['2026-10-04', 'weekend'], ['2026-10-20', 'NSE holiday']]) {
    const d = resolveRun({ event: 'schedule', cron: '15 11 * * *', now: at(date), entries: [] });
    assert.equal(d.pending, false, date);
    assert.equal(d.reason, 'market-closed', date);
    assert.equal(d.why, why, date);
    const asked = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'evening', now: at(date), entries: [] });
    assert.equal(asked.reason, 'market-closed', `dispatch ${date}`);
  }
  assert.equal(resolveRun({ event: 'schedule', cron: '15 11 * * *', now: at('2026-10-05'), entries: [] }).pending, true);
  // The other slots do not care about the market calendar.
  assert.equal(resolveRun({ event: 'schedule', cron: '0 7 * * *', now: new Date('2026-10-04T07:00:00Z'), entries: [] }).pending, true);
});

test('both firings of a slot agree', () => {
  assert.equal(slotForCron('0 7 * * *'), slotForCron('22 7 * * *'));
  assert.equal(slotForCron('15 11 * * *'), slotForCron('37 11 * * *'));
  assert.equal(slotForCron('0 4 * * *'), slotForCron('41 4 * * *'));
  assert.equal(slotForCron('0 7 * * *'), 'midday');
  assert.equal(slotForCron('15 11 * * *'), 'evening');
});

test('an unknown cron falls back rather than guessing', () => {
  assert.equal(slotForCron('0 3 * * *'), null);
  assert.equal(slotForCron(''), null);
  assert.equal(slotForCron(undefined), null);
});

test('extra whitespace still resolves', () => {
  assert.equal(slotForCron('  0   7 * * *  '), 'midday');
});

// The drift that would switch this off silently: a cron added to the workflow
// and not to the table falls back to the clock, and nothing says so.
test('every cron in the workflow is in the table', async () => {
  const text = await readFile(WORKFLOW, 'utf8');
  const crons = [...text.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

  assert.ok(crons.length >= 4, `found only ${crons.length} cron entries`);
  for (const cron of crons) {
    assert.ok(slotForCron(cron), `workflow schedules "${cron}" but CRON_SLOTS does not map it`);
  }
});

test('three slots: ai 09:30, midday 12:30, evening 16:45 IST, each with catch-ups', () => {
  const by = {};
  for (const [cron, slot] of Object.entries(CRON_SLOTS)) (by[slot] ||= []).push(cron);
  const ist = (cron) => { const [m, h] = cron.split(' ').map(Number); const t = (h * 60 + m + 330) % 1440; return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; };
  const single = (list) => list.filter((c) => !c.includes(','));
  assert.deepEqual(single(by.ai).map(ist), ['09:30', '09:37', '09:52', '10:11']);
  assert.deepEqual(single(by.midday).map(ist), ['12:30', '12:37', '12:52', '13:11']);
  assert.deepEqual(by.ai.filter((c) => c.includes(',')), ['13,33,53 4-6 * * *']);
  assert.deepEqual(by.midday.filter((c) => c.includes(',')), ['16,36,56 7-9 * * *']);
  assert.deepEqual(by.evening.map(ist), ['16:45', '16:52', '17:07', '17:26']);
  assert.deepEqual(Object.keys(by).sort(), ['ai', 'evening', 'midday']);
  assert.ok(SLOTS.includes('midday') && SLOTS.includes('evening'));
});
