#!/usr/bin/env node
// 30 minutes after each enabled slot, open or update one health-alert issue
// if that slot has not published today (IST). Close it when the publish lands.
//
// Reel, midday, and evening are always checked. AI and news are checked only
// when ENABLE_AI_NEWS_CAROUSELS is on. This does not dispatch a build.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clock, istDate, readReelPublishes, loadReelMedia } from './src/publish/same-day.js';
import {
  missedSlots, alertPlan, applyAlertPlan, listOpenAlerts,
} from './src/health/missed-publish.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function readEntries(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
}

const now = clock();
const date = istDate(now);
const env = process.env;
const reelPublishEntries = await readReelPublishes(env.REEL_PUBLISH_FILE || undefined);
const carouselEntries = await readEntries(path.join(HERE, 'carousel-history.json'));
const listed = await loadReelMedia({ env });
const media = listed.items;

const missed = missedSlots({
  now,
  env,
  reelPublishEntries,
  carouselEntries,
  media,
});
const openIssues = await listOpenAlerts({
  repo: env.GITHUB_REPOSITORY,
  token: env.GITHUB_TOKEN,
});
const plan = alertPlan({ date, missed, openIssues });

console.log(missed.length
  ? `${date} — missing: ${missed.join(', ')} (${plan.action})`
  : `${date} — every due slot has published (${plan.action})`);

if (!listed.ok && listed.reason !== 'no-token') {
  console.log('instagram media list unavailable — ledger only');
}

try {
  const result = await applyAlertPlan({
    plan,
    repo: env.GITHUB_REPOSITORY,
    token: env.GITHUB_TOKEN,
  });
  if (result.number) console.log(`health-alert #${result.number} ${result.action}`);
  if (result.numbers?.length) console.log(`closed health-alert ${result.numbers.join(', ')}`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
