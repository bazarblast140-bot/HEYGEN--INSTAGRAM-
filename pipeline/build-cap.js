#!/usr/bin/env node
// Cap the model builds per slot per IST day (catch-ups must not loop on the
// script model). Counts earlier carousel.yml runs today whose "Build the
// carousel" step actually ran (success or failure) inside this slot's IST
// window. A posted slot never gets here (the ledger stops it first), so this
// only stops repeated builds that were refused or failed.
//
//   node pipeline/build-cap.js --slot midday --run-id <this run> [--max 2]   # sets capped=true|false
//
// Any API error → capped=false (the check must not cost a slot). The 20-min
// fallback crons are still bounded: each run that gets this far re-checks the
// ledger first, and the cap stops the model after 2 builds.

import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { istParts, inWindow, EARLY_AI } from './src/carousel/categories.js';

export const MAX_BUILDS_PER_SLOT = 2;
export const BUILD_STEP = 'Build the carousel';

const run = promisify(execFile);
const gh = async (args) => (await run('gh', args, { maxBuffer: 16 << 20, timeout: 60000 })).stdout;

/** Earlier completed runs today (IST) that started inside the slot's window. */
export function slotRunsToday(runs, { slot, currentRunId, istDate }) {
  return (runs || [])
    .filter((r) => String(r.id) !== String(currentRunId) && r.status === 'completed')
    .filter((r) => {
      const at = new Date(r.run_started_at || r.created_at);
      // A run held for the ai window (ai-wait.js) started 06:00–09:00 IST and
      // built ai after 09:02; its "(ai)" step name decides (countsFor).
      const m = istParts(at).minutes;
      const early = slot === 'ai' && m >= EARLY_AI.from && m < EARLY_AI.until;
      return istParts(at).date === istDate && (inWindow(slot, at) || early);
    });
}

// The workflow names the build step "Build the carousel (<slot>)", so a run
// is counted for the slot it actually built, even where the ai and midday
// windows overlap (12:00–12:30 IST). An older run named just "Build the
// carousel" falls back to the window its run started in.
const STEP_RE = /^Build the carousel(?: \(([a-z]*)\))?$/;

/** The slot whose build step ran in these jobs: a slot name, '' (unnamed, older run), or null (no build ran). */
export function builtSlot(jobs) {
  for (const j of jobs?.jobs || []) {
    for (const s of j.steps || []) {
      const m = String(s.name || '').match(STEP_RE);
      if (m && ['success', 'failure'].includes(s.conclusion)) return m[1] || '';
    }
  }
  return null;
}

/** Did this run's build step run (it called the model)? */
export function built(jobs) {
  return builtSlot(jobs) !== null;
}

/** Whether a run's build counts toward `slot`'s cap. */
export function countsFor(slot, jobs, run) {
  const got = builtSlot(jobs);
  if (got === null) return false;
  if (got) return got === slot;
  return inWindow(slot, new Date(run?.run_started_at || run?.created_at));
}

export async function countBuilds({ repo, slot, currentRunId, now = new Date(), api = gh }) {
  const istDate = istParts(now).date;
  const since = new Date(new Date(`${istDate}T00:00:00+05:30`).getTime()).toISOString().slice(0, 10);
  const list = JSON.parse(await api(['api', `repos/${repo}/actions/workflows/carousel.yml/runs?created=>=${since}&per_page=50`]));
  let n = 0;
  for (const r of slotRunsToday(list.workflow_runs, { slot, currentRunId, istDate })) {
    if (countsFor(slot, JSON.parse(await api(['api', `repos/${repo}/actions/runs/${r.id}/jobs`])), r)) n += 1;
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const slot = at('--slot'); const currentRunId = at('--run-id');
  const max = Number(at('--max') || MAX_BUILDS_PER_SLOT);
  const repo = at('--repo') || process.env.GITHUB_REPOSITORY;
  let n = 0;
  try { if (slot && repo) n = await countBuilds({ repo, slot, currentRunId }); } catch (err) {
    console.log(`build count unavailable (${String(err.message).slice(0, 120)}) — building`);
  }
  const capped = n >= max;
  console.log(capped
    ? `## Skipped — ${slot} already built ${n} time(s) today without posting (cap ${max}). No model call, nothing posted (no IG post, no Story, no FB copy).`
    : `${slot}: ${n} earlier build(s) today (cap ${max}) — building`);
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `capped=${capped}\nbuilds=${n}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(0); });
}
