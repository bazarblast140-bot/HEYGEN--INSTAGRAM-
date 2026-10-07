#!/usr/bin/env node
// Story + Facebook Reel for every Paise Ki Pathshala Reel (pkp:video:<id>)
// on the account, never our own Reels. See src/publish/companion.js.
//
//   node pipeline/reel-companion.js --dry-run          # print the plan only
//   node pipeline/reel-companion.js --commit --branch B
//
// Off unless ENABLE_REEL_COMPANION is true (a dry run works either way).
// The Facebook half also needs FB_CROSSPOST=true. Always exits 0.

import { parseArgs } from 'node:util';
import fs from 'node:fs';

import {
  runCompanion, gitLedgerSync, COMPANION_LEDGER, FB_LEDGER,
} from './src/publish/companion.js';
import { FB_STORY_LEDGER } from './src/publish/fb-story.js';

const { values: a } = parseArgs({
  options: {
    'dry-run': { type: 'boolean', default: false },
    commit: { type: 'boolean', default: false },
    branch: { type: 'string', default: process.env.GITHUB_REF_NAME || '' },
  },
});

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const dryRun = a['dry-run'] || truthy(process.env.DRY_RUN);

async function main() {
  const lines = [];
  const log = (line) => { lines.push(line); console.log(line); };
  const git = a.commit && a.branch && !dryRun
    ? gitLedgerSync({ branch: a.branch, files: [COMPANION_LEDGER, FB_LEDGER, FB_STORY_LEDGER], log })
    : null;
  const result = await runCompanion({
    dryRun,
    log,
    ...(git ? { sync: git.sync, commit: git.commit } : {}),
  });
  const summary = {
    dryRun,
    reels: result.plan.length,
    planned: result.plan.filter((p) => p.action === 'handle').map((p) => ({
      igMediaId: p.id, timestamp: p.timestamp, marker: p.marker, story: p.doStory, fb: p.doFb,
    })),
    skipped: result.plan.filter((p) => p.action === 'skip').map((p) => ({ igMediaId: p.id, reason: p.reason })),
    stories: result.stories,
    fb: result.fb,
    fbStories: result.fbStories,
    failures: result.failures,
  };
  fs.mkdirSync('pipeline/out', { recursive: true });
  fs.writeFileSync('pipeline/out/reel-companion.json', `${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((err) => {
  console.log(`Reel companion: ${String(err?.message || err).replace(/access_token=[^&\s]+/g, 'access_token=***').slice(0, 300)}`);
}).finally(() => process.exit(0));
