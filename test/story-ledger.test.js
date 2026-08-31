// The same two stories -- a Steam data leak and a California Linux exemption --
// went out in two posts on one day. The topic ledger could not prevent it: it
// remembers "आज की टेक ख़बरें", which says nothing about what was inside. The
// 36-hour fetch window overlaps every run, so the top story of one post is
// still the top story of the next.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readUsedStories, recordStories, recordTopic, readHistory, STORY_DAYS } from '../pipeline/src/script/topics.js';
import { storyKey, parseRss } from '../pipeline/src/carousel/news.js';

const ledger = async (body) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'history.json');
  if (body !== undefined) await fs.writeFile(file, JSON.stringify(body));
  return file;
};

const STEAM = { title: 'Steam data leak reveals decades of lost PC games' };
const LINUX = { title: 'California age verification law exempts Linux' };

test('the same headline gives the same key', () => {
  assert.equal(storyKey(STEAM), storyKey({ title: 'Steam data leak reveals decades of lost PC games' }));
  assert.notEqual(storyKey(STEAM), storyKey(LINUX));
});

test('a story posted today is remembered', async () => {
  const file = await ledger();
  await recordStories({ keys: [storyKey(STEAM), storyKey(LINUX)], date: '2026-08-31', file });
  const used = await readUsedStories(file, { now: new Date('2026-08-31') });
  assert.ok(used.has(storyKey(STEAM)));
  assert.ok(used.has(storyKey(LINUX)));
});

test('it is forgotten again after the window', async () => {
  const file = await ledger();
  await recordStories({ keys: [storyKey(STEAM)], date: '2026-08-01', file });
  const later = new Date('2026-08-31');
  assert.equal((await readUsedStories(file, { now: later })).size, 0);
  const soon = new Date(`2026-08-0${STORY_DAYS}`);
  assert.equal((await readUsedStories(file, { now: soon })).size, 1);
});

// The bug that would have silently switched the whole fix off.
test('recording a topic does not wipe the stories', async () => {
  const file = await ledger();
  await recordStories({ keys: [storyKey(STEAM)], date: '2026-08-31', file });
  await recordTopic({ topic: 'आज की टेक ख़बरें', angle: 'technology', date: '2026-08-31 midday', file });

  const used = await readUsedStories(file, { now: new Date('2026-08-31') });
  assert.equal(used.size, 1, 'recordTopic deleted the story ledger');
  assert.equal((await readHistory(file)).length, 1);
});

test('and recording stories does not wipe the topics', async () => {
  const file = await ledger();
  await recordTopic({ topic: 'आज की टेक ख़बरें', angle: 'technology', date: '2026-08-31 midday', file });
  await recordStories({ keys: [storyKey(STEAM)], date: '2026-08-31', file });
  assert.equal((await readHistory(file)).length, 1, 'recordStories deleted the topic ledger');
});

test('no ledger yet is not an error', async () => {
  assert.equal((await readUsedStories(path.join(os.tmpdir(), 'nope-' + Date.now(), 'x.json'))).size, 0);
});

// End to end on the shape a real feed delivers.
test('a skipped story never reaches the list', async () => {
  const xml = `<rss><channel>
    <item><title>Steam data leak reveals decades of lost PC games</title><link>https://a/1</link><pubDate>${new Date().toUTCString()}</pubDate></item>
    <item><title>Anthropic ships a new model for agents</title><link>https://a/2</link><pubDate>${new Date().toUTCString()}</pubDate></item>
  </channel></rss>`;
  const items = parseRss(xml, { site: 'Ars Technica' });
  assert.equal(items.length, 2);

  const skip = new Set([storyKey(STEAM)]);
  const kept = items.filter((i) => !skip.has(storyKey(i)));
  assert.equal(kept.length, 1);
  assert.match(kept[0].title, /Anthropic/);
});
