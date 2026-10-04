// Approval mode: a catch-up cron does not build a slot again once an earlier
// run today built it and is awaiting approval (no repeated model calls).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { candidateRuns, isGatedBuild, findGatedBuild } from '../pipeline/gated-build.js';

const NOW = new Date('2026-10-04T04:22:00Z');          // 09:52 IST catch-up
const run = (id, created, extra = {}) => ({ id, created_at: created, status: 'completed', conclusion: 'success', ...extra });
const REPORT = { slot: 'ai', istDate: '2026-10-04', publishable: true, files: ['pipeline/out/slides/01.jpg'], topic: 'AI एजेंट' };

test('only earlier successful runs of the same IST day are checked', () => {
  const runs = [
    run(1, '2026-10-04T04:00:30Z'),                               // 09:30 IST, today
    run(2, '2026-10-03T18:00:00Z'),                               // 23:30 IST yesterday
    run(3, '2026-10-03T19:00:00Z', { conclusion: 'failure' }),     // today, failed
    run(4, '2026-10-04T04:22:05Z'),                               // this run
  ];
  assert.deepEqual(candidateRuns(runs, { currentRunId: 4, istDate: '2026-10-04' }).map((r) => r.id), [1]);
});

test('a gated build is this slot, this IST day, passed the gate and has slides', () => {
  const day = { slot: 'ai', istDate: '2026-10-04' };
  assert.equal(isGatedBuild(REPORT, day), true);
  assert.equal(isGatedBuild({ ...REPORT, slot: 'news' }, day), false, 'another slot');
  assert.equal(isGatedBuild({ ...REPORT, istDate: '2026-10-03' }, day), false, 'yesterday');
  assert.equal(isGatedBuild({ ...REPORT, publishable: false }, day), false, 'gate refused — build again');
  assert.equal(isGatedBuild({ ...REPORT, skipped: true }, day), false);
  assert.equal(isGatedBuild({ ...REPORT, files: [] }, day), false);
  assert.equal(isGatedBuild(null, day), false);
});

test('finds the 09:30 build from the 09:52 catch-up; nothing found → build', async () => {
  const fake = (report) => async (args) => {
    if (args[0] === 'api' && args[1].includes('/workflows/carousel.yml/runs')) return JSON.stringify({ workflow_runs: [run(11, '2026-10-04T04:00:30Z'), run(12, '2026-10-04T04:22:05Z')] });
    if (args[0] === 'api' && args[1].endsWith('/artifacts')) return JSON.stringify({ artifacts: [{ name: 'carousel', expired: false }] });
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1];
      if (report) await fs.writeFile(path.join(dir, 'carousel-report.json'), JSON.stringify(report));
      return '';
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  const found = await findGatedBuild({ repo: 'o/r', slot: 'ai', currentRunId: 12, now: NOW, api: fake(REPORT) });
  assert.equal(found.runId, 11);
  assert.equal(await findGatedBuild({ repo: 'o/r', slot: 'news', currentRunId: 12, now: NOW, api: fake(REPORT) }), null);
  assert.equal(await findGatedBuild({ repo: 'o/r', slot: 'ai', currentRunId: 12, now: NOW, api: fake({ ...REPORT, publishable: false }) }), null);
  assert.equal(await findGatedBuild({ repo: 'o/r', slot: 'ai', currentRunId: 12, now: NOW, api: fake(null) }), null, 'no report → build');
});

test('carousel.yml: the guard runs on scheduled runs in approval mode only; manual, approve and publish paths unchanged', async () => {
  const wf = await fs.readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');
  const step = wf.slice(wf.indexOf('- name: Already built and awaiting approval?'), wf.indexOf('- name: Build attempts today'));
  assert.match(step, /if: \$\{\{ env\.APPROVE_BUILD == '' && env\.CAROUSEL_REQUIRE_APPROVAL == 'true' && env\.AUTOMATED == 'true' && steps\.slot\.outputs\.pending == 'true' \}\}/);
  assert.match(step, /continue-on-error: true/);
  const gatedIfs = wf.match(/\(steps\.slot\.outputs\.pending == 'true' && steps\.gated\.outputs\.exists != 'true' && steps\.cap\.outputs\.capped != 'true' && steps\.market\.outputs\.ok != 'false'\) \|\| github\.event\.inputs\.preview == 'true' \|\| github\.event\.inputs\.force == 'true'/g) || [];
  assert.equal(gatedIfs.length, 4, 'keys check, chromium, tesseract and build are skipped when a gated build exists');
  const publish = wf.slice(wf.indexOf('- name: Publish to Instagram'), wf.indexOf('- name: Copy to the Facebook Page'));
  assert.doesNotMatch(publish, /gated/, 'what gets published is not changed');
  assert.doesNotMatch(wf.slice(wf.indexOf('- name: Download the reviewed build'), wf.indexOf('# ---- build path ----')), /gated/, 'approve_build path untouched');
});
