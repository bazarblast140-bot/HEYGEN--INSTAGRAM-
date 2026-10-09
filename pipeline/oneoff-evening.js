#!/usr/bin/env node
// One-off evening carousel (evening-oneoff.yml): post a reviewed, committed
// package of slides + caption (+ Story) as TODAY's evening carousel, through the
// normal publish code, exactly once — and make the scheduled evening run
// (16:45 IST cron, catch-ups, the external 17:07 dispatch) see "evening" as
// already posted, so it can never double-post.
//
//   node pipeline/oneoff-evening.js --pkg <dir> --sha-only
//   node pipeline/oneoff-evening.js --pkg <dir> --mode check   [--sha <sha>]
//   node pipeline/oneoff-evening.js --pkg <dir> --mode publish --sha <sha> --claim
//   node pipeline/oneoff-evening.js --pkg <dir> --record <ig media id>
//   node pipeline/oneoff-evening.js --pkg <dir> --mode release
//
// The claim is the ledger row "<IST date> evening" in pipeline/carousel-history.json
// (the same key slot-status.js reads). It is written and pushed BEFORE anything
// is posted, so a second run, a re-run or the scheduled run all find it and stop.
// Fail closed: a publish that fails after the claim leaves evening claimed (no
// evening post today rather than a possible second one); `--mode release`
// removes the claim only when the row has no media id and Instagram shows no
// carousel today since the claim.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { packageSha } from './repost.js';
import { istParts, slotClosedToday } from './src/carousel/categories.js';
import { isCarouselMedia, clock } from './src/publish/same-day.js';

export const LEDGER = 'pipeline/carousel-history.json';
export const FB_LEDGER = 'pipeline/fb-crosspost-history.json';
export const SLOT = 'evening';
// Post-close only, and finished well before the evening window (16:30 IST)
// opens, so it can never race the scheduled 16:45 run.
export const NOT_BEFORE = 15 * 60 + 30;
export const NOT_AFTER = 16 * 60 + 25;
const MAX_CAPTION = 2200;
const MAX_TAGS = 30;

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Width/height of a baseline or progressive JPEG, or null when it is not a JPEG. */
export function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i += 1; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/** Problems with a committed package (slides, Story, caption, report), or []. */
export async function packageProblems(dir) {
  const out = [];
  let report;
  try { report = JSON.parse(await fs.readFile(path.join(dir, 'carousel-report.json'), 'utf8')); } catch (err) {
    return [`no readable carousel-report.json in ${dir} (${String(err.message).slice(0, 80)})`];
  }
  if (report.slot !== SLOT) out.push(`report.slot is "${report.slot}", expected "${SLOT}"`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(report.istDate || ''))) out.push('report.istDate is not YYYY-MM-DD');
  if (report.format !== 'jpeg') out.push('report.format is not jpeg');
  if (report.quality?.ok !== true) out.push('report.quality.ok is not true');
  const files = report.files || [];
  if (files.length < 2 || files.length > 10) out.push(`${files.length} slides — a carousel takes 2–10`);
  const check = async (f, w, h, what) => {
    const rel = path.relative(dir, f);
    if (rel.startsWith('..') || path.isAbsolute(rel)) { out.push(`${what} ${f} is outside the package`); return; }
    let buf;
    try { buf = await fs.readFile(f); } catch { out.push(`${what} ${f} is missing`); return; }
    const size = jpegSize(buf);
    if (!size) out.push(`${what} ${f} is not a JPEG`);
    else if (size.width !== w || size.height !== h) out.push(`${what} ${f} is ${size.width}x${size.height}, expected ${w}x${h}`);
  };
  for (const f of files) await check(f, 1080, 1350, 'slide');
  for (const f of report.stories || []) await check(f, 1080, 1920, 'story');
  let caption = '';
  try { caption = await fs.readFile(path.join(dir, 'caption.txt'), 'utf8'); } catch { out.push('caption.txt is missing'); }
  if (!caption.trim()) out.push('caption is empty');
  if (caption.length > MAX_CAPTION) out.push(`caption is ${caption.length} chars (limit ${MAX_CAPTION})`);
  const tags = (caption.match(/#[\p{L}\p{N}_]+/gu) || []).length;
  if (tags > MAX_TAGS) out.push(`caption has ${tags} hashtags (limit ${MAX_TAGS})`);
  return out;
}

/** The ledger row that marks today's evening as taken, or null. */
export function eveningRow(entries, date) {
  return (entries || []).find((e) => e?.date === `${date} ${SLOT}`) || null;
}

/**
 * Carousels on Instagram today (IST) at or after 15:30 that no ledger row
 * claims — a post-close carousel that is already up. Fail closed.
 */
export function unclaimedLateCarousels({ media = [], entries = [], fbEntries = [], date }) {
  const claimed = new Set([
    ...(entries || []).map((e) => String(e?.mediaId || '')),
    ...(fbEntries || []).map((f) => String(f?.igMediaId || '')),
  ].filter(Boolean));
  return (media || []).filter((m) => {
    if (!isCarouselMedia(m) || claimed.has(String(m.id || ''))) return false;
    const when = new Date(m.timestamp);
    if (Number.isNaN(when.getTime())) return false;
    const p = istParts(when);
    return p.date === date && p.minutes >= NOT_BEFORE;
  });
}

/**
 * Why publish must not run, or []. `now` is the run's clock; `listed` is the
 * Instagram media list result ({ ok, items }).
 */
export function publishBlockers({
  now = new Date(), report = {}, pkgProblems = [], sha = '', expectedSha = '',
  entries = [], fbEntries = [], listed = { ok: false, items: [] }, ref = '', defaultBranch = '',
}) {
  const out = [...pkgProblems];
  const { date, minutes } = istParts(now);
  if (ref && defaultBranch && ref !== defaultBranch) out.push(`runs on ${ref}; must run on the default branch ${defaultBranch} (the ledger lives there)`);
  if (!expectedSha) out.push('no --sha given: pass the reviewed package sha');
  else if (sha !== expectedSha) out.push(`package sha ${sha} does not match the reviewed sha ${expectedSha}`);
  if (report.istDate && report.istDate !== date) out.push(`package is for ${report.istDate}, today (IST) is ${date}`);
  const closed = slotClosedToday(SLOT, date);
  if (closed) out.push(`${date} is not an NSE trading day (${closed})`);
  if (minutes < NOT_BEFORE || minutes >= NOT_AFTER) out.push(`IST ${hhmm(minutes)} is outside the post-close window ${hhmm(NOT_BEFORE)}–${hhmm(NOT_AFTER)} (it must finish before the 16:30 evening window opens)`);
  const row = eveningRow(entries, date);
  if (row) out.push(`evening already posted/claimed today: "${row.topic}"${row.mediaId ? ` (media ${row.mediaId})` : ''}${row.status ? ` [${row.status}]` : ''}`);
  if (!listed.ok) out.push('Instagram media list unavailable — cannot confirm evening is not already up (fail closed)');
  else {
    const late = unclaimedLateCarousels({ media: listed.items, entries, fbEntries, date });
    if (late.length) out.push(`a carousel is already on Instagram today after 15:30 IST (${late.map((m) => m.id).join(', ')})`);
  }
  return out;
}

/** Ledger with the claim row appended (does not mutate). */
export function withClaim(ledger, { date, topic, runId, sha, at = new Date() }) {
  const entries = Array.isArray(ledger?.entries) ? [...ledger.entries] : [];
  entries.push({ date: `${date} ${SLOT}`, topic, angle: 'stocks', oneoff: true, status: 'claimed', runId: String(runId), sha, claimedAt: at.toISOString() });
  return { ...ledger, entries };
}

/** Ledger with today's evening row marked posted with the media id. */
export function withRecord(ledger, { date, mediaId, at = new Date() }) {
  if (!/^\d{6,}$/.test(String(mediaId || ''))) throw new Error(`not a media id: "${mediaId}"`);
  const entries = [...(ledger?.entries || [])];
  const i = entries.findIndex((e) => e?.date === `${date} ${SLOT}`);
  if (i < 0) throw new Error(`no "${date} ${SLOT}" row to record against`);
  entries[i] = { ...entries[i], status: 'posted', mediaId: String(mediaId), postedAt: at.toISOString() };
  return { ...ledger, entries };
}

/** Ledger without an unposted one-off claim, or a reason it must stay. */
export function withRelease(ledger, { date, listed }) {
  const entries = [...(ledger?.entries || [])];
  const i = entries.findIndex((e) => e?.date === `${date} ${SLOT}`);
  if (i < 0) return { error: 'no evening row today — nothing to release' };
  const row = entries[i];
  if (!row.oneoff) return { error: 'the evening row was not written by the one-off — not touching it' };
  if (row.mediaId) return { error: `evening is posted (media ${row.mediaId}) — not releasing` };
  if (!listed?.ok) return { error: 'Instagram media list unavailable — cannot prove nothing went up' };
  const since = new Date(row.claimedAt || 0).getTime() - 60000;
  const up = (listed.items || []).filter((m) => isCarouselMedia(m) && new Date(m.timestamp).getTime() >= since);
  if (up.length) return { error: `a carousel went up after the claim (${up.map((m) => m.id).join(', ')}) — not releasing` };
  entries.splice(i, 1);
  return { ledger: { ...ledger, entries } };
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

// The branch's current ledgers (a run checked out minutes ago). Read-only.
function remoteJson(file) {
  const ref = process.env.LEDGER_REFRESH_REF;
  if (!ref) return null;
  try {
    execFileSync('git', ['fetch', '--quiet', '--depth=1', 'origin', ref], { stdio: 'ignore', timeout: 60000 });
    return JSON.parse(execFileSync('git', ['show', `FETCH_HEAD:${file}`], { encoding: 'utf8', timeout: 30000 }));
  } catch { return null; }
}

async function listMedia() {
  const id = process.env.IG_USER_ID; const token = process.env.IG_ACCESS_TOKEN;
  if (!id || !token) return { ok: false, items: [], reason: 'no-token' };
  const host = process.env.IG_SURFACE === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com';
  const url = new URL(`${host}/v23.0/${encodeURIComponent(id)}/media`);
  url.searchParams.set('fields', 'id,media_type,media_product_type,timestamp');
  url.searchParams.set('limit', '25');
  url.searchParams.set('access_token', token);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) { const body = await res.json(); return { ok: true, items: body.data || [] }; }
    } catch { /* retry once */ }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, items: [], reason: 'http' };
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const dir = at('--pkg');
  if (!dir) throw new Error('--pkg <dir> is required');
  const mode = at('--mode') || 'check';
  const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const now = clock();
  const { date } = istParts(now);

  const pkg = await packageSha(dir);
  if (args.includes('--sha-only')) { console.log(pkg.sha); return; }

  const ledger = await readJson(LEDGER, { entries: [] });
  if (at('--record')) {
    const next = withRecord(ledger, { date, mediaId: at('--record') });
    await fs.writeFile(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`recorded ${date} ${SLOT}: media ${at('--record')}`);
    return;
  }
  const listed = await listMedia();
  if (mode === 'release') {
    const r = withRelease(ledger, { date, listed });
    if (r.error) { console.error(`NOT releasing: ${r.error}`); process.exit(1); }
    await fs.writeFile(LEDGER, `${JSON.stringify(r.ledger, null, 2)}\n`);
    console.log(`released the one-off claim on ${date} ${SLOT}`);
    return;
  }

  const remote = remoteJson(LEDGER);
  const remoteFb = remoteJson(FB_LEDGER);
  const entries = [...(ledger.entries || []), ...((remote?.entries) || [])];
  const fbEntries = [...await readJson(FB_LEDGER, []), ...(Array.isArray(remoteFb) ? remoteFb : [])];
  const report = await readJson(path.join(dir, 'carousel-report.json'), {});
  const blockers = publishBlockers({
    now, report, pkgProblems: await packageProblems(dir), sha: pkg.sha, expectedSha: at('--sha') || '',
    entries, fbEntries, listed, ref: process.env.GITHUB_REF_NAME || '', defaultBranch: process.env.DEFAULT_BRANCH || '',
  });

  console.log(`PACKAGE: ${dir} — ${(report.files || []).length} slides, ${(report.stories || []).length} story, sha ${pkg.sha} over ${pkg.files} files`);
  console.log(`TOPIC: ${report.topic || '(none)'}`);
  console.log(`IST NOW: ${date} ${hhmm(istParts(now).minutes)} (window ${hhmm(NOT_BEFORE)}–${hhmm(NOT_AFTER)})`);
  const row = eveningRow(entries, date);
  console.log(`EVENING ${date}: ${row ? `already ${row.status || 'posted'}${row.mediaId ? ` (media ${row.mediaId})` : ''}` : 'not posted yet'}`);
  console.log(`INSTAGRAM LIST: ${listed.ok ? `${listed.items.length} recent media read` : `unavailable (${listed.reason})`}`);
  await out('ready', String(!blockers.length));
  await out('sha', pkg.sha);

  if (mode !== 'publish') {
    console.log(blockers.length ? `publish would REFUSE:\n  - ${blockers.join('\n  - ')}` : 'publish would go ahead');
    return;
  }
  if (blockers.length) {
    console.error(`REFUSING to publish:\n  - ${blockers.join('\n  - ')}`);
    process.exit(1);
  }
  if (args.includes('--claim')) {
    const next = withClaim(ledger, { date, topic: report.topic || 'one-off evening carousel', runId: process.env.GITHUB_RUN_ID || 'local', sha: pkg.sha, at: now });
    await fs.writeFile(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`claimed ${date} ${SLOT} in ${LEDGER}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
