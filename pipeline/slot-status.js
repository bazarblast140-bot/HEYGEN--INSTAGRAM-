#!/usr/bin/env node
// Should this run publish?
//
// Three slots a day: ai (09:30 IST), midday (12:30 IST, mutual funds) and
// evening (16:45 IST, market close; NSE trading days only). Ledger key is "YYYY-MM-DD <slot>" in IST. A second run in the same window is
// a no-op. A run with no slot publishes only inside one of those windows.

import fs from 'node:fs/promises';

import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { readLedger } from './src/publish/facebook.js';
import { resolveRun } from './src/carousel/categories.js';
import {
  clock, truthy, loadReelMedia, carouselOnInstagram,
} from './src/publish/same-day.js';

const entries = await readHistory(LEDGER);
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
  const fbEntries = readLedger(process.env.FB_LEDGER_FILE || 'pipeline/fb-crosspost-history.json');
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
