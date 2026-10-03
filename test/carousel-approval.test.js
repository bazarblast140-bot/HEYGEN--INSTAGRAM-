// Every carousel gets a human slide review before it posts (when
// CAROUSEL_REQUIRE_APPROVAL=true), what posts is byte-for-byte what was
// reviewed, and a stale slot never backfills. The preview workflow cannot post.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { approvalProblems, hashFiles } from '../pipeline/approve-build.js';

const read = (p) => fs.readFile(new URL(`../${p}`, import.meta.url), 'utf8');

async function build(over = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'approve-'));
  const files = [path.join(dir, '01.jpg'), path.join(dir, '02.jpg')];
  await fs.writeFile(files[0], 'a');
  await fs.writeFile(files[1], 'b');
  return {
    files, stories: [], format: 'jpeg', publishable: true, quality: { ok: true, problems: [] },
    slot: 'evening', istDate: '2026-10-03', topic: 'EMI', category: 'personal-finance',
    contentHash: await hashFiles(files), ...over,
  };
}
const evening = new Date('2026-10-03T14:05:00Z'); // 19:35 IST

test('a reviewed, publishable build inside its window is approved', async () => {
  assert.deepEqual(await approvalProblems(await build(), { now: evening }), []);
});

test('stale, closed-window, already-posted, failed-gate and altered builds are refused', async () => {
  const stale = await approvalProblems(await build({ istDate: '2026-10-02' }), { now: evening });
  assert.match(stale.join(' '), /stale builds are not posted/);
  const news = await approvalProblems(await build({ slot: 'news' }), { now: evening });
  assert.match(news.join(' '), /news window is closed — a missed slot is not backfilled/);
  const posted = await approvalProblems(await build(), { now: evening, entries: [{ date: '2026-10-03 evening' }] });
  assert.match(posted.join(' '), /already posted/);
  const refused = await approvalProblems(await build({ publishable: false, quality: { ok: false, problems: ['slide 4: "₹52 लाख"'] } }), { now: evening });
  assert.match(refused.join(' '), /quality gate refused/);
  const b = await build();
  await fs.writeFile(b.files[1], 'changed');
  assert.match((await approvalProblems(b, { now: evening })).join(' '), /do not match the reviewed build/);
  assert.match((await approvalProblems(await build({ format: 'png' }), { now: evening })).join(' '), /png/);
});

test('carousel.yml: with CAROUSEL_REQUIRE_APPROVAL only an approved build reaches the publish step', async () => {
  const wf = await read('.github/workflows/carousel.yml');
  assert.match(wf, /CAROUSEL_REQUIRE_APPROVAL: \$\{\{ vars\.CAROUSEL_REQUIRE_APPROVAL \}\}/);
  assert.match(wf, /approve_build:/);
  const publish = wf.slice(wf.indexOf('- name: Publish to Instagram'));
  const cond = publish.split('\n').find((l) => l.trim().startsWith('if:'));
  assert.match(cond, /env\.APPROVE_BUILD != '' && steps\.approve\.outputs\.ok == 'true' && steps\.approveslot\.outputs\.pending == 'true'/);
  assert.match(cond, /env\.APPROVE_BUILD == '' && env\.CAROUSEL_REQUIRE_APPROVAL != 'true'/);
  assert.match(wf, /run-id: \$\{\{ github\.event\.inputs\.approve_build \}\}/);
  assert.doesNotMatch(wf, /PEXELS_API_KEY/, 'no stock photos are fetched for carousels');
});

test('carousel-preview.yml can never publish', async () => {
  const wf = await read('.github/workflows/carousel-preview.yml');
  assert.doesNotMatch(wf, /IG_ACCESS_TOKEN|FB_PAGE_TOKEN|publish-carousel|--yes|fb-crosspost/);
  assert.match(wf, /permissions:\n {2}contents: read/);
  assert.match(wf, /--preview --require-generated/);
  assert.match(wf, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(wf, /schedule:|repository_dispatch/);
  assert.match(wf, /name: carousel\n/, 'same artifact name approve_build downloads');
});
