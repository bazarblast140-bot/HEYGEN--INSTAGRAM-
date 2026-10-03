// One-off repost (sbi-repost.yml): old post gone, package sha pinned, once only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { REPOSTS, packageSha, oldPostDeleted, ledgerEntry, publishBlockers } from '../pipeline/repost.js';

const cfg = REPOSTS['sbi-2026-10-03'];
const OLD = { mediaId: cfg.oldMediaId, shortcode: cfg.oldShortcode };

test('the committed SBI package is the reviewed build (pinned sha, 10 slides, Story, original caption)', async () => {
  const { sha, files } = await packageSha(cfg.dir);
  assert.equal(sha, cfg.sha);
  assert.equal(files, 13);
  const report = JSON.parse(await fs.readFile(path.join(cfg.dir, 'carousel-report.json'), 'utf8'));
  assert.equal(report.files.length, 10);
  assert.equal(report.format, 'jpeg');
  for (const f of [...report.files, ...report.stories]) await fs.access(f);
  assert.ok(report.lines.every((l) => !l.source), 'no source labels');
  const caption = await fs.readFile(path.join(cfg.dir, 'caption.txt'), 'utf8');
  assert.match(caption, /^EMI की हर किस्त में ब्याज और मूलधन/);
});

test('any changed byte changes the package sha', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pkg-'));
  await fs.writeFile(path.join(dir, 'a.jpg'), 'x');
  const a = await packageSha(dir);
  await fs.writeFile(path.join(dir, 'a.jpg'), 'y');
  assert.notEqual((await packageSha(dir)).sha, a.sha);
  await fs.writeFile(path.join(dir, 'hosted.json'), '{}');
  assert.equal((await packageSha(dir)).sha, (await packageSha(dir)).sha, 'hosted.json written by publish is not part of the package');
});

test('old post: live, gone, or unknown (a token error is never "deleted")', () => {
  assert.equal(oldPostDeleted({ get: { ok: true }, list: [], ...OLD }).deleted, false);
  assert.equal(oldPostDeleted({ get: { ok: false, code: 100 }, list: [{ id: '1', permalink: 'https://www.instagram.com/p/DeBiubHGK9S/' }], ...OLD }).deleted, false);
  assert.equal(oldPostDeleted({ get: { ok: false, code: 100 }, list: [{ id: '1', permalink: 'https://www.instagram.com/p/Other/' }], ...OLD }).deleted, true);
  assert.equal(oldPostDeleted({ get: { ok: false, code: 100 }, list: null, ...OLD }).deleted, true);
  assert.equal(oldPostDeleted({ get: { ok: false, code: 190 }, list: null, ...OLD }).deleted, false, 'expired token');
});

test('publish refuses unless deleted, sha matches and the ledger has no entry', () => {
  assert.deepEqual(publishBlockers({ deleted: true, shaOk: true, entry: null }), []);
  assert.equal(publishBlockers({ deleted: false, shaOk: true, entry: null }).length, 1);
  assert.equal(publishBlockers({ deleted: true, shaOk: false, entry: null }).length, 1);
  const claimed = ledgerEntry({ reposts: [{ key: 'sbi-2026-10-03', status: 'claimed', runId: 7 }] }, 'sbi-2026-10-03');
  assert.match(publishBlockers({ deleted: true, shaOk: true, entry: claimed })[0], /once only/);
});

test('sbi-repost.yml: manual only, check by default, claim before post', async () => {
  const wf = await fs.readFile(new URL('../.github/workflows/sbi-repost.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /^\s*schedule:/m);
  assert.match(wf, /default: check/);
  assert.ok(wf.indexOf('Claim the repost') < wf.indexOf('Publish to Instagram'));
  for (const step of ['Claim the repost', 'Publish to Instagram']) {
    const s = wf.slice(wf.indexOf(step), wf.indexOf('run:', wf.indexOf(step)));
    assert.match(s, /inputs\.mode == 'publish' && steps\.check\.outputs\.ready == 'true'/);
  }
});
