#!/usr/bin/env node
// Should this run publish?
//
// Two finance slots a day: midday (about 12:30 IST) and evening (about 19:30 IST).
// Ledger key is "YYYY-MM-DD <slot>" in IST. A second run in the same window is
// a no-op. A run with no slot publishes only inside one of those windows.

import fs from 'node:fs/promises';

import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { resolveRun } from './src/carousel/categories.js';

const entries = await readHistory(LEDGER);
const decision = resolveRun({
  event: process.env.GITHUB_EVENT_NAME || '',
  dispatchSlot: process.env.DISPATCH_SLOT || '',
  cron: process.env.SCHEDULED_CRON || '',
  now: new Date(),
  entries,
});

const label = decision.key || decision.date;
if (decision.reason === 'duplicate') {
  console.log(`${label} — already posted: "${decision.posted.topic}". Nothing to do.`);
} else if (decision.reason === 'unknown') {
  console.log(`${label} — unknown slot "${decision.slot}". Skipping.`);
} else if (decision.reason === 'wrong-time') {
  console.log(`${label} — ${decision.slot} is outside its IST window. Skipping.`);
} else if (decision.reason === 'outside') {
  console.log(`${label} — no slot, and the clock is outside both posting windows. Skipping.`);
} else if (decision.reason === 'disabled') {
  console.log(`${label} — ${decision.slot} is off until ENABLE_AI_NEWS_CAROUSELS is true. Skipping.`);
} else {
  console.log(`${label} — not posted yet.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${decision.pending ? 'true' : 'false'}\nslot=${decision.pending ? decision.slot : ''}\nreason=${decision.reason}\n`,
  );
}
