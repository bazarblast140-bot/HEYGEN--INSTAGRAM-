#!/usr/bin/env node
// Approve one built carousel for publishing — the human slide-review gate.
//
//   node pipeline/approve-build.js --report pipeline/out/carousel-report.json   # check, print slot
//   node pipeline/approve-build.js --report ... --record                       # after publish: ledger
//
// With the repository variable CAROUSEL_REQUIRE_APPROVAL=true a scheduled run
// only BUILDS and uploads the slides (artifact "carousel"). A person looks at
// them and dispatches carousel.yml with approve_build=<that run id>; the
// workflow downloads that exact artifact and this script decides whether it may
// go out. The slides posted are byte-for-byte the slides reviewed (the
// report's sha256 is re-checked), never a regeneration.
//
// Refused: a skipped / failed-gate / PNG build; files that do not match the
// hash; a build from another IST day; a slot whose IST window is over (a missed
// slot is never backfilled); a slot that the ledger already shows as posted.

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { ALL_SLOTS, inWindow, istParts } from './src/carousel/categories.js';
import { readHistory, recordTopic } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';

export async function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(await fs.readFile(f));
  return h.digest('hex');
}

export async function approvalProblems(report, { now = new Date(), entries = [], files = true } = {}) {
  const problems = [];
  if (!report || report.skipped) return ['the build was skipped — nothing to approve'];
  if (report.publishable !== true) problems.push('the build is not publishable');
  if (report.quality && report.quality.ok === false) problems.push(`the quality gate refused it: ${(report.quality.problems || []).slice(0, 3).join('; ')}`);
  if (report.format && report.format !== 'jpeg') problems.push(`the build is ${report.format}, not jpeg`);
  if (!(report.files || []).length) problems.push('the report lists no slides');
  const slot = report.slot;
  if (!ALL_SLOTS.includes(slot)) problems.push(`the build has no known slot ("${slot}")`);
  const today = istParts(now).date;
  if (report.istDate !== today) problems.push(`the build is from ${report.istDate || 'an unknown day'} (IST); today is ${today} — stale builds are not posted`);
  if (ALL_SLOTS.includes(slot) && !inWindow(slot, now)) problems.push(`the ${slot} window is closed — a missed slot is not backfilled`);
  const key = `${today} ${slot}`;
  if (entries.some((e) => e.date === key)) problems.push(`${key} is already posted`);
  if (files && report.contentHash) {
    try {
      const actual = await hashFiles([...(report.files || []), ...(report.stories || [])]);
      if (actual !== report.contentHash) problems.push('the downloaded slides do not match the reviewed build (sha256 differs)');
    } catch (err) {
      problems.push(`slides missing: ${err.message}`);
    }
  } else if (files) {
    problems.push('the build carries no content hash');
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const reportPath = at('--report') || 'pipeline/out/carousel-report.json';
  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };

  if (args.includes('--record')) {
    const date = `${report.istDate} ${report.slot}`;
    await recordTopic({ topic: report.topic, angle: report.category, date, file: LEDGER });
    console.log(`recorded ${date}: "${report.topic}"`);
    return;
  }

  const problems = await approvalProblems(report, { entries: await readHistory(LEDGER) });
  if (problems.length) {
    console.log(`NOT APPROVED — this build will not be published:\n  ${problems.join('\n  ')}`);
    await out('ok', 'false');
    process.exitCode = 1;
    return;
  }
  console.log(`approved: ${report.istDate} ${report.slot} — "${report.topic}" (${report.files.length} slides, sha256 ${report.contentHash.slice(0, 12)})`);
  await out('ok', 'true');
  await out('slot', report.slot);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
