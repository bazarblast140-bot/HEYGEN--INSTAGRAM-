// Catch-up crons, soft skips, and the Reel publish guard.
//
// The 2 Oct 2026 Reel (run 36965276637) wrote its topic and then failed
// hosting, so nothing was posted. A guard that treats "today's topic is
// recorded" as published would skip the retry. The guard keys on a media id
// recorded after publish, or on a Reel in the Instagram media list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, readFile as readText } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { CRON_SLOTS, resolveRun, slotFor } from '../pipeline/src/carousel/categories.js';
import { MAX_MODEL_ATTEMPTS } from '../pipeline/src/script/attempts.js';
import {
  resolveReelPublish, carouselOnInstagram, listRecentMedia, istDate,
} from '../pipeline/src/publish/same-day.js';
import { mediaIdFromLog, recordPublishedReel } from '../pipeline/record-reel-publish.js';
import { classifyFailure, rerunDecision } from '../pipeline/classify-failure.js';
import { localSpeech, synthesise } from '../pipeline/src/presenter/voice-providers.js';
import {
  missedSlots, alertPlan, applyAlertPlan, alertTitle, ALERT_LABEL,
} from '../pipeline/src/health/missed-publish.js';

const on = { ENABLE_AI_NEWS_CAROUSELS: 'true' };

function cronsIn(text) {
  return [...text.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

function utcMinutes(cron) {
  const [minute, hour] = cron.split(' ').map(Number);
  return hour * 60 + minute;
}

// 22:30 UTC through 01:30 UTC, inclusive of the Reel's own publish minute.
function inBusyBand(cron) {
  const t = utcMinutes(cron);
  return t >= 22 * 60 + 30 || t <= 1 * 60 + 30;
}

test('each carousel slot has at least three crons, and new ones avoid :00 and :30', async () => {
  const text = await readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');
  const crons = cronsIn(text);
  const bySlot = {};
  for (const cron of crons) {
    const slot = CRON_SLOTS[cron];
    assert.ok(slot, `unmapped carousel cron ${cron}`);
    (bySlot[slot] ||= []).push(cron);
    assert.equal(inBusyBand(cron), false, cron);
  }
  for (const slot of ['midday', 'evening', 'ai', 'news']) {
    assert.ok(bySlot[slot].length >= 3, slot);
  }
  const primaries = new Set(['0 7 * * *', '0 14 * * *', '0 4 * * *', '0 11 * * *']);
  for (const cron of crons) {
    if (primaries.has(cron)) continue;
    const minute = Number(cron.split(' ')[0]);
    assert.equal(minute === 0 || minute === 30, false, cron);
  }
  assert.equal(CRON_SLOTS['0 7 * * *'], 'midday');
  assert.equal(CRON_SLOTS['0 14 * * *'], 'evening');
  assert.equal(CRON_SLOTS['0 4 * * *'], 'ai');
  assert.equal(CRON_SLOTS['0 11 * * *'], 'news');
});

test('the Reel is an evening fallback at 21:47 IST with catch-ups before 23:00 IST', async () => {
  const text = await readFile(new URL('../.github/workflows/build-reel.yml', import.meta.url), 'utf8');
  const crons = cronsIn(text);
  assert.ok(crons.includes('17 16 * * *'));
  assert.ok(crons.length >= 2 && crons.length <= 3, crons.join(', '));
  for (const morning of ['30 1 * * *', '37 1 * * *', '53 1 * * *', '11 2 * * *']) {
    assert.equal(crons.includes(morning), false, morning);
  }
  for (const cron of crons) {
    const [m, h] = cron.split(' ').map(Number);
    const ist = (h * 60 + m + 330) % 1440;
    assert.ok(ist >= 21 * 60 + 30 && ist < 23 * 60, `${cron} is ${Math.floor(ist / 60)}:${ist % 60} IST`);
    const minute = Number(cron.split(' ')[0]);
    assert.equal(minute === 0 || minute === 30, false, cron);
    assert.equal(inBusyBand(cron), false, cron);
  }
  const day = text.indexOf('pipeline/reel-status.js');
  const build = text.indexOf('name: Build the reel');
  const host = text.indexOf('Host the video where Instagram can fetch it');
  const publish = text.indexOf('name: Publish to Instagram');
  assert.ok(day > 0 && day < build && host < publish);
  assert.match(text, /record-reel-publish\.js/);
  assert.equal(text.includes("Remember today's topic"), false);
  assert.match(text.slice(publish), /preview != 'true'/);
  const doctor = text.indexOf('DEEPSEEK_API_KEY');
  assert.ok(day < doctor);
});

test('a late clock still fills the slot, and 06:07 IST still does not', () => {
  assert.equal(slotFor(new Date('2026-10-01T00:37:00Z'), on), null);
  assert.equal(slotFor(new Date('2026-10-02T04:41:00Z'), on), 'ai');
  assert.equal(slotFor(new Date('2026-10-01T06:00:00Z'), on), 'ai');
  const evening = resolveRun({
    event: 'workflow_dispatch',
    dispatchSlot: 'evening',
    now: new Date('2026-10-01T11:37:00Z'),
  });
  assert.equal(evening.reason, 'wrong-time');
  assert.equal(evening.pending, false);
});

test("today's recorded topic does not count as a published Reel", async () => {
  const topics = JSON.parse(await readFile(new URL('../pipeline/topic-history.json', import.meta.url), 'utf8'));
  assert.ok(topics.entries.some((entry) => String(entry.date).startsWith('2026-10-02')));
  const decision = resolveReelPublish({
    now: new Date('2026-10-02T01:52:00Z'),
    publishEntries: [],
    media: [],
  });
  assert.equal(decision.pending, true);
  assert.equal(decision.reason, 'due');
  assert.equal(istDate(new Date('2026-10-02T01:30:00Z')), '2026-10-02');
});

test('a media id or an Instagram Reel skips, and force does not', () => {
  const now = new Date('2026-10-02T02:10:00Z');
  const posted = resolveReelPublish({
    now,
    publishEntries: [{ date: '2026-10-02', mediaId: '1784140000123', topic: 'after publish' }],
  });
  assert.equal(posted.pending, false);
  assert.equal(posted.via, 'ledger');

  const forced = resolveReelPublish({
    now,
    publishEntries: posted.posted ? [{ date: '2026-10-02', mediaId: '1784140000123' }] : [],
    force: true,
  });
  assert.equal(forced.pending, true);
  assert.equal(forced.reason, 'forced');

  const ig = resolveReelPublish({
    now,
    media: [{
      id: '1784140000777',
      media_product_type: 'REELS',
      media_type: 'VIDEO',
      timestamp: '2026-10-02T02:05:00+0000',
    }],
  });
  assert.equal(ig.pending, false);
  assert.equal(ig.via, 'instagram');

  const album = resolveReelPublish({
    now: new Date('2026-10-02T04:40:00Z'),
    media: [{
      id: '1784140000888',
      media_type: 'CAROUSEL_ALBUM',
      timestamp: '2026-10-02T04:10:00+0000',
    }],
  });
  assert.equal(album.pending, true);

  const yesterday = resolveReelPublish({
    now,
    media: [{
      id: '1784140000666',
      media_product_type: 'REELS',
      timestamp: '2026-10-01T02:05:00Z',
    }],
  });
  assert.equal(yesterday.pending, true);
});

test("today's AI carousel ledger still blocks a second ai build", async () => {
  const carousel = JSON.parse(await readFile(new URL('../pipeline/carousel-history.json', import.meta.url), 'utf8'));
  const decision = resolveRun({
    event: 'schedule',
    cron: '7 4 * * *',
    now: new Date('2026-10-02T04:07:00Z'),
    entries: carousel.entries,
    env: on,
  });
  assert.equal(decision.slot, 'ai');
  assert.equal(decision.pending, false);
  assert.equal(decision.reason, 'duplicate');
  assert.equal(decision.key, '2026-10-02 ai');

  const ig = carouselOnInstagram({
    slot: 'ai',
    now: new Date('2026-10-02T04:40:00Z'),
    media: [{ media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-02T04:10:00+0000' }],
  });
  assert.ok(ig);
  assert.equal(carouselOnInstagram({
    slot: 'ai',
    now: new Date('2026-10-01T00:37:00Z'),
    media: [{ media_type: 'CAROUSEL_ALBUM', timestamp: '2026-10-01T00:37:00Z' }],
  }), null);
});

test('a Reel is recorded only when the publish log has a media id', async () => {
  assert.equal(mediaIdFromLog('published: 1784140000555\n'), '1784140000555');
  assert.equal(mediaIdFromLog('hosting failed'), '');
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-pub-'));
  const publishFile = path.join(dir, 'reel-publish-history.json');
  const topicFile = path.join(dir, 'topic-history.json');
  await writeFile(topicFile, '{"entries":[]}\n');
  await assert.rejects(
    () => recordPublishedReel({ mediaId: '', topic: 'nope', publishFile, topicFile }),
    /published media id/,
  );
  await recordPublishedReel({
    mediaId: '1784140000555',
    topic: 'After the post',
    angle: 'flat',
    now: new Date('2026-10-02T02:20:00Z'),
    publishFile,
    topicFile,
  });
  const saved = JSON.parse(await readText(publishFile, 'utf8'));
  assert.equal(saved.entries[0].mediaId, '1784140000555');
  assert.equal(saved.entries[0].date, '2026-10-02');
  const topics = JSON.parse(await readText(topicFile, 'utf8'));
  assert.equal(topics.entries[0].topic, 'After the post');
  assert.equal(topics.entries[0].date, '2026-10-02');
});

test('an Instagram media failure does not throw and does not echo the token', async () => {
  let seen = '';
  const listed = await listRecentMedia({
    igUserId: '178414',
    token: 'super-secret-token',
    fetcher: async (url) => {
      seen = String(url);
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });
  assert.equal(listed.ok, false);
  assert.deepEqual(listed.items, []);
  assert.equal(JSON.stringify(listed).includes('super-secret-token'), false);
  assert.match(seen, /access_token=super-secret-token/);
  const missing = await listRecentMedia({});
  assert.equal(missing.reason, 'no-token');
});

test('a carousel with no slot is a soft skip, and auto-fix does not rerun it', () => {
  const result = spawnSync(process.execPath, [
    'pipeline/build-carousel.js', '--generate', '--require-generated',
  ], {
    env: { ...process.env, SLOT_NOW: '2026-10-01T00:37:00Z' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.match(output, /soft skip/);
  assert.match(output, /No finance slot for this run/);
  assert.equal(/attempt \d/.test(output), false);

  const log = 'soft skip — No finance slot for this run, so nothing was built and nothing will be published.';
  assert.equal(classifyFailure(log), 'soft_skip');
  assert.deepEqual(rerunDecision({ kind: 'soft_skip', log, attempt: 1 }), { rerun: false, reason: 'soft-skip' });
  assert.equal(rerunDecision({ kind: 'unknown', attempt: 1 }).rerun, false);
  assert.equal(classifyFailure(`${log}\nHTTP 400 request problem`), 'code_or_request');
});

test('an already published Reel exits before the script model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'reel-skip-'));
  const publishFile = path.join(dir, 'reel-publish-history.json');
  await writeFile(publishFile, `${JSON.stringify({
    entries: [{ date: '2026-10-02', mediaId: '1784140000123' }],
  })}\n`);
  const result = spawnSync(process.execPath, [
    'pipeline/build-reel.js', '--generate', '--require-generated',
  ], {
    env: {
      ...process.env,
      SLOT_NOW: '2026-10-02T02:00:00Z',
      REEL_PUBLISH_FILE: publishFile,
      IG_USER_ID: '',
      IG_ACCESS_TOKEN: '',
    },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /soft skip/);
  assert.match(result.stdout, /via ledger/);
  assert.equal(result.stdout.includes("Writing today's script"), false);
});

test('previews and tests use local speech and do not call fetch', async () => {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    throw new Error('network');
  };
  try {
    const speech = await synthesise({ local: true, text: 'nifty flat today' });
    assert.equal(speech.provider, 'local');
    assert.equal(speech.format, 'wav');
    assert.equal(speech.audio.subarray(0, 4).toString(), 'RIFF');
    assert.equal(calls.length, 0);
    assert.equal(localSpeech({ text: 'one two' }).words.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test('model retries are capped at 3', async () => {
  assert.equal(MAX_MODEL_ATTEMPTS, 3);
  assert.ok(MAX_MODEL_ATTEMPTS <= 3);
  for (const file of [
    'pipeline/src/script/generate.js',
    'pipeline/src/carousel/generate.js',
    'pipeline/src/carousel/sourced.js',
  ]) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /MAX_MODEL_ATTEMPTS/, file);
    assert.equal(/<=\s*5/.test(text), false, file);
  }
});

test('a missed slot opens, updates, and closes one health-alert issue', async () => {
  const late = new Date('2026-10-02T17:37:00Z'); // 23:07 IST, after the fallback window
  const done = [{ date: '2026-10-02 midday' }, { date: '2026-10-02 evening' }];
  assert.deepEqual(missedSlots({
    now: late,
    env: {},
    reelPublishEntries: [],
    carouselEntries: done,
  }), ['reel']);
  assert.deepEqual(missedSlots({
    now: late,
    env: {},
    reelPublishEntries: [{ date: '2026-10-02', mediaId: '1784140000123' }],
    carouselEntries: done,
  }), []);
  // The morning check no longer reports the Reel: it is not due until 23:05 IST.
  assert.deepEqual(missedSlots({
    now: new Date('2026-10-02T02:07:00Z'),
    env: {},
    reelPublishEntries: [],
    carouselEntries: [],
  }), []);

  const midmorning = new Date('2026-10-02T04:37:00Z');
  assert.deepEqual(missedSlots({
    now: midmorning,
    env: on,
    reelPublishEntries: [{ date: '2026-10-02', mediaId: '1784140000123' }],
    carouselEntries: [{ date: '2026-10-02 ai', topic: 'AI नियम' }],
  }), []);
  assert.deepEqual(missedSlots({
    now: midmorning,
    env: {},
    reelPublishEntries: [{ date: '2026-10-02', mediaId: '1784140000123' }],
    carouselEntries: [],
  }), []);

  const title = alertTitle('2026-10-02');
  const opened = alertPlan({ date: '2026-10-02', missed: ['reel'], openIssues: [] });
  assert.equal(opened.action, 'open');
  assert.equal(opened.title, title);
  assert.deepEqual(opened.labels, [ALERT_LABEL]);

  const updated = alertPlan({
    date: '2026-10-02',
    missed: ['reel', 'midday'],
    openIssues: [{ number: 7, title, state: 'open' }],
  });
  assert.equal(updated.action, 'update');
  assert.equal(updated.number, 7);
  assert.match(updated.body, /Midday carousel/);

  const closed = alertPlan({
    date: '2026-10-02',
    missed: [],
    openIssues: [
      { number: 7, title, state: 'open' },
      { number: 3, title: alertTitle('2026-10-01'), state: 'open' },
    ],
  });
  assert.equal(closed.action, 'close');
  assert.deepEqual(closed.numbers, [7]);

  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body, auth: init.headers.Authorization });
    if (init.method === 'POST' && String(url).endsWith('/issues')) {
      return { ok: true, status: 201, text: async () => '{"number":42}' };
    }
    if (init.method === 'PATCH') return { ok: true, status: 200, text: async () => '{"number":7}' };
    return { ok: true, status: 201, text: async () => '{}' };
  };
  const created = await applyAlertPlan({
    plan: opened, repo: 'o/r', token: 'secret-token', fetcher,
  });
  assert.equal(created.number, 42);
  const issue = calls.find((call) => call.method === 'POST' && call.url.endsWith('/issues'));
  assert.deepEqual(JSON.parse(issue.body).labels, ['health-alert']);
  assert.equal(issue.auth, 'Bearer secret-token');
  assert.equal(JSON.stringify(created).includes('secret-token'), false);

  calls.length = 0;
  await applyAlertPlan({
    plan: closed, repo: 'o/r', token: 'secret-token', fetcher,
  });
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.match(patch.url, /\/issues\/7$/);
  assert.equal(JSON.parse(patch.body).state, 'closed');
});

test('the health check workflow writes issues and does not dispatch a build', async () => {
  const text = await readFile(new URL('../.github/workflows/slot-health.yml', import.meta.url), 'utf8');
  assert.match(text, /issues:\s*write/);
  assert.match(text, /node pipeline\/slot-health\.js/);
  const crons = cronsIn(text);
  assert.ok(crons.length >= 5);
  for (const cron of crons) {
    const minute = Number(cron.split(' ')[0]);
    assert.equal(minute === 0 || minute === 30, false, cron);
  }
  assert.equal(text.includes('repository_dispatch'), false);
  assert.equal(text.includes('gh workflow run'), false);
  assert.equal(text.includes('workflow_dispatch:'), true);
  const carousel = await readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');
  const doctor = carousel.slice(carousel.indexOf('Check the script-writing keys'), carousel.indexOf('Check the Instagram token'));
  assert.match(doctor, /steps\.slot\.outputs\.pending == 'true'/);
});
