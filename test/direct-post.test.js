// CAROUSEL_REQUIRE_APPROVAL off: carousels post directly, and every automated
// gate is a hard block that skips the slot (no IG post, no Story, no FB copy).
// Catch-ups are capped so they never loop on the script model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { postProblems } from '../pipeline/post-gate.js';
import { hashFiles } from '../pipeline/approve-build.js';
import { slotRunsToday, built, countBuilds, MAX_BUILDS_PER_SLOT } from '../pipeline/build-cap.js';

const wf = await fs.readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');
const step = (name) => wf.slice(wf.indexOf(`- name: ${name}`)).split('\n      - ')[0];
const cond = (name) => step(name).split('\n').find((l) => l.trim().startsWith('if:')) || '';

async function report(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-'));
  const files = [path.join(dir, '01.jpg')];
  await fs.writeFile(files[0], 'a');
  const r = {
    files, stories: [], format: 'jpeg', publishable: true, quality: { ok: true, problems: [] },
    slot: 'midday', istDate: '2026-10-05', topic: 'SIP', category: 'mutual-funds', contentHash: await hashFiles(files), ...over,
  };
  const p = path.join(dir, 'carousel-report.json');
  await fs.writeFile(p, JSON.stringify(r));
  return p;
}
const noon = new Date('2026-10-05T07:05:00Z'); // 12:35 IST

test('post gate: a clean build passes; every failed gate is a skip with a reason', async () => {
  assert.deepEqual(await postProblems(await report(), { now: noon, entries: [] }), []);
  const cases = [
    [{ quality: { ok: false, problems: ['slide 3 has number(s) 52 that are not in the calculation'] }, publishable: false }, /quality gate refused it: slide 3 has number/],
    [{ quality: { ok: false, problems: ['slide 2 source "Reuters" is not a fetched item'] }, publishable: false }, /source "Reuters"/],
    [{ quality: { ok: false, problems: ['slide 4 uses heavy word(s) अवधि'] }, publishable: false }, /heavy word/],
    [{ quality: { ok: false, problems: ['slide 2 headline is 70 characters (limit 48) and cannot be trimmed safely'] }, publishable: false }, /limit 48/],
    [{ skipped: true, reason: 'no fresh verifiable ai source inside 48 hours' }, /the build skipped: no fresh/],
    [{ format: 'png' }, /png/],
    [{ istDate: '2026-10-04' }, /stale builds are not posted/],
  ];
  for (const [over, re] of cases) assert.match((await postProblems(await report(over), { now: noon, entries: [] })).join(' '), re);
  assert.match((await postProblems(await report(), { now: noon, entries: [{ date: '2026-10-05 midday' }] })).join(' '), /already posted/);
  assert.match((await postProblems('/nonexistent/report.json', { now: noon })).join(' '), /no build report/);
  const evening = { slot: 'evening', category: 'latest-news' };
  const at1700 = new Date('2026-10-05T11:30:00Z');
  assert.match((await postProblems(await report({ ...evening, market: null }), { now: at1700, entries: [] })).join(' '), /market close in the build is from nowhere/);
  assert.deepEqual(await postProblems(await report({ ...evening, market: { date: '2026-10-05' } }), { now: at1700, entries: [] }), []);
});

test('carousel.yml: with approval off only a build that passed the post gate is published', () => {
  const publish = cond('Publish to Instagram');
  assert.match(publish, /env\.CAROUSEL_REQUIRE_APPROVAL != 'true'[\s\S]*steps\.postgate\.outputs\.ok == 'true'/);
  assert.match(cond('May this build be posted?'), /env\.CAROUSEL_REQUIRE_APPROVAL != 'true' && steps\.build\.outcome == 'success'/);
  assert.match(step('May this build be posted?'), /node pipeline\/post-gate\.js/);
  // Story is posted by publish-carousel inside the publish step; FB copy and the ledger need a successful publish.
  assert.match(cond('Copy to the Facebook Page'), /steps\.publish\.outcome == 'success'/);
  assert.match(cond('Remember this post\'s topic'), /steps\.publish\.outcome == 'success'/);
  // The no-rebuild guard only exists in approval mode, so it cannot block a direct post.
  assert.match(cond('Already built and awaiting approval?'), /env\.CAROUSEL_REQUIRE_APPROVAL == 'true'/);
  assert.doesNotMatch(publish, /steps\.gated/);
  // Every build step respects the per-day cap and the evening market check.
  for (const name of ['Check the script-writing keys', 'Install Chromium for Playwright', 'Install tesseract (cover photo text check)', 'Build the carousel']) {
    assert.match(cond(name), /steps\.cap\.outputs\.capped != 'true' && steps\.market\.outputs\.ok != 'false'/, name);
  }
  assert.match(step('Market close verified for today?'), /steps\.slot\.outputs\.slot == 'evening'/);
  assert.match(step('Build attempts today'), /build-cap\.js/);
  assert.match(step('Skipped — nothing posted'), /no IG post, no Story, no FB copy/);
});

test('build cap: earlier builds of this slot today count; other slots, days and the current run do not', async () => {
  const runs = [
    { id: 1, status: 'completed', run_started_at: '2026-10-05T07:00:30Z' }, // 12:30 IST midday
    { id: 2, status: 'completed', run_started_at: '2026-10-05T07:07:30Z' }, // 12:37 IST midday
    { id: 3, status: 'completed', run_started_at: '2026-10-05T04:00:30Z' }, // ai
    { id: 4, status: 'completed', run_started_at: '2026-10-04T07:00:30Z' }, // yesterday
    { id: 5, status: 'in_progress', run_started_at: '2026-10-05T07:22:30Z' }, // this run
  ];
  assert.deepEqual(slotRunsToday(runs, { slot: 'midday', currentRunId: 5, istDate: '2026-10-05' }).map((r) => r.id), [1, 2]);
  const jobs = (c) => ({ jobs: [{ steps: [{ name: 'Build the carousel', conclusion: c }] }] });
  assert.equal(built(jobs('success')), true);
  assert.equal(built(jobs('failure')), true);
  assert.equal(built(jobs('skipped')), false);
  const api = async ([, url]) => JSON.stringify(url.includes('/jobs')
    ? jobs(url.includes('/runs/1/') ? 'failure' : url.includes('/runs/2/') ? 'success' : 'skipped')
    : { workflow_runs: runs });
  const n = await countBuilds({ repo: 'o/r', slot: 'midday', currentRunId: 5, now: new Date('2026-10-05T07:22:40Z'), api });
  assert.equal(n, 2);
  assert.ok(n >= MAX_BUILDS_PER_SLOT, 'the third catch-up does not call the model again');
  assert.equal(MAX_BUILDS_PER_SLOT, 2);
});
