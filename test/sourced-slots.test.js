import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { flagOn, ENABLE_AI_NEWS_CAROUSELS, ENABLE_REEL_STORY, ENABLE_CAROUSEL_STORY } from '../pipeline/src/publish/flags.js';
import { resolveRun, slotFor, categoryFor, CRON_SLOTS } from '../pipeline/src/carousel/categories.js';
import { framesToPost } from '../pipeline/src/carousel/story.js';
import { publishDecision } from '../pipeline/src/publish/allow.js';
import { videoStoryParams, attachReelStory } from '../pipeline/src/publish/story.js';
import {
  AI_FEEDS, NEWS_FEEDS, selectFresh, applySourceCitation, generateSourcedCarousel, MAX_SOURCE_AGE_MS,
} from '../pipeline/src/carousel/sourced.js';
import { SYSTEM, buildSourcedPrompt } from '../pipeline/src/carousel/sourced-prompt.js';
import { normalizeSpec } from '../pipeline/src/carousel/generate.js';

const on = { ENABLE_AI_NEWS_CAROUSELS: 'true' };
const freshItem = {
  title: 'Nifty slips as global yields rise',
  site: 'Reuters',
  date: '2026-10-01',
  at: Date.parse('2026-10-01T08:00:00Z'),
  url: 'https://www.reuters.com/markets/example',
};

test('the three new flags default to off', () => {
  assert.equal(flagOn(ENABLE_AI_NEWS_CAROUSELS, {}), false);
  assert.equal(flagOn(ENABLE_REEL_STORY, { ENABLE_REEL_STORY: '' }), false);
  assert.equal(flagOn(ENABLE_CAROUSEL_STORY, { ENABLE_CAROUSEL_STORY: 'false' }), false);
  assert.equal(flagOn(ENABLE_AI_NEWS_CAROUSELS, on), true);
});

test('ai and news slots no-op unless the flag is on, and finance slots do not move', () => {
  const morning = new Date('2026-10-01T04:00:00Z'); // 09:30 IST
  const afternoon = new Date('2026-10-01T11:00:00Z'); // 16:30 IST
  const midday = new Date('2026-10-01T07:00:00Z'); // 12:30 IST
  assert.equal(slotFor(morning, {}), null);
  assert.equal(slotFor(afternoon, {}), null);
  assert.equal(slotFor(morning, on), 'ai');
  assert.equal(slotFor(afternoon, on), 'news');
  assert.equal(slotFor(midday, on), 'midday');
  assert.equal(categoryFor('2026-10-01', 'ai'), 'ai-news');
  assert.equal(categoryFor('2026-10-01', 'news'), 'latest-news');

  const disabled = resolveRun({ event: 'schedule', cron: '0 4 * * *', now: morning, env: {} });
  assert.equal(disabled.pending, false);
  assert.equal(disabled.reason, 'disabled');
  assert.equal(disabled.slot, 'ai');

  const due = resolveRun({ event: 'schedule', cron: '0 11 * * *', now: afternoon, env: on });
  assert.equal(due.pending, true);
  assert.equal(due.slot, 'news');
  assert.equal(due.key, '2026-10-01 news');

  const again = resolveRun({
    event: 'schedule', cron: '22 11 * * *', now: afternoon, env: on,
    entries: [{ date: due.key, topic: 'yields' }],
  });
  assert.equal(again.reason, 'duplicate');
  assert.equal(CRON_SLOTS['0 4 * * *'], 'ai');
  assert.equal(CRON_SLOTS['22 4 * * *'], 'ai');
  assert.equal(CRON_SLOTS['0 7 * * *'], 'midday');
  assert.equal(CRON_SLOTS['0 14 * * *'], 'evening');
});

test('a verified fresh AI or news carousel may publish, and junk still may not', () => {
  const sourced = {
    brand: 'Rajesh Technical Traders',
    topic: 'Yields aur Nifty',
    caption: 'स्रोत: Reuters, 2026-10-01',
    slides: [{ headline: 'Nifty ne react kiya', source: 'Reuters, 2026-10-01' }],
  };
  assert.equal(publishDecision({
    generated: true, category: 'ai-news', spec: sourced,
    verifiedSource: true, sourceFresh: true, aiNewsEnabled: true,
  }).ok, true);
  assert.equal(publishDecision({
    generated: true, category: 'latest-news', spec: sourced,
    verifiedSource: true, sourceFresh: true, aiNewsEnabled: true,
  }).ok, true);

  const disabled = publishDecision({
    generated: true, category: 'latest-news', spec: sourced,
    verifiedSource: true, sourceFresh: true, aiNewsEnabled: false,
  });
  assert.equal(disabled.ok, false);
  assert.match(disabled.reasons.join(' '), /disabled/);

  const sourceless = publishDecision({
    generated: true, category: 'ai-news', spec: { topic: 'generic AI tips', slides: [{ headline: 'AI badal raha hai' }] },
    verifiedSource: false, sourceFresh: false, aiNewsEnabled: true,
  });
  assert.equal(sourceless.ok, false);
  assert.match(sourceless.reasons.join(' '), /verified fresh source/);

  const stale = publishDecision({
    generated: true, category: 'latest-news', spec: sourced,
    verifiedSource: true, sourceFresh: false, aiNewsEnabled: true,
  });
  assert.equal(stale.ok, false);

  const planets = {
    brand: 'FACTVIZER',
    topic: 'ग्रहों की घूर्णन अवधि',
    caption: 'milky way',
    slides: [{ headline: 'शुक्र', source: 'NASA, 2026-10-01' }, { headline: 'रोज़ एक नया तथ्य' }, { headline: 'रोज़ एक नया तथ्य' }],
  };
  const blocked = publishDecision({
    generated: true, category: 'ai-news', spec: planets,
    verifiedSource: true, sourceFresh: true, aiNewsEnabled: true,
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reasons.join(' '), /FACTVIZER/);
  assert.match(blocked.reasons.join(' '), /not finance|ग्रहों|planet/);
});

test('fresh items stay inside 48 hours and the citation is copied onto the slide and caption', () => {
  const now = freshItem.at;
  assert.equal(selectFresh([freshItem], now).length, 1);
  assert.equal(selectFresh([{ ...freshItem, at: now - MAX_SOURCE_AGE_MS - 1000 }], now).length, 0);
  const cited = applySourceCitation({
    caption: 'Yields badhne se Nifty halka girta hai.',
    slides: [
      { headline: 'hook' },
      { headline: 'asli baat', source: null },
      { headline: 'सेव करो', cta: true },
    ],
  }, freshItem);
  assert.equal(cited.slides[1].source, 'Reuters, 2026-10-01');
  assert.match(cited.caption, /Reuters, 2026-10-01/);

  const padded = normalizeSpec({
    category: 'ai-news',
    slides: [
      { band: 'center', headline: 'AI model', query: 'server room' },
      { headline: 'ek fact', subline: 'koi naya number nahi', source: 'OpenAI, 2026-10-01', query: 'office' },
    ],
  }, { sourced: true });
  assert.equal(padded.slides.some((slide) => /NSE \/ BSE/.test(String(slide.source || ''))), false);
});

test('a slot with no fresh source is skipped instead of filled with a generic carousel', async () => {
  const skipped = await generateSourcedCarousel({
    slot: 'ai', kind: 'ai', stories: [], record: false,
  });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /48 hours/);
  const stale = await generateSourcedCarousel({
    slot: 'news',
    kind: 'news',
    record: false,
    stories: [{ ...freshItem, at: Date.parse('2020-01-01T00:00:00Z') }],
  });
  assert.equal(stale.skipped, true);
});

test('the sourced prompt teaches a finance angle and forbids invented facts', () => {
  const text = buildSourcedPrompt({ kind: 'ai', stories: [freshItem], date: '2026-10-01' });
  assert.match(SYSTEM, /संख्या मत गढ़ो/);
  assert.match(text, /latest AI update/);
  assert.match(text, /Indian investors/);
  assert.match(text, /Reuters/);
  assert.match(text, /2026-10-01/);
  const news = buildSourcedPrompt({ kind: 'news', stories: [freshItem], date: '2026-10-01' });
  assert.match(news, /latest big news/);
  assert.match(news, /finance angle/);
});

test('feeds are the named outlets, not a generic fallback', () => {
  const names = [...AI_FEEDS, ...NEWS_FEEDS].map((feed) => feed.name);
  for (const name of ['The Verge', 'TechCrunch', 'OpenAI', 'Google AI', 'Economic Times', 'Moneycontrol', 'Reuters', 'PTI']) {
    assert.ok(names.includes(name), name);
  }
});

test('a reel story uses the video URL and a failure does not undo the reel', async () => {
  assert.deepEqual(videoStoryParams({ videoUrl: 'https://example.com/reel.mp4' }), {
    media_type: 'STORIES',
    video_url: 'https://example.com/reel.mp4',
  });
  const quiet = await attachReelStory({ enabled: false, videoUrl: 'https://example.com/reel.mp4', publish: async () => { throw new Error('nope'); } });
  assert.equal(quiet.attempted, false);
  const failed = await attachReelStory({
    enabled: true,
    videoUrl: 'https://example.com/reel.mp4',
    publish: async () => { throw new Error('story container failed'); },
  });
  assert.equal(failed.attempted, true);
  assert.match(failed.error, /story container failed/);
  assert.equal(failed.mediaId, undefined);
});

test('carousel cover stories do not double the evening frame, and preview still renders ai and news', () => {
  const spec = {
    slides: [
      { band: 'center', headline: 'hook', cta: false },
      { headline: 'fact', subline: '2026 में 10', cta: false },
      { headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
    ],
  };
  assert.equal(framesToPost(spec, { slot: 'midday' }).length, 0);
  assert.equal(framesToPost(spec, { slot: 'ai' }).length, 0);
  assert.equal(framesToPost(spec, { slot: 'midday', carouselStory: true }).length, 1);
  assert.equal(framesToPost(spec, { slot: 'evening', carouselStory: true }).length, 1);
  assert.equal(framesToPost(spec, { slot: 'ai', preview: true }).length, 1);
  assert.equal(framesToPost(spec, { slot: 'news', preview: true })[0].headline, 'hook');
});

test('workflows keep finance live, leave the new paths disabled, and accept ai and news previews', async () => {
  const carousel = await readFile('.github/workflows/carousel.yml', 'utf8');
  assert.match(carousel, /cron: '0 7 \* \* \*'/);
  assert.match(carousel, /cron: '0 14 \* \* \*'/);
  assert.match(carousel, /cron: '0 4 \* \* \*'/);
  assert.match(carousel, /cron: '0 11 \* \* \*'/);
  assert.match(carousel, /ENABLE_AI_NEWS_CAROUSELS/);
  assert.match(carousel, /ENABLE_CAROUSEL_STORY/);
  assert.match(carousel, /midday\|evening\|ai\|news/);
  assert.equal(carousel.includes("ENABLE_AI_NEWS_CAROUSELS: 'true'"), false);
  assert.equal(carousel.includes('ENABLE_AI_NEWS_CAROUSELS: "true"'), false);

  const reel = await readFile('.github/workflows/build-reel.yml', 'utf8');
  assert.match(reel, /cron: '30 1 \* \* \*'/);
  assert.match(reel, /ENABLE_REEL_STORY/);
  assert.match(reel, /reel-story-preview\.jpg/);
  assert.equal(reel.includes("ENABLE_REEL_STORY: 'true'"), false);
});
