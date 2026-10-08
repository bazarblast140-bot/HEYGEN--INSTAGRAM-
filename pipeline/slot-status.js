#!/usr/bin/env node
// Should this run publish?
//
// Three slots a day: ai (09:30 IST), midday (12:30 IST, mutual funds) and
// evening (16:45 IST, market close; NSE trading days only). Ledger key is "YYYY-MM-DD <slot>" in IST. A second run in the same window is
// a no-op. A run with no slot publishes only inside one of those windows.

import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { readLedger } from './src/publish/facebook.js';
import { resolveRun } from './src/carousel/categories.js';
import {
  clock, truthy, loadReelMedia, carouselOnInstagram,
} from './src/publish/same-day.js';

// A run held for the ai window (ai-wait.js) checked out its commit hours ago.
// Read the branch's current ledgers too, so a post that landed meanwhile counts.
// Read-only (git fetch + git show); never fatal.
let fetched = null;
function remoteJson(file) {
  const ref = process.env.LEDGER_REFRESH_REF;
  if (!ref || fetched === false) return null;
  try {
    if (fetched === null) {
      fetched = false;
      execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', ref], { stdio: 'ignore', timeout: 60000 });
      fetched = true;
    }
    return JSON.parse(execFileSync('git', ['show', `FETCH_HEAD:${file}`], { encoding: 'utf8', timeout: 30000 }));
  } catch (err) {
    console.log(`(could not read the branch's current ${file}: ${String(err.message).split('\n')[0].slice(0, 100)} — using the checkout)`);
    return null;
  }
}
const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const union = (a, b) => [...a, ...b.filter((row) => !a.some((x) => sameRow(x, row)))];

const remoteCarousel = remoteJson('pipeline/carousel-history.json');
const entries = union(await readHistory(LEDGER), Array.isArray(remoteCarousel?.entries) ? remoteCarousel.entries : []);
const remoteFb = remoteJson('pipeline/fb-crosspost-history.json');
const now = clock();
let decision = resolveRun({
  event: process.env.GITHUB_EVENT_NAME || '',
  dispatchSlot: process.env.DISPATCH_SLOT || '',
  cron: process.env.SCHEDULED_CRON || '',
  now,
  entries,
});

const force = truthy(process.env.FORCE);
if (force && decision.reason === 'duplicate' && decision.slot) {
  decision = { ...decision, pending: true, reason: 'forced', posted: decision.posted };
} else if (decision.pending && decision.slot) {
  const listed = await loadReelMedia();
  // Slot-aware: another slot's recorded post (ledger mediaId, FB copy ledger
  // slot) never makes this slot look posted, even where windows overlap.
  const localFb = readLedger(process.env.FB_LEDGER_FILE || 'pipeline/fb-crosspost-history.json');
  const fbEntries = union(Array.isArray(localFb) ? localFb : [], Array.isArray(remoteFb) ? remoteFb : []);
  const ig = carouselOnInstagram({ media: listed.items, slot: decision.slot, now, entries, fbEntries: Array.isArray(fbEntries) ? fbEntries : [] });
  if (ig) {
    decision = {
      ...decision,
      pending: false,
      reason: 'duplicate',
      posted: { date: decision.key, topic: 'instagram media' },
    };
  } else if (!listed.ok && listed.reason !== 'no-token') {
    console.log('instagram media list unavailable — ledger only');
  }
}

const label = decision.key || decision.date;
if (decision.reason === 'duplicate') {
  console.log(`soft skip — ${label} — already posted: "${decision.posted.topic}". Nothing to do.`);
} else if (decision.reason === 'unknown') {
  console.log(`soft skip — ${label} — unknown slot "${decision.slot}". Skipping.`);
} else if (decision.reason === 'stale') {
  console.log(`soft skip — ${label} — the ${decision.slot} schedule arrived outside its IST window. A missed slot is not backfilled.`);
} else if (decision.reason === 'wrong-time') {
  console.log(`soft skip — ${label} — ${decision.slot} is outside its IST window. Skipping.`);
} else if (decision.reason === 'outside') {
  console.log(`soft skip — ${label} — no slot, and the clock is outside both posting windows. Skipping.`);
} else if (decision.reason === 'market-closed') {
  console.log(`soft skip — ${label} — ${decision.date} is not an NSE trading day (${decision.why}). No market carousel.`);
} else if (decision.reason === 'disabled') {
  console.log(`soft skip — ${label} — ${decision.slot} is off until ENABLE_AI_NEWS_CAROUSELS is true. Skipping.`);
} else if (decision.reason === 'forced') {
  console.log(`${label} — force=true, building this slot again.`);
} else {
  console.log(`${label} — not posted yet.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${decision.pending ? 'true' : 'false'}\nslot=${decision.pending ? decision.slot : ''}\nreason=${decision.reason}\nstarted=${now.toISOString()}\n`,
  );
}
