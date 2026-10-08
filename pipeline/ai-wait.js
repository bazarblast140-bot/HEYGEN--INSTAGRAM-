#!/usr/bin/env node
// Hold an early publishing dispatch until the ai window opens (issue #61).
//
//   node pipeline/ai-wait.js            decide, and sleep if needed
//   node pipeline/ai-wait.js --dry-run  decide only
//
// Writes wait=true|false (and until=) to GITHUB_OUTPUT. It decides nothing
// about posting: the build job runs slot-status, the build cap and the post
// gate after this returns, so the ledger and Instagram are read at ~09:02 IST.
// Never sleeps past 09:10 IST. Always exits 0.

import fs from 'node:fs/promises';
import { earlyAiWait, istParts, EARLY_AI } from './src/carousel/categories.js';
import { clock, truthy } from './src/publish/same-day.js';

const env = process.env;
const now = clock(env);
const plan = earlyAiWait({
  event: env.GITHUB_EVENT_NAME || '',
  dispatchSlot: env.DISPATCH_SLOT || '',
  now,
  env,
  publish: truthy(env.DISPATCH_PUBLISH),
  preview: truthy(env.DISPATCH_PREVIEW),
  approveBuild: env.APPROVE_BUILD || '',
  late: truthy(env.DISPATCH_LATE),
});

const hhmm = (d) => { const m = istParts(d).minutes; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

if (env.GITHUB_OUTPUT) {
  await fs.appendFile(env.GITHUB_OUTPUT, `wait=${plan.wait}\nuntil=${plan.until || ''}\n`);
}

if (!plan.wait) {
  console.log(`No wait (${plan.reason}) — ${hhmm(now)} IST.`);
  process.exit(0);
}

console.log(`Early ai dispatch at ${hhmm(now)} IST — holding until ${hhmm(new Date(plan.until))} IST (${Math.round(plan.seconds / 60)} min), then the normal ai flow with every gate.`);
if (process.argv.includes('--dry-run')) process.exit(0);

const deadline = Date.parse(plan.deadline);
const until = Date.parse(plan.until);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
while (Date.now() < until) {
  const left = until - Date.now();
  await sleep(Math.min(left, 15 * 60000));
  if (Date.now() < until) console.log(`  ${hhmm(new Date())} IST — ${Math.round((until - Date.now()) / 60000)} min to go`);
}
const done = new Date();
console.log(Date.now() > deadline
  ? `Woke at ${hhmm(done)} IST, after the ${String(Math.floor(EARLY_AI.deadline / 60)).padStart(2, '0')}:${String(EARLY_AI.deadline % 60).padStart(2, '0')} bound — the build job still decides from the clock.`
  : `Woke at ${hhmm(done)} IST — handing over to the ai flow.`);
