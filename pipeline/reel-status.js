#!/usr/bin/env node
// Should this reel build and publish?
//
// One reel a day, at 07:00 IST. GitHub often delivers that schedule hours late,
// so a catch-up cron fires again ~22 minutes later. The ledger date is the IST
// day. A second run on that day is a no-op — it must not post twice.

import fs from 'node:fs/promises';

import { readHistory, resolveReelDay, LEDGER } from './src/script/topics.js';

const entries = await readHistory(LEDGER);
const decision = resolveReelDay({ now: new Date(), entries });

if (!decision.pending) {
  console.log(`${decision.date} — already recorded: "${decision.posted.topic}". Nothing to do.`);
} else {
  console.log(`${decision.date} — not recorded yet.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${decision.pending ? 'true' : 'false'}\nreason=${decision.reason}\n`,
  );
}
