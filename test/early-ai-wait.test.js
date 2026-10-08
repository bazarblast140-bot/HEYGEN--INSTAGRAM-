// Issue #61: a 06:07 IST publishing dispatch is held until 09:02 and then runs
// the normal ai flow; the ledger / Instagram / cap / post gate run after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

import { earlyAiWait, resolveRun, EARLY_AI } from '../pipeline/src/carousel/categories.js';
import { slotRunsToday, countsFor } from '../pipeline/build-cap.js';
import { postedSlots } from '../pipeline/src/publish/same-day.js';

const ON = { ENABLE_AI_NEWS_CAROUSELS: 'true' };
const at = (ist) => new Date(`2026-10-09T${ist}:00+05:30`);
const dispatch = (ist, extra = {}) => earlyAiWait({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at(ist), env: ON, publish: true, ...extra });

test('06:07 IST resolves to ai and waits until 09:02 IST the same day', () => {
  const p = dispatch('06:07');
  assert.equal(p.wait, true);
  assert.equal(p.slot, 'ai');
  assert.equal(p.until, at('09:02').toISOString());
  assert.equal(p.seconds, (9 * 60 + 2 - (6 * 60 + 7)) * 60);
  assert.ok(Date.parse(p.deadline) <= at('09:10').getTime());
  assert.equal(p.date, '2026-10-09');
  // ...and at 09:02 the normal resolution picks ai and it is pending.
  const r = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('09:02'), entries: [], env: ON });
  assert.deepEqual([r.slot, r.pending, r.reason], ['ai', true, 'due']);
});

test('05:30 IST does not wait and still skips', () => {
  const p = dispatch('05:30');
  assert.equal(p.wait, false);
  assert.match(p.reason, /before 06:00/);
  assert.equal(resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('05:30'), env: ON }).reason, 'outside');
});

test('09:37 IST runs ai immediately (no wait)', () => {
  assert.equal(dispatch('09:37').wait, false);
  const r = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('09:37'), entries: [], env: ON });
  assert.deepEqual([r.slot, r.pending], ['ai', true]);
});

test('a midday-window time still resolves to midday, no wait', () => {
  assert.equal(dispatch('13:07').wait, false);
  const r = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('13:07'), entries: [], env: ON });
  assert.equal(r.slot, 'midday');
  assert.equal(dispatch('17:07').wait, false);
});

test('bounded: window edges, never past 09:10, never across midnight', () => {
  assert.equal(dispatch('06:00').wait, true);
  assert.equal(dispatch('08:59').wait, true);
  assert.ok(dispatch('08:59').seconds <= 3 * 60);
  assert.equal(dispatch('09:00').wait, false);
  assert.equal(dispatch('23:59').wait, false);
  assert.equal(dispatch('00:30').wait, false);
  const longest = dispatch('06:00');
  assert.equal(longest.seconds, (EARLY_AI.target - EARLY_AI.from) * 60);
  // A 06:00 IST run on the 9th waits for 09:02 on the 9th (UTC date is the 9th 00:30 too).
  assert.equal(new Date(longest.until).toISOString().slice(0, 10), '2026-10-09');
});

test('only publishing ai/auto dispatches wait', () => {
  assert.equal(dispatch('06:07', { dispatchSlot: 'ai' }).wait, true);
  assert.equal(dispatch('06:07', { dispatchSlot: '' }).wait, true);
  assert.equal(dispatch('06:07', { dispatchSlot: 'midday' }).wait, false);
  assert.equal(dispatch('06:07', { publish: false }).wait, false, 'a dry-run dispatch does not sit for 3 h');
  assert.equal(dispatch('06:07', { preview: true }).wait, false);
  assert.equal(dispatch('06:07', { approveBuild: '123' }).wait, false);
  assert.equal(dispatch('06:07', { late: true }).wait, false);
  assert.equal(dispatch('06:07', { env: {} }).wait, false, 'ai slot off → no wait');
  assert.equal(earlyAiWait({ event: 'schedule', dispatchSlot: '', now: at('06:07'), env: ON }).wait, false);
  assert.equal(earlyAiWait({ event: 'repository_dispatch', dispatchSlot: 'ai', now: at('06:07'), env: ON }).wait, true);
});

test('no double post: a held run and a later real ai run', () => {
  // The held run posted ai at 09:09 and recorded it; a later ai run resolves duplicate.
  const entries = [{ date: '2026-10-09 ai', topic: 'x', mediaId: '181' }];
  const later = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('09:43'), entries, env: ON });
  assert.deepEqual([later.pending, later.reason], [false, 'duplicate']);
  // Even with a stale checkout (no ledger row), the post on Instagram claims ai.
  const media = [{ id: '181', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-09T03:39:00+0000' }];
  assert.equal(postedSlots({ media, entries: [], now: at('09:43') }).ai?.mediaId, '181');
  // The build cap counts a held run (started 06:07, built "(ai)") toward ai.
  const runs = [{ id: 1, status: 'completed', run_started_at: at('06:07').toISOString() }];
  assert.equal(slotRunsToday(runs, { slot: 'ai', currentRunId: 2, istDate: '2026-10-09' }).length, 1);
  assert.equal(slotRunsToday(runs, { slot: 'midday', currentRunId: 2, istDate: '2026-10-09' }).length, 0);
  assert.equal(countsFor('ai', { jobs: [{ steps: [{ name: 'Build the carousel (ai)', conclusion: 'success' }] }] }, runs[0]), true);
});

test('ai-wait.js CLI: decides from the clock, writes outputs, exits 0', () => {
  const out = `/tmp/ai-wait-${process.pid}.txt`;
  const run = (now, extra = {}) => {
    fs.writeFileSync(out, '');
    const r = spawnSync('node', ['pipeline/ai-wait.js', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, SLOT_NOW: now, GITHUB_OUTPUT: out, GITHUB_EVENT_NAME: 'workflow_dispatch', DISPATCH_SLOT: 'auto', DISPATCH_PUBLISH: 'true', ENABLE_AI_NEWS_CAROUSELS: 'true', ...extra },
    });
    return { code: r.status, stdout: r.stdout, outputs: fs.readFileSync(out, 'utf8') };
  };
  const early = run('2026-10-09T00:37:05Z');
  assert.equal(early.code, 0);
  assert.match(early.stdout, /06:07 IST — holding until 09:02 IST/);
  assert.match(early.outputs, /wait=true\nuntil=2026-10-09T03:32:00.000Z/);
  const midday = run('2026-10-09T07:37:05Z');
  assert.match(midday.outputs, /wait=false/);
  assert.match(midday.stdout, /No wait/);
  fs.rmSync(out, { force: true });
});

test('workflow: wait job first, bounded; build runs after it with every gate', () => {
  const wf = fs.readFileSync('.github/workflows/carousel.yml', 'utf8');
  const jobs = wf.slice(wf.indexOf('\njobs:\n'));
  const waitJob = jobs.slice(jobs.indexOf('\n  wait:\n'), jobs.indexOf('\n  build:\n'));
  const buildJob = jobs.slice(jobs.indexOf('\n  build:\n'));
  assert.ok(waitJob.length > 0 && buildJob.length > 0);
  const t = Number(waitJob.match(/timeout-minutes: (\d+)/)[1]);
  assert.ok(t >= (EARLY_AI.target - EARLY_AI.from) + 10 && t <= 240);
  assert.match(buildJob, /\n    needs: wait\n/);
  assert.match(buildJob, /\n    if: \$\{\{ !cancelled\(\) \}\}\n/);
  assert.match(buildJob, /\n    timeout-minutes: 20\n/);
  assert.doesNotMatch(wf.slice(0, wf.indexOf('\njobs:\n')), /\nconcurrency:/, 'the queue is on the build job, so a held run blocks nobody');
  assert.match(buildJob, /\n    concurrency:\n      group: .*'carousel'/);
  const step = (name) => buildJob.slice(buildJob.indexOf(`- name: ${name}`)).split('\n      - ')[0];
  assert.match(step('Is this slot still pending?'), /LEDGER_REFRESH_REF: \$\{\{ github\.ref_name \}\}/);
  assert.match(step('Build attempts today'), /needs\.wait\.outputs\.waited == 'true'/);
  assert.match(buildJob, /node pipeline\/post-gate\.js/);
  assert.match(waitJob, /node pipeline\/ai-wait\.js/);
  assert.match(waitJob, /DISPATCH_PUBLISH: \$\{\{ github\.event\.inputs\.publish \}\}/);
  assert.match(waitJob, /waited: \$\{\{ steps\.plan\.outputs\.wait \}\}/);
  // AUTOMATED (which lets a run publish without publish=true) is not widened by the wait.
  assert.doesNotMatch(buildJob.match(/AUTOMATED: .*/)[0], /waited/);
});
