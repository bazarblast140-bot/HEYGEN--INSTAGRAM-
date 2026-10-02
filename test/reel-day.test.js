// One reel a day. GitHub delivers the 07:00 IST cron hours late, so a second
// fire ~22 minutes later has to be a no-op once today's topic is recorded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveReelDay } from '../pipeline/src/script/topics.js';

const WORKFLOW = new URL('../.github/workflows/build-reel.yml', import.meta.url);
const at = (iso) => new Date(iso);

// 07:00 IST on 2 Oct 2026, and the catch-up 22 minutes later.
const MORNING = at('2026-10-02T01:30:00Z');
const CATCHUP = at('2026-10-02T01:52:00Z');

test('the reel workflow keeps 07:00 IST and adds the carousel-style catch-up', async () => {
  const text = await readFile(WORKFLOW, 'utf8');
  const crons = [...text.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

  assert.deepEqual(crons, ['30 1 * * *', '52 1 * * *']);
  assert.match(text, /GitHub can be hours late/);
  assert.match(text, /Catch-up mirrors carousel/);
  assert.match(text, /node pipeline\/reel-status\.js/);
  // Scheduled publish stays on. The dispatch default stays off.
  assert.match(text, /github\.event_name == 'schedule'/);
  assert.match(text, /description: Publish to Instagram after building[\s\S]*?default: false/);
});

test('a reel already recorded today is not pending and the publish step requires that', async () => {
  const today = { date: '2026-10-02', topic: 'SIP inflows', angle: 'flat' };
  const morning = resolveReelDay({ now: MORNING, entries: [today] });
  const later = resolveReelDay({ now: CATCHUP, entries: [today] });

  assert.equal(morning.pending, false);
  assert.equal(morning.reason, 'duplicate');
  assert.equal(morning.posted.topic, 'SIP inflows');
  assert.equal(later.pending, false);
  assert.equal(later.date, '2026-10-02');

  const text = await readFile(WORKFLOW, 'utf8');
  const publish = text.slice(text.indexOf('name: Publish to Instagram'));
  assert.match(publish, /steps\.day\.outputs\.pending == 'true'/);
  assert.match(publish, /preview != 'true'/);
  assert.match(publish, /github\.event_name == 'schedule'/);

  const build = text.slice(text.indexOf('name: Build the reel'), text.indexOf('name: Summarise the run'));
  assert.match(build, /steps\.day\.outputs\.pending == 'true'/);
  assert.match(build, /github\.event_name != 'schedule'/);
  assert.match(build, /github\.event\.inputs\.publish != 'true'/);
});

test('an empty ledger still proceeds', () => {
  const decision = resolveReelDay({ now: MORNING, entries: [] });
  assert.equal(decision.pending, true);
  assert.equal(decision.reason, 'due');
  assert.equal(decision.posted, null);
  assert.equal(decision.date, '2026-10-02');
});

test('a different IST day still proceeds', () => {
  const yesterday = resolveReelDay({
    now: MORNING,
    entries: [{ date: '2026-10-01', topic: 'RBI repo rate' }],
  });
  assert.equal(yesterday.pending, true);
  assert.equal(yesterday.reason, 'due');

  // 00:30 IST on 2 Oct is still 1 Oct in UTC. The Indian day has turned,
  // so yesterday's reel does not block today, and today's entry does.
  const justAfterMidnightIst = at('2026-10-01T19:00:00Z');
  const carried = resolveReelDay({
    now: justAfterMidnightIst,
    entries: [{ date: '2026-10-01', topic: 'previous evening' }],
  });
  assert.equal(carried.date, '2026-10-02');
  assert.equal(carried.pending, true);

  const already = resolveReelDay({
    now: justAfterMidnightIst,
    entries: [{ date: '2026-10-02', topic: 'already today' }],
  });
  assert.equal(already.pending, false);
});
