#!/usr/bin/env node
// Should this Reel build and publish?
//
// The own Reel is an evening FALLBACK (about 21:47 IST, catch-ups until about
// 22:41 IST). Paise Ki Pathshala already posts up to three Reels a day to the
// same account, so this one goes out only on a day with no Reel at all.
//
// Soft skip (exit 0, pending=false) — before DeepSeek, ElevenLabs or any other
// paid step — when:
//   * today's own Reel already published (reel-publish-history.json), or
//   * ANY Reel is on the Instagram media list dated today (IST), Paise or own, or
//   * the Instagram media list cannot be read (fail closed, after one retry).
// A topic row is not enough: the 2 Oct 2026 run recorded its topic and then
// failed hosting, so nothing reached the feed.
//
// force=true (workflow input, or FORCE=true) builds anyway.

import fs from 'node:fs/promises';

import { clock, decideFallbackReel, truthy } from './src/publish/same-day.js';

const force = truthy(process.env.FORCE);
const decision = await decideFallbackReel({ now: clock(), force });

if (decision.reason === 'unverified') {
  console.log(`soft skip — ${decision.date}: could not confirm whether a Reel is already up today — ${decision.via}. Nothing will be built or published.`);
} else if (!decision.pending) {
  const what = decision.via === 'instagram'
    ? `a Reel is already on Instagram today (media ${decision.posted?.mediaId || '?'})`
    : 'our own Reel is in reel-publish-history.json';
  console.log(`soft skip — reel already published today (${decision.date}): ${what}. Nothing will be published.`);
} else if (decision.reason === 'forced') {
  console.log(`${decision.date} — force=true, building even if a Reel is already up today.`);
} else {
  console.log(`${decision.date} — no Reel on Instagram today; the evening fallback Reel is due.`);
}

if (process.env.GITHUB_OUTPUT) {
  await fs.appendFile(
    process.env.GITHUB_OUTPUT,
    `pending=${decision.pending ? 'true' : 'false'}\nreason=${decision.reason}\n`,
  );
}
