#!/usr/bin/env node
// Has this slot already been posted today?
//
//   node pipeline/slot-status.js
//
// GitHub's scheduler is best-effort. A cron entry is a request, not a promise:
// runs at busy minutes are delayed by tens of minutes and are sometimes dropped
// altogether, with nothing in the Actions list to show for it. That is exactly
// what happened to the first 06:00 post -- no run, no failure, no trace.
//
// So each slot is scheduled twice, and this is what stops the second firing
// from posting again. The ledger already records "2026-08-31 morning" when a
// post actually goes out, and that record is the only trustworthy answer to
// "did today's morning post happen" -- more trustworthy than the run list,
// because it is written by the thing that published.
//
// Prints one line, and writes `pending` to $GITHUB_OUTPUT for the workflow to
// gate on. Exits 0 either way: "already posted" is a success, not a failure.

import fs from 'node:fs/promises';

import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { slotFor } from './src/carousel/categories.js';

const now = new Date();
const date = now.toISOString().slice(0, 10);
const slot = slotFor(now);
const key = `${date} ${slot}`;

const entries = await readHistory(LEDGER);
const posted = entries.find((e) => e.date === key);

if (posted) {
  console.log(`${key} — already posted: "${posted.topic}". Nothing to do.`);
} else {
  console.log(`${key} — not posted yet.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(process.env.GITHUB_OUTPUT, `pending=${posted ? 'false' : 'true'}\n`);
}
