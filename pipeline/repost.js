#!/usr/bin/env node
// One-off repost of a fixed carousel (sbi-repost.yml). Prints whether the old
// post is gone, whether the committed package is byte-for-byte the reviewed
// one, and whether this repost was already claimed or posted — and, with
// --claim, records the claim in the ledger BEFORE anything is posted, so a
// repost can never go out twice.
//
//   node pipeline/repost.js --key sbi-2026-10-03 --mode check
//   node pipeline/repost.js --key sbi-2026-10-03 --mode publish --claim
//   node pipeline/repost.js --key sbi-2026-10-03 --record <ig media id>
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSTS = {
  'sbi-2026-10-03': {
    dir: 'pipeline/specs/repost/sbi-2026-10-03',
    oldMediaId: '18089688200678070',
    oldShortcode: 'DeBiubHGK9S',
    // sha256 of the package manifest (sha256sum of every file, sorted) — the reviewed build.
    sha: '93565fc880f237814dcdf93b627b0cf82e12c9b4933b936c1a7a1f1467f6216a',
  },
};
export const LEDGER = 'pipeline/repost-ledger.json';

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p, base));
    else if (e.name !== 'MANIFEST.sha256' && e.name !== 'hosted.json') out.push(`./${path.relative(base, p).split(path.sep).join('/')}`);
  }
  return out;
}

/** sha256 of `sha256sum` output over the package (same as `sha256sum MANIFEST.sha256`). */
export async function packageSha(dir) {
  const files = (await walk(dir)).sort();
  let manifest = '';
  for (const f of files) manifest += `${crypto.createHash('sha256').update(await fs.readFile(path.join(dir, f))).digest('hex')}  ${f}\n`;
  return { sha: crypto.createHash('sha256').update(manifest).digest('hex'), files: files.length };
}

/**
 * Is the old post gone? get: { ok, code } of GET /<media id>; list: null when
 * the media list could not be read, else [{ id, permalink }].
 * A media GET that succeeds means it is live. Otherwise it is gone if the
 * account's recent media list was read and does not contain it, or Graph says
 * the object does not exist (code 100) — a token error is never "deleted".
 */
export function oldPostDeleted({ get, list, mediaId, shortcode }) {
  if (get?.ok) return { deleted: false, why: 'Graph GET of the old media still returns it' };
  const inList = list ? list.some((m) => String(m.id) === String(mediaId) || String(m.permalink || '').includes(`/${shortcode}`)) : null;
  if (inList === true) return { deleted: false, why: 'still in the account\'s recent media list' };
  if (inList === false) return { deleted: true, why: `Graph GET failed (${get?.message || 'error'}) and it is not in the ${list.length} most recent media` };
  if (Number(get?.code) === 100) return { deleted: true, why: `Graph says the object does not exist (${get.message || 'code 100'}); media list unavailable` };
  return { deleted: false, why: `could not tell — GET failed (${get?.message || 'error'}) and the media list could not be read` };
}

export function ledgerEntry(ledger, key) {
  return (ledger?.reposts || []).find((r) => r.key === key) || null;
}

/** Why publish must not run, or [] when it may. */
export function publishBlockers({ deleted, shaOk, entry }) {
  const out = [];
  if (!deleted) out.push('the old post is not deleted');
  if (!shaOk) out.push('the package sha does not match the reviewed build');
  if (entry) out.push(`already ${entry.status} (run ${entry.runId}${entry.mediaId ? `, media ${entry.mediaId}` : ''}) — a repost goes out once only`);
  return out;
}

async function readLedger() {
  try { return JSON.parse(await fs.readFile(LEDGER, 'utf8')); } catch { return { reposts: [] }; }
}

async function graph(pathname, params) {
  const { call } = await import('./src/publish/instagram.js');
  return call(pathname, { params, token: process.env.IG_ACCESS_TOKEN });
}

async function main() {
  const args = process.argv.slice(2);
  const at = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const key = at('--key'); const mode = at('--mode') || 'check';
  const cfg = REPOSTS[key];
  if (!cfg) throw new Error(`unknown repost "${key}"`);
  const out = async (k, v) => { if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); };
  const ledger = await readLedger();

  if (at('--record')) {
    const entry = ledgerEntry(ledger, key);
    if (!entry) throw new Error('no claim to record against');
    Object.assign(entry, { status: 'posted', mediaId: at('--record'), postedAt: new Date().toISOString() });
    await fs.writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`recorded ${key}: media ${entry.mediaId}`);
    return;
  }

  let get; let list = null;
  try { await graph(cfg.oldMediaId, { fields: 'id,permalink' }); get = { ok: true }; } catch (err) {
    get = { ok: false, code: err.details?.error?.code, message: String(err.details?.error?.message || err.message).slice(0, 120) };
  }
  try {
    const me = process.env.IG_USER_ID || 'me';
    const body = await graph(`${me}/media`, { fields: 'id,permalink,timestamp', limit: '50' });
    list = body.data || [];
  } catch (err) { console.log(`media list unavailable: ${String(err.message).slice(0, 120)}`); }
  const old = oldPostDeleted({ get, list, mediaId: cfg.oldMediaId, shortcode: cfg.oldShortcode });
  const pkg = await packageSha(cfg.dir);
  const shaOk = pkg.sha === cfg.sha;
  const entry = ledgerEntry(ledger, key);

  console.log(`OLD POST DELETED: ${old.deleted ? 'yes' : 'no'}  (${old.why})`);
  console.log(`PACKAGE SHA: ${pkg.sha} over ${pkg.files} files — ${shaOk ? 'matches the reviewed build' : `MISMATCH (expected ${cfg.sha})`}`);
  console.log(`LEDGER: ${entry ? `already ${entry.status} (run ${entry.runId})` : 'not posted yet'}`);
  const blockers = publishBlockers({ deleted: old.deleted, shaOk, entry });
  await out('deleted', old.deleted ? 'yes' : 'no');
  await out('sha_ok', String(shaOk));
  await out('ready', String(!blockers.length));

  if (mode !== 'publish') {
    console.log(blockers.length ? `publish would REFUSE: ${blockers.join('; ')}` : 'publish would go ahead');
    return;
  }
  if (blockers.length) {
    console.error(`REFUSING to publish: ${blockers.join('; ')}`);
    process.exit(1);
  }
  if (args.includes('--claim')) {
    ledger.reposts = [...(ledger.reposts || []), { key, status: 'claimed', runId: process.env.GITHUB_RUN_ID || 'local', sha: pkg.sha, claimedAt: new Date().toISOString(), replaces: cfg.oldMediaId }];
    await fs.writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
    console.log(`claimed ${key} in ${LEDGER}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
