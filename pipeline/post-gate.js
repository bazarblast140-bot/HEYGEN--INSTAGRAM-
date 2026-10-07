#!/usr/bin/env node
// Direct-post gate (CAROUSEL_REQUIRE_APPROVAL off): the same checks an
// approve_build gets, run on this run's own build. Any problem is a HARD
// block: the slot is skipped — no Instagram post, no Story, no Facebook copy —
// with the reasons in the step summary. Never fails the job.
//
//   node pipeline/post-gate.js --report pipeline/out/carousel-report.json   # sets ok=true|false

import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { approvalProblems } from './approve-build.js';
import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';

// The build records today's topic in the working copy's ledger before this gate
// runs, so the working file always "contains" this slot. Only a COMMITTED entry
// (written after a real post) means the slot is already posted.
export function committedEntries(file = LEDGER) {
  try {
    const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
    const raw = execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : (data.entries || []);
  } catch { return null; }
}

export async function postProblems(reportPath, { now = new Date(), entries } = {}) {
  let report;
  try { report = JSON.parse(await fs.readFile(reportPath, 'utf8')); } catch { return ['no build report — nothing was built']; }
  if (report.skipped) return [`the build skipped: ${report.reason || 'no reason given'}`];
  return approvalProblems(report, {
    now,
    late: /^(1|true|yes)$/i.test(String(process.env.DISPATCH_LATE || '')),
    startedAt: process.env.SLOT_STARTED_AT || null,
    entries: entries ?? committedEntries() ?? await readHistory(LEDGER),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--report');
  const reportPath = i >= 0 ? args[i + 1] : 'pipeline/out/carousel-report.json';
  const problems = await postProblems(reportPath);
  if (problems.length) {
    console.log('## Skipped — nothing posted (no IG post, no Story, no FB copy)');
    problems.forEach((p) => console.log(`- ${p}`));
  } else {
    console.log('Post gate passed: code-checked numbers, verified sources, Hinglish, layout and slot checks all OK.');
  }
  if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `ok=${problems.length ? 'false' : 'true'}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.log(`## Skipped — the post gate could not run (${err.message}). Nothing posted.`);
    if (process.env.GITHUB_OUTPUT) fs.appendFile(process.env.GITHUB_OUTPUT, 'ok=false\n').finally(() => process.exit(0));
  });
}
