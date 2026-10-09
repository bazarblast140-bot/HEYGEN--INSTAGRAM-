// One-off evening carousel (evening-oneoff.yml): reviewed package only, post-close
// window only, once only, and the scheduled evening run sees evening as posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  jpegSize, packageProblems, publishBlockers, withClaim, withRecord, withRelease,
  eveningRow, unclaimedLateCarousels,
} from '../pipeline/oneoff-evening.js';
import { packageSha } from '../pipeline/repost.js';
import { resolveRun } from '../pipeline/src/carousel/categories.js';
import { postedSlots, carouselOnInstagram } from '../pipeline/src/publish/same-day.js';

const at = (hhmm, date = '2026-10-09') => new Date(`${date}T${hhmm}:00+05:30`);
const DATE = '2026-10-09';

/** A minimal JPEG header (SOI + SOF0) with the given size. */
function fakeJpeg(w, h) {
  const b = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  return b;
}

async function makePkg({ slides = 6, size = [1080, 1350], story = [1080, 1920], caption = 'Nifty close\n#nifty50', report = {} } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oneoff-'));
  await fs.mkdir(path.join(dir, 'slides'));
  const files = [];
  for (let i = 1; i <= slides; i += 1) {
    const f = path.join(dir, 'slides', `0${i}.jpg`);
    await fs.writeFile(f, fakeJpeg(...size));
    files.push(f);
  }
  const stories = [];
  if (story) { const f = path.join(dir, 'story-1.jpg'); await fs.writeFile(f, fakeJpeg(...story)); stories.push(f); }
  await fs.writeFile(path.join(dir, 'caption.txt'), caption);
  await fs.writeFile(path.join(dir, 'carousel-report.json'), JSON.stringify({
    slot: 'evening', istDate: DATE, format: 'jpeg', width: 1080, height: 1350, files, stories,
    category: 'stocks', generated: true, fallback: false, quality: { ok: true, problems: [] }, topic: 'Nifty close', ...report,
  }));
  return dir;
}

const base = (over = {}) => ({
  now: at('15:45'), report: { istDate: DATE }, pkgProblems: [], sha: 'abc', expectedSha: 'abc',
  entries: [], fbEntries: [], listed: { ok: true, items: [] }, ref: 'main', defaultBranch: 'main', ...over,
});

test('jpegSize reads the frame size and rejects non-JPEGs', () => {
  assert.deepEqual(jpegSize(fakeJpeg(1080, 1350)), { width: 1080, height: 1350 });
  assert.equal(jpegSize(Buffer.from('\x89PNG....')), null);
});

test('a good package passes; wrong size, PNG, missing story, long caption and wrong slot do not', async () => {
  assert.deepEqual(await packageProblems(await makePkg()), []);
  assert.match((await packageProblems(await makePkg({ size: [1080, 1080] })))[0], /1080x1080, expected 1080x1350/);
  assert.match((await packageProblems(await makePkg({ story: [1080, 1350] })))[0], /story .* expected 1080x1920/);
  assert.match((await packageProblems(await makePkg({ caption: 'x'.repeat(2201) })))[0], /2201 chars/);
  assert.match((await packageProblems(await makePkg({ caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') })))[0], /31 hashtags/);
  assert.match((await packageProblems(await makePkg({ report: { slot: 'midday' } })))[0], /expected "evening"/);
  assert.match((await packageProblems(await makePkg({ slides: 1 })))[0], /2–10/);
  assert.match((await packageProblems(await makePkg({ report: { quality: { ok: false } } })))[0], /quality/);
  const dir = await makePkg();
  await fs.writeFile(path.join(dir, 'slides', '01.jpg'), 'not a jpeg');
  assert.match((await packageProblems(dir))[0], /not a JPEG/);
});

test('publish goes ahead only post-close, before the evening window, on a trading day, with the reviewed sha', () => {
  assert.deepEqual(publishBlockers(base()), []);
  assert.deepEqual(publishBlockers(base({ now: at('15:30') })), []);
  assert.match(publishBlockers(base({ now: at('15:29') })).join(), /outside the evening window/);
  assert.match(publishBlockers(base({ now: at('16:25') })).join(), /outside the evening window/);
  assert.match(publishBlockers(base({ now: at('16:45') })).join(), /outside/);
  assert.match(publishBlockers(base({ expectedSha: '' })).join(), /no --sha/);
  assert.match(publishBlockers(base({ sha: 'def' })).join(), /does not match the reviewed sha/);
  assert.match(publishBlockers(base({ report: { istDate: '2026-10-08' } })).join(), /package is for 2026-10-08/);
  assert.match(publishBlockers(base({ now: at('15:45', '2026-10-10'), report: { istDate: '2026-10-10' } })).join(), /not an NSE trading day/);
  assert.match(publishBlockers(base({ ref: 'feature' })).join(), /default branch/);
  assert.match(publishBlockers(base({ pkgProblems: ['bad slide'] })).join(), /bad slide/);
});

test('refuses when evening is already posted or claimed today, or a post-close carousel is already up', () => {
  const posted = [{ date: `${DATE} evening`, topic: 'Market close', mediaId: '18000000000000001' }];
  assert.match(publishBlockers(base({ entries: posted })).join(), /evening already posted\/claimed today: "Market close" \(media 18000000000000001\)/);
  const claimed = withClaim({ entries: [] }, { date: DATE, topic: 'T', runId: 1, sha: 'abc', at: at('15:40') }).entries;
  assert.match(publishBlockers(base({ entries: claimed })).join(), /\[claimed\]/);
  // yesterday's evening does not block today
  assert.deepEqual(publishBlockers(base({ entries: [{ date: '2026-10-08 evening', topic: 'x', mediaId: '1800000000' }] })), []);
  // a carousel already on IG after 15:30 IST that no ledger row claims
  const up = { id: '17900000000000009', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-09T10:05:00+0000' };
  assert.match(publishBlockers(base({ listed: { ok: true, items: [up] } })).join(), /already on Instagram today after 15:30/);
  // ... but the midday carousel (claimed by its ledger row) does not block
  const midday = { id: '17900000000000010', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-09T07:05:00+0000' };
  assert.deepEqual(publishBlockers(base({ listed: { ok: true, items: [midday] } })), []);
  assert.deepEqual(unclaimedLateCarousels({ media: [up], entries: [{ date: `${DATE} midday`, mediaId: up.id }], date: DATE }), []);
  // Instagram list unreadable → fail closed
  assert.match(publishBlockers(base({ listed: { ok: false, items: [] } })).join(), /fail closed/);
});

test('the claim makes every scheduled/dispatched evening run today a duplicate (no double post)', () => {
  const entries = withClaim({ entries: [] }, { date: DATE, topic: 'Nifty real chart', runId: 42, sha: 'abc', at: at('15:40') }).entries;
  assert.equal(eveningRow(entries, DATE).status, 'claimed');
  for (const cron of ['15 11 * * *', '22 11 * * *', '37 11 * * *', '56 11 * * *']) {
    const when = { '15 11 * * *': '16:45', '22 11 * * *': '16:52', '37 11 * * *': '17:07', '56 11 * * *': '17:26' }[cron];
    const d = resolveRun({ event: 'schedule', cron, now: at(when), entries, env: {} });
    assert.equal(d.reason, 'duplicate', cron);
    assert.equal(d.pending, false);
  }
  // the external 17:07 dispatch (slot evening or auto)
  for (const dispatchSlot of ['evening', 'auto', '']) {
    const d = resolveRun({ event: 'repository_dispatch', dispatchSlot, now: at('17:07'), entries, env: {} });
    assert.equal(d.reason, 'duplicate', `dispatch slot "${dispatchSlot}"`);
  }
  // a manual late dispatch is blocked too
  assert.equal(resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'evening', now: at('19:00'), entries, env: { DISPATCH_LATE: 'true' } }).reason, 'duplicate');
  // without the claim the 16:45 run would post
  assert.equal(resolveRun({ event: 'schedule', cron: '15 11 * * *', now: at('16:45'), entries: [], env: {} }).reason, 'due');
});

test('recording the media id claims the post for evening, so no other slot counts it', () => {
  const claimed = withClaim({ entries: [], stories: [{ date: '2026-09-01', key: 'k' }] }, { date: DATE, topic: 'T', runId: 1, sha: 's', at: at('15:40') });
  const rec = withRecord(claimed, { date: DATE, mediaId: '18011112222333444', at: at('15:44') });
  const row = eveningRow(rec.entries, DATE);
  assert.equal(row.mediaId, '18011112222333444');
  assert.equal(row.status, 'posted');
  assert.deepEqual(rec.stories, [{ date: '2026-09-01', key: 'k' }], 'the stories list is kept');
  const media = [{ id: '18011112222333444', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-09T10:14:00+0000' }];
  const slots = postedSlots({ media, entries: rec.entries, now: at('16:45'), slots: ['midday', 'evening'] });
  assert.deepEqual(slots.evening, { via: 'ledger', mediaId: '18011112222333444' });
  assert.equal(slots.midday, undefined, 'the 15:44 post is not counted as midday');
  assert.equal(carouselOnInstagram({ media, slot: 'midday', now: at('15:44'), entries: rec.entries }), null);
  assert.throws(() => withRecord(claimed, { date: DATE, mediaId: '' }), /not a media id/);
  assert.throws(() => withRecord({ entries: [] }, { date: DATE, mediaId: '18011112222333444' }), /no "2026-10-09 evening" row/);
});

test('release removes only an unposted one-off claim with nothing on Instagram since', () => {
  const claimed = withClaim({ entries: [{ date: `${DATE} ai`, topic: 'a' }] }, { date: DATE, topic: 'T', runId: 1, sha: 's', at: at('15:40') });
  const ok = withRelease(claimed, { date: DATE, listed: { ok: true, items: [] } });
  assert.equal(eveningRow(ok.ledger.entries, DATE), null);
  assert.equal(ok.ledger.entries.length, 1);
  const up = { id: '1', media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-09T10:11:00+0000' };
  assert.match(withRelease(claimed, { date: DATE, listed: { ok: true, items: [up] } }).error, /went up after the claim/);
  assert.match(withRelease(claimed, { date: DATE, listed: { ok: false, items: [] } }).error, /unavailable/);
  const rec = withRecord(claimed, { date: DATE, mediaId: '18011112222333444' });
  assert.match(withRelease(rec, { date: DATE, listed: { ok: true, items: [] } }).error, /is posted/);
  assert.match(withRelease({ entries: [{ date: `${DATE} evening`, topic: 'scheduled' }] }, { date: DATE, listed: { ok: true, items: [] } }).error, /not written by the one-off/);
});

test('evening-oneoff.yml: manual only, check by default, claim before post, record after', async () => {
  const wf = await fs.readFile(new URL('../.github/workflows/evening-oneoff.yml', import.meta.url), 'utf8');
  assert.doesNotMatch(wf, /^\s*(schedule|repository_dispatch|push|pull_request):/m);
  assert.match(wf, /default: check/);
  const claim = wf.indexOf("Claim today's evening");
  const pub = wf.indexOf('Publish to Instagram');
  assert.ok(claim > 0 && claim < pub);
  for (const i of [claim, pub]) {
    assert.match(wf.slice(i, wf.indexOf('run:', i)), /inputs\.mode == 'publish' && steps\.check\.outputs\.ready == 'true'/);
  }
  assert.match(wf, /oneoff-evening\.js --slot "\$SLOT" --pkg "\$PKG" --mode publish --sha "\$SHA_IN" --claim/);
  assert.match(wf, /publish-carousel\.js --report "\$PKG\/carousel-report\.json" --caption-file "\$PKG\/caption\.txt" --max-stories "\$MAXS" --yes/);
  assert.match(wf, /fb-crosspost\.js --kind carousel .*--slot "\$SLOT"/);
  assert.match(wf, /fb-story\.js --stories "\$PKG\/stories\.json"/);
  assert.match(wf, /oneoff-evening\.js --slot "\$SLOT" --pkg "\$PKG" --record "\$ID"/);
  assert.doesNotMatch(wf, /\$\{\{\s*inputs\.(sha|mode)\s*\}\}"/, 'inputs reach the shell through env, not interpolation');
});

test('every committed one-off package is valid and its sha is stable', async () => {
  const root = 'pipeline/specs/oneoff';
  let dirs = [];
  try { dirs = (await fs.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { /* none yet */ }
  for (const dir of dirs) {
    assert.deepEqual(await packageProblems(dir), [], dir);
    assert.equal((await packageSha(dir)).sha, (await packageSha(dir)).sha);
  }
});

// ---- midday real-source one-off (9 Oct 2026): 9–10 slides, one Story frame per slide
async function makeMidday({ slides = 9, stories = 9 } = {}) {
  const dir = await makePkg({ slides, story: null, report: { slot: 'midday' } });
  const rep = JSON.parse(await fs.readFile(path.join(dir, 'carousel-report.json'), 'utf8'));
  rep.stories = [];
  for (let i = 1; i <= stories; i += 1) { const f = path.join(dir, `story-${i}.jpg`); await fs.writeFile(f, fakeJpeg(1080, 1920)); rep.stories.push(f); }
  await fs.writeFile(path.join(dir, 'carousel-report.json'), JSON.stringify(rep));
  return dir;
}

test('midday package: 9–10 slides and up to 10 Story frames; evening rules unchanged', async () => {
  assert.deepEqual(await packageProblems(await makeMidday(), 'midday'), []);
  assert.deepEqual(await packageProblems(await makeMidday({ slides: 10, stories: 10 }), 'midday'), []);
  assert.match((await packageProblems(await makeMidday({ slides: 6, stories: 6 }), 'midday')).join(), /6 slides — midday takes 9–10/);
  assert.match((await packageProblems(await makeMidday({ stories: 9 }), 'evening')).join(), /report.slot is "midday"|9 Story frames — evening takes at most 1/);
  assert.match((await packageProblems(await makePkg(), 'midday')).join(), /report.slot is "evening"/);
});

test('midday publish: window 12:00–17:00 IST, once per day, any unclaimed carousel today blocks', () => {
  const m = (over) => publishBlockers(base({ slot: 'midday', report: { istDate: DATE }, ...over }));
  assert.deepEqual(m({ now: at('13:30') }), []);
  assert.match(m({ now: at('11:50') }).join(), /outside the midday window 12:00–17:00/);
  assert.match(m({ now: at('17:05') }).join(), /outside the midday window/);
  assert.match(m({ now: at('13:30'), entries: [{ date: `${DATE} midday`, topic: 'x', mediaId: '123456789' }] }).join(), /midday already posted/);
  // the 06:07 ai carousel is claimed by its ledger row → not a blocker; an unclaimed 08:00 carousel is
  const ai = { id: '17963787267206144', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED', timestamp: `${DATE}T00:37:40+0000` };
  assert.deepEqual(m({ now: at('13:30'), entries: [{ date: `${DATE} ai`, mediaId: ai.id }], listed: { ok: true, items: [ai] } }), []);
  assert.match(m({ now: at('13:30'), listed: { ok: true, items: [ai] } }).join(), /no ledger row claims .* after 00:00/);
  // evening keeps its own window
  assert.match(publishBlockers(base({ now: at('13:30') })).join(), /outside the evening window 15:30–16:25/);
});

test('midday claim / record / release use the "<date> midday" row', () => {
  const c = withClaim({ entries: [] }, { slot: 'midday', date: DATE, topic: 't', runId: 1, sha: 's', at: at('13:00') });
  assert.equal(c.entries[0].date, `${DATE} midday`);
  assert.equal(eveningRow(c.entries, DATE, 'midday').status, 'claimed');
  assert.equal(eveningRow(c.entries, DATE), null);
  const r = withRecord(c, { slot: 'midday', date: DATE, mediaId: '1234567', at: at('13:01') });
  assert.equal(r.entries[0].mediaId, '1234567');
  assert.match(withRelease(r, { slot: 'midday', date: DATE, listed: { ok: true, items: [] } }).error, /midday is posted/);
});
