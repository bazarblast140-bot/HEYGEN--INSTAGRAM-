#!/usr/bin/env node
// What is this account actually doing, and is any of it working?
//
//   node pipeline/audit.js
//
// One screen, no opinions: what went out, what did not, and which subjects earn
// the most likes. Likes are a thin measure and they are the only one this token
// may read -- the insights edge answers "(#10) Application does not have
// permission" -- so they are what the report is built on, and it says so.
//
// Written to be run without being asked: on a schedule, and when the laptop
// opens.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../src/config.js';
import { readHistory } from './src/script/topics.js';
import { LEDGER } from './src/carousel/generate.js';
import { fetchPosts, join, byAngle } from './src/publish/engagement.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(HERE, 'engagement.json');

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const DAYS = Number(env('AUDIT_DAYS') || 14);
const since = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);

const entries = (await readHistory(LEDGER)).filter((e) => e.date.slice(0, 10) >= since);

let posts = [];
let live = false;
try {
  posts = await fetchPosts({
    igUserId: env('IG_USER_ID'),
    token: env('IG_ACCESS_TOKEN'),
    surface: env('IG_SURFACE') || 'facebook',
  });
  live = true;
} catch (err) {
  console.log(bad(`Could not read Instagram: ${String(err.message).slice(0, 120)}`));
  try { posts = JSON.parse(await fs.readFile(STORE, 'utf8')).posts || []; } catch { /* none yet */ }
}

if (live) {
  await fs.writeFile(STORE, `${JSON.stringify({ fetched: new Date().toISOString(), posts }, null, 2)}\n`);
}

const rows = join(entries, posts);

console.log(bold(`\nFACTVIZER — last ${DAYS} days\n`));

// 1. Did the posts go out at all? Three a day is the schedule.
const made = entries.length;
console.log(`Posts     ${made} recorded${entries.length ? dim(`  · since ${entries[0].date.slice(0, 10)}`) : ''}`);

// Only days the ledger actually covers. It keeps a fixed number of entries, so
// anything before its oldest one is not a missed post -- it is a trimmed
// record, and reporting it as missed is a false alarm.
const oldest = entries.length ? entries[0].date.slice(0, 10) : null;
const missing = [];
for (let d = 1; d <= DAYS && oldest; d += 1) {
  const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
  if (day < oldest) continue;
  for (const slot of ['morning', 'midday', 'evening']) {
    if (!entries.some((e) => e.date === `${day} ${slot}`)) missing.push(`${day} ${slot}`);
  }
}
console.log(missing.length
  ? bad(`Missed    ${missing.length}  `) + dim(missing.slice(0, 6).join(', ') + (missing.length > 6 ? ` +${missing.length - 6}` : ''))
  : ok('Missed    none'));

// 2. What did they earn.
const scored = rows.filter((r) => r.likes != null);
if (!scored.length) {
  console.log(bad('\nNo engagement figures — Instagram was unreachable and nothing is stored yet.'));
} else {
  const likes = scored.reduce((a, r) => a + r.likes, 0);
  const comments = scored.reduce((a, r) => a + (r.comments || 0), 0);
  console.log(`Likes     ${likes} across ${scored.length} posts  ${dim(`avg ${(likes / scored.length).toFixed(1)}`)}`);
  console.log(`Comments  ${comments}`);

  console.log(bold('\nBy subject       posts   avg likes   best'));
  for (const g of byAngle(scored)) {
    const line = `  ${g.angle.padEnd(14)} ${String(g.posts).padStart(3)}   ${g.average.toFixed(1).padStart(8)}   ${g.best.likes} · ${g.best.topic.slice(0, 32)}`;
    console.log(g.average >= 3 ? ok(line) : line);
  }

  const top = [...scored].sort((a, b) => b.likes - a.likes).slice(0, 3);
  console.log(bold('\nBest posts'));
  for (const r of top) console.log(`  ${String(r.likes).padStart(3)} likes  ${dim(r.date)}  ${r.topic}`);
}

console.log(dim('\nLikes and comments only — this token may not read reach or saves.'));
