#!/usr/bin/env node
// Should this Reel build and publish?
//
// One Reel a day, aimed at 07:00 IST. Catch-up crons fire again later because
// GitHub drops schedules. Skip only when today's Reel already published
// (media id in reel-publish-history.json, or a Reel on the Instagram media
// list). A topic row is not enough: the 2 Oct 2026 run recorded its topic
// and then failed hosting, so nothing reached the feed.
//
// force=true (workflow input, or FORCE=true) builds anyway.

import fs from 'node:fs/promises';

import { clock, decideReelDay, truthy } from './src/publish/same-day.js';

const force = truthy(process.env.FORCE);
const decision = await decideReelDay({ now: clock(), force });

if (!decision.pending) {
  console.log(`soft skip — reel already published today (${decision.date}) via ${decision.via}. Nothing will be published.`);
} else if (decision.reason === 'forced') {
  console.log(`${decision.date} — force=true, building even if a Reel is already up today.`);
} else {
  console.log(`${decision.date} — no published Reel today.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${decision.pending ? 'true' : 'false'}\nreason=${decision.reason}\n`,
  );
}
