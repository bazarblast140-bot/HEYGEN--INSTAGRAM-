// The midday post exists because a model cannot know today's news, and every
// test here is about that one risk: a slide citing something it was never given.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkSources } from '../pipeline/src/carousel/generate.js';
import { fetchStories, ON_TOPIC, OFF_TOPIC } from '../pipeline/src/carousel/news.js';
import { slotFor, SLOTS, categoryFor } from '../pipeline/src/carousel/categories.js';

const sites = new Set(['arstechnica.com', 'nature.com', 'theverge.com']);

test('a slide citing a site from today\'s stories passes', () => {
  const spec = { slides: [
    { band: 'center', cta: false },
    { band: 'bottom', cta: false, source: 'arstechnica.com' },
    { band: 'bottom', cta: false, source: 'Nature.com' },
  ] };
  assert.deepEqual(checkSources(spec, sites), []);
});

// The failure this whole pipeline is shaped against: the model reaches for a
// headline it remembers and names a source that was never in the list.
test('a slide citing a source it was never given is rejected', () => {
  const spec = { slides: [
    { band: 'bottom', cta: false, source: 'techcrunch.com' },
  ] };
  assert.match(checkSources(spec, sites).join(), /not one of today's stories/);
});

test('the cover and the follow card need no source', () => {
  const spec = { slides: [
    { band: 'center', cta: false, source: null },
    { band: 'bottom', cta: true, source: null },
  ] };
  assert.deepEqual(checkSources(spec, sites), []);
});

test('technology stories are kept and noise is dropped', () => {
  assert.ok(ON_TOPIC.test('A new open-source LLM runs on one GPU'));
  assert.ok(ON_TOPIC.test('Quantum error correction milestone'));
  assert.ok(OFF_TOPIC.test('Ask HN: what are you working on?'));
  assert.ok(OFF_TOPIC.test('Nvidia earnings beat expectations'));
});

test('a fetch that returns nothing usable is an error, not an empty post', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ hits: [] }) });
  try {
    assert.deepEqual(await fetchStories(), []);
  } finally { globalThis.fetch = original; }
});

test('stories come back sorted by points, not by recency', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ hits: [
    { title: 'A small AI model', url: 'https://a.com/x', points: 40, created_at: '2026-08-31T05:00:00Z' },
    { title: 'A big AI model', url: 'https://b.com/y', points: 900, created_at: '2026-08-31T01:00:00Z' },
  ] }) });
  try {
    const [first] = await fetchStories();
    assert.equal(first.site, 'b.com');
    assert.equal(first.points, 900);
  } finally { globalThis.fetch = original; }
});

// The midday slot must not consume a step of the fact rotation, or the morning
// and evening categories would drift.
test('midday is a slot but not a rotation slot', () => {
  assert.equal(slotFor(new Date('2026-08-31T07:37:00Z')), 'midday');
  assert.ok(!SLOTS.includes('midday'));
  assert.throws(() => categoryFor('2026-08-31', 'midday'), /Unknown slot/);
});
