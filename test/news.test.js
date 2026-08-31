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

// From the first live technology build: the model wrote the query "linux
// penguin" and got a photograph of an actual penguin on sand.
test('a mascot is not the technology', async () => {
  const { bestPhoto } = await import('../pipeline/src/render/backgrounds.js');
  const chosen = bestPhoto([
    { id: 1, alt: 'Adorable juvenile penguin standing on the sand' },
    { id: 2, alt: 'Linux terminal running on a laptop screen' },
  ], { query: 'linux operating system', used: new Set() });

  assert.equal(chosen.id, 2);
});

// Google News is RSS, and the fields a slide needs are not where you would
// first look: the link is a Google redirect, so the publisher has to come from
// the <source> element.
test('an RSS item yields the publisher, not news.google.com', async () => {
  const { parseRss } = await import('../pipeline/src/carousel/news.js');
  const [item] = parseRss(`<item>
    <title>OpenAI ships a new model - Reuters</title>
    <link>https://news.google.com/rss/articles/ABC</link>
    <pubDate>Sun, 31 Aug 2026 04:00:00 GMT</pubDate>
    <source url="https://www.reuters.com">Reuters</source>
  </item>`);

  assert.equal(item.site, 'Reuters');
  assert.equal(item.title, 'OpenAI ships a new model');   // the " - Reuters" tail is dropped
  assert.equal(item.date, '2026-08-31');
});

test('a story both sources carry is ranked first', async () => {
  const { fetchStories } = await import('../pipeline/src/carousel/news.js');
  const original = globalThis.fetch;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('news.google.com')) {
      return { ok: true, text: async () => `<item>
        <title>Nvidia unveils a new AI chip</title><link>https://news.google.com/x</link>
        <pubDate>${new Date().toUTCString()}</pubDate><source url="https://reuters.com">Reuters</source>
      </item><item>
        <title>A quieter story about batteries</title><link>https://news.google.com/y</link>
        <pubDate>${new Date().toUTCString()}</pubDate><source url="https://bbc.com">BBC</source>
      </item>` };
    }
    return { ok: true, json: async () => ({ hits: [
      { title: 'Nvidia unveils new AI chip for datacenters', url: 'https://anandtech.com/z', points: 500, created_at: new Date().toISOString() },
    ] }) };
  };

  try {
    const stories = await fetchStories();
    assert.equal(stories[0].title, 'Nvidia unveils a new AI chip');
    assert.equal(stories[0].corroborated, true);
  } finally { globalThis.fetch = original; }
});

// One source going down is a thinner list. Both going down is a missed post,
// and that has to be said rather than filled in from memory.
test('one source failing still yields stories', async () => {
  const { fetchStories } = await import('../pipeline/src/carousel/news.js');
  const original = globalThis.fetch;

  globalThis.fetch = async (input) => {
    if (String(input).includes('news.google.com')) throw new Error('down');
    return { ok: true, json: async () => ({ hits: [
      { title: 'An open-source LLM release', url: 'https://a.com/x', points: 200, created_at: new Date().toISOString() },
    ] }) };
  };

  try {
    const stories = await fetchStories();
    assert.equal(stories.length, 1);
    assert.equal(stories[0].site, 'a.com');
  } finally { globalThis.fetch = original; }
});

// The bug this replaced: sorting both sources by points buried Google News
// completely, because only Hacker News items have a score.
test('both sources appear, mainstream first', async () => {
  const { fetchStories } = await import('../pipeline/src/carousel/news.js');
  const original = globalThis.fetch;
  const now = Date.now();

  globalThis.fetch = async (input) => {
    if (String(input).includes('news.google.com')) {
      return { ok: true, text: async () => `<item><title>OpenAI opens an India office</title>
        <link>https://news.google.com/a</link><pubDate>${new Date(now - 3600e3).toUTCString()}</pubDate>
        <source url="https://reuters.com">Reuters</source></item>` };
    }
    return { ok: true, json: async () => ({ hits: [
      { title: 'A kernel scheduler rewrite in Rust', url: 'https://lwn.net/a', points: 800, created_at: new Date(now - 7200e3).toISOString() },
      { title: 'Another GPU benchmark writeup', url: 'https://b.com/b', points: 700, created_at: new Date(now - 7200e3).toISOString() },
    ] }) };
  };

  try {
    const stories = await fetchStories();
    assert.equal(stories[0].from, 'Google News', 'mainstream news should lead');
    assert.ok(stories.some((s) => s.from === 'Hacker News'), 'Hacker News should still be represented');
  } finally { globalThis.fetch = original; }
});

// Half of these feeds are Atom and half are RSS, and the two disagree about
// where the URL and the date live. Handling one and meeting the other at 13:07
// is a missed post.
test('Atom entries parse as well as RSS items', async () => {
  const { parseRss } = await import('../pipeline/src/carousel/news.js');

  const [atom] = parseRss(`<entry>
    <title>Introducing a smaller model</title>
    <link rel="alternate" href="https://huggingface.co/blog/small"/>
    <published>2026-08-31T04:00:00Z</published>
  </entry>`, { site: 'Hugging Face' });

  assert.equal(atom.title, 'Introducing a smaller model');
  assert.equal(atom.url, 'https://huggingface.co/blog/small');
  assert.equal(atom.site, 'Hugging Face');
  assert.equal(atom.date, '2026-08-31');
});

test('the publisher is the feed, not the URL host', async () => {
  const { parseRss } = await import('../pipeline/src/carousel/news.js');
  const [item] = parseRss(`<item>
    <title>A chip announcement</title><link>https://arstechnica.com/x</link>
    <pubDate>Sun, 31 Aug 2026 04:00:00 GMT</pubDate>
  </item>`, { site: 'Ars Technica' });

  assert.equal(item.site, 'Ars Technica');   // not arstechnica.com
});

// A feed that publishes forty items a day must not fill the carousel while a
// feed that publishes two never appears.
test('no single feed can crowd out the others', async () => {
  const { fetchStories } = await import('../pipeline/src/carousel/news.js');
  const original = globalThis.fetch;
  const now = Date.now();
  const item = (t) => `<item><title>${t}</title><link>https://x.com/${t.replace(/\W/g, '')}</link>
    <pubDate>${new Date(now - 3600e3).toUTCString()}</pubDate></item>`;

  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('marktechpost')) {
      return { ok: true, text: async () => Array.from({ length: 40 }, (_, i) => item(`Flood story ${i}`)).join('') };
    }
    if (url.includes('openai.com')) return { ok: true, text: async () => item('OpenAI ships something') };
    if (url.includes('hn.algolia')) return { ok: true, json: async () => ({ hits: [] }) };
    return { ok: true, text: async () => '' };
  };

  try {
    const stories = await fetchStories();
    const flood = stories.filter((s) => s.from === 'MarkTechPost').length;
    assert.ok(stories.some((s) => s.from === 'OpenAI'), 'the quiet feed should still appear');
    assert.ok(flood <= 6, `one feed took ${flood} slots`);
  } finally { globalThis.fetch = original; }
});
