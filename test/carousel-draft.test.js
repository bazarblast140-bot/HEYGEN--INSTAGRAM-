// Shapes DeepSeek actually returned for the AI carousel preview.
// Missing query/caption/hashtags, null headlines, and wrapper keys used to
// fail Zod and kill the slot. The draft is repaired before that check.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeCarouselDraft, sourcedCarouselSchema } from '../pipeline/src/carousel/generate.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/carousel/news-prompt.js';

test('a wrapped draft maps title, body, and items onto the carousel schema', () => {
  const parsed = sourcedCarouselSchema('ai-news').safeParse({
    carousel: {
      title: 'Nvidia data centers',
      items: [
        { title: 'Nvidia', body: 'data center spend', query: null },
        { text: 'ek aur baat', description: 'chip supply' },
      ],
    },
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.topic, 'Nvidia data centers');
  assert.equal(parsed.data.category, 'ai-news');
  assert.equal(parsed.data.slides[0].headline, 'Nvidia');
  assert.equal(parsed.data.slides[0].subline, 'data center spend');
  assert.equal(parsed.data.slides[0].query, 'Nvidia');
  assert.equal(parsed.data.slides[1].headline, 'ek aur baat');
  assert.equal(parsed.data.slides[1].subline, 'chip supply');
  assert.equal(parsed.data.slides[1].cta, true);
  assert.ok(parsed.data.caption.includes('Nvidia'));
  assert.ok(parsed.data.hashtags.length >= 1);
  assert.ok(parsed.data.hashtags.length <= 5);
});

test('null query, caption, hashtags, and headlines still parse', () => {
  const parsed = sourcedCarouselSchema('latest-news').safeParse({
    topic: null,
    category: null,
    caption: null,
    hashtags: null,
    slides: [
      { headline: null, query: null, title: null },
      { headline: undefined, subline: null, query: undefined },
    ],
  });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data.category, 'latest-news');
  assert.equal(parsed.data.slides[0].query, 'indian stock exchange');
  assert.equal(parsed.data.slides[0].headline, 'आज की ख़बर');
  assert.equal(typeof parsed.data.caption, 'string');
  assert.ok(parsed.data.caption.length > 0);
  assert.ok(Array.isArray(parsed.data.hashtags));
  assert.equal(parsed.data.slides[0].band, 'center');
  assert.equal(parsed.data.slides[1].band, 'bottom');
});

test('a data wrapper and a string hashtag list are accepted', () => {
  const draft = normalizeCarouselDraft({
    data: {
      topic: 'Yields',
      slides: [{ headline: 'Bond prices fell', query: 'bond market screen' }],
      hashtags: '#nifty50 #sensex',
    },
  }, { category: 'latest-news' });

  assert.equal(draft.slides[0].headline, 'Bond prices fell');
  assert.equal(draft.slides[0].query, 'bond market screen');
  assert.deepEqual(draft.hashtags, ['#nifty50', '#sensex']);
});

test('the news prompt calls a rise in yields a sell-off', () => {
  const text = `${SYSTEM}\n${buildUserPrompt({ stories: [{ title: 'Yields', site: 'Reuters', date: '2026-10-01' }], date: '2026-10-01' })}`;
  assert.match(text, /sell-off/);
  assert.match(text, /बॉन्ड रैली/);
  assert.match(text, /Yield बढ़ना/);
});
