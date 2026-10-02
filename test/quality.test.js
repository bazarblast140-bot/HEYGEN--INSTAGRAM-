import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextQualityStep, reviewContent } from '../pipeline/src/quality/review.js';
import { chartCredit } from '../pipeline/src/render/chart-credit.js';
import { SYSTEM as reelSystem } from '../pipeline/src/script/prompt.js';
import { SYSTEM as carouselSystem, buildUserPrompt } from '../pipeline/src/carousel/prompt.js';

const goodCarousel = {
  topic: 'ROCE',
  caption: 'ROCE 18% girne ka matlab kya hai? Bas wahi ek sawal.',
  hashtags: ['#roce', '#nifty50'],
  slides: [
    { band: 'center', headline: 'ROCE 18% kyun gira?', subline: null, source: null },
    { headline: 'Cash flow 2026-10-01', subline: 'profit ke saath nahi badha', source: 'NSE, 2026-10-01' },
  ],
};

test('a sourced carousel with one comment question clears the gate', () => {
  const review = reviewContent({
    kind: 'carousel',
    spec: goodCarousel,
    trends: null,
    now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(review.pass, true);
  assert.ok(review.score >= review.threshold);
});

test('a thin carousel is sent back, then skipped after the retry budget', () => {
  const review = reviewContent({
    kind: 'carousel',
    spec: {
      topic: 'markets',
      caption: 'hello',
      hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'],
      slides: [{ headline: 'stock market basics for every new trader this year and beyond' }],
    },
    trends: null,
    now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(review.pass, false);
  assert.ok(review.problems.length >= 3);
  const first = nextQualityStep({ review, fails: 0, attempt: 1, retries: 3 });
  assert.equal(first.action, 'retry');
  const last = nextQualityStep({ review, fails: 2, attempt: 3, retries: 3 });
  assert.equal(last.action, 'skip');
});

test('a fresh competitor hook style counts only when trends are fresh', () => {
  const trends = {
    patterns: [{
      coverStyle: 'number',
      hook: 'Nifty 25000',
      fetchedAt: '2026-10-01T00:00:00Z',
      engagementRate: 0.02,
      timestamp: '2026-10-01T00:00:00Z',
    }],
  };
  const matched = reviewContent({
    kind: 'carousel', spec: goodCarousel, trends, now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(matched.checks.find((check) => check.id === 'trend').pass, true);
  const missed = reviewContent({
    kind: 'carousel',
    spec: {
      ...goodCarousel,
      slides: [{ ...goodCarousel.slides[0], headline: 'kyun gir gaya?' }, goodCarousel.slides[1]],
    },
    trends,
    now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(missed.checks.find((check) => check.id === 'trend').pass, false);
  const quiet = reviewContent({
    kind: 'carousel', spec: goodCarousel, trends: { patterns: [] }, now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(quiet.checks.some((check) => check.id === 'trend'), false);
});

test('a reel hook is scored from the first spoken line', () => {
  const review = reviewContent({
    kind: 'reel',
    spec: {
      caption: 'Nifty ka 1.2% move kya sikhata hai? Ek line likho.',
      hashtags: ['#nifty50'],
      segments: [
        { say: 'Nifty 1.2% girne ke peeche kya hai?', caption: 'Nifty 1.2% kyun?', card: { headline: 'Nifty 1.2% kyun?' } },
      ],
    },
    trends: null,
    now: new Date('2026-10-02T00:00:00Z'),
  });
  assert.equal(review.checks.find((check) => check.id === 'hook').pass, true);
  assert.equal(review.pass, true);
});

test('charts name the source and the date, and the prompts ask for one bold hook', () => {
  assert.equal(chartCredit({ source: 'yahoo-finance', synthetic: false }, { date: '2026-10-01' }), 'yahoo-finance · 2026-10-01');
  assert.equal(chartCredit({ synthetic: true, source: 'synthetic' }, { date: '2026-10-01' }), 'SAMPLE DATA');
  assert.match(carouselSystem, /1–2 second/);
  assert.match(buildUserPrompt({ category: 'fundamentals', date: '2026-10-01' }), /एक ही specific सवाल/);
  assert.match(reelSystem, /at most eight words/);
});
