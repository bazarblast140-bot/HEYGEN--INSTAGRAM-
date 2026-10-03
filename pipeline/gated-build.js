#!/usr/bin/env node
// Has this slot already been built today and is it waiting for approval?
//
//   node pipeline/gated-build.js --slot ai --run-id <this run>     # prints, sets exists=true|false
//
// With CAROUSEL_REQUIRE_APPROVAL=true nothing is posted until a person
// approves a build, so the slot stays "pending" and every catch-up cron
// (09:37 / 09:52 / 10:11 after 09:30, and the same for the other slots) would
// generate again, spending model calls on builds nobody asked for. carousel.yml
// runs this before building on scheduled runs only; when an earlier successful
// carousel.yml run today uploaded a 'carousel' artifact whose report is for
// this slot, this IST day and passed the gate (publishable), the catch-up does
// not build. Manual dispatches and approve_build runs never call this, and it
// changes nothing about what is published.
//
// Any error (API, download) → exists=false: a failed check must not cost a slot.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { istParts } from './src/carousel/categories.js';

const run = promisify(execFile);

/** Earlier successful runs of today (IST) worth checking, newest first. */
export function candidateRuns(runs, { currentRunId, istDate, limit = 8 }) {
  return (runs || [])
    .filter((r) => String(r.id) !== String(currentRunId))
    .filter((r) => r.status === 'completed' && r.conclusion === 'success')
    .filter((r) => istParts(new Date(r.created_at)).date === istDate)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

/** A gated build of this slot today: built, passed the gate, never skipped. */
export function isGatedBuild(report, { slot, istDate }) {
  return Boolean(report) && report.skipped !== true && report.publishable === true
    && report.slot === slot && report.istDate === istDate && (report.files || []).length > 0;
}

async function gh(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 16 << 20, timeout: 60000 });
  return stdout;
}

export async function findGatedBuild({ repo, slot, currentRunId, now = new Date(), api = gh }) {
  const istDate = istParts(now).date;
  // created>= is UTC; the IST day starts 18:30 UTC the day before.
  const since = new Date(new Date(`${istDate}T00:00:00+05:30`).getTime()).toISOString().slice(0, 10);
  const list = JSON.parse(await api(['api', `repos/${repo}/actions/workflows/carousel.yml/runs?created=>=${since}&per_page=50`]));
  for (const r of candidateRuns(list.workflow_runs, { currentRunId, istDate })) {
    const arts = JSON.parse(await api(['api', `repos/${repo}/actions/runs/${r.id}/artifacts`]));
    if (!(arts.artifacts || []).some((a) => a.name === 'carousel' && !a.expired)) continue;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gated-'));
    try {
      await api(['run', 'download', String(r.id), '-R', repo, '-n', 'carousel', '-D', dir]);
      const report = JSON.parse(await fs.readFile(path.join(dir, 'carousel-report.json'), 'utf8'));
      if (isGatedBuild(report, { slot, istDate })) return { runId: r.id, topic: report.topic, istDate };
    } catch {
      // no report / unreadable: not a gated build
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const slot = at('--slot'); const currentRunId = at('--run-id');
  const repo = at('--repo') || process.env.GITHUB_REPOSITORY;
  const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  let found = null;
  if (slot && repo) {
    try { found = await findGatedBuild({ repo, slot, currentRunId }); } catch (err) { console.log(`check failed (${String(err.message).slice(0, 120)}) — building as usual`); }
  }
  if (found) {
    console.log(`${found.istDate} ${slot}: run ${found.runId} already built "${found.topic}" and is awaiting approval — this catch-up does not build again.`);
    console.log(`Approve it with: carousel.yml approve_build=${found.runId}`);
  } else {
    console.log(`no gated ${slot || '?'} build yet today — building`);
  }
  await out('exists', found ? 'true' : 'false');
  if (found) await out('run_id', String(found.runId));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(0); });
}
