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

test('a late run keeps the slot it was scheduled for', () => {
  // 19:30 IST cron, delivered around 06:07 IST the next morning.
  const late = new Date('2026-10-02T00:37:00Z');
  assert.equal(slotFor(late), null, 'precondition: the clock is outside both windows');
  assert.equal(slotForCron('0 14 * * *'), 'evening');
  const decision = resolveRun({ event: 'schedule', cron: '0 14 * * *', now: late, entries: [] });
  assert.equal(decision.pending, true);
  assert.equal(decision.slot, 'evening');
});

test('both firings of a slot agree', () => {
  assert.equal(slotForCron('0 7 * * *'), slotForCron('22 7 * * *'));
  assert.equal(slotForCron('0 14 * * *'), slotForCron('22 14 * * *'));
  assert.equal(slotForCron('0 7 * * *'), 'midday');
  assert.equal(slotForCron('0 14 * * *'), 'evening');
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

test('and every entry in the table is one of the two finance slots', () => {
  const known = new Set(SLOTS);
  for (const [cron, slot] of Object.entries(CRON_SLOTS)) {
    assert.ok(known.has(slot), `${cron} maps to unknown slot "${slot}"`);
  }
});
