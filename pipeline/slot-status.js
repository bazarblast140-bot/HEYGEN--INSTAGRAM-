#!/usr/bin/env node
// Has this slot already been posted today?
//
//   node pipeline/slot-status.js
//
// 4 slots/day: morning, midday, afternoon, evening — each with its own topic.
// Ledger key is "YYYY-MM-DD <slot>". Catch-up crons for the same slot are
// no-ops once that key exists.

import fs from 'node:fs/promises';

import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { slotFor, slotForCron, SLOTS } from './src/carousel/categories.js';

const now = new Date();
const date = now.toISOString().slice(0, 10);
const slot =
  (process.env.DISPATCH_SLOT || '').trim()
  || slotForCron(process.env.SCHEDULED_CRON)
  || slotFor(now);
const key = `${date} ${slot}`;

if (!SLOTS.includes(slot)) {
  console.log(`${key} — unknown slot (allowed: ${SLOTS.join(', ')}). Skipping.`);
  if (process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `pending=false\nslot=${slot}\n`);
  }
  process.exit(0);
}

const entries = await readHistory(LEDGER);
const posted = entries.find((e) => e.date === key);

if (posted) {
  console.log(`${key} — already posted: "${posted.topic}". Nothing to do.`);
} else {
  console.log(`${key} — not posted yet.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${posted ? 'false' : 'true'}\nslot=${slot}\n`,
  );
}
