import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { offNicheReasons, publishDecision } from '../pipeline/src/publish/allow.js';
import { normalizeSpec } from '../pipeline/src/carousel/generate.js';
import { hookOpacity, coverTimestamp } from '../pipeline/src/render/reveal.js';
import { fitPlan } from '../pipeline/src/assemble/fit.js';
import { describeProviderFailure, extractJsonObject } from '../pipeline/src/script/providers.js';

const planets = {
  brand: 'FACTVIZER',
  topic: 'ग्रहों की घूर्णन अवधि',
  category: 'space',
  slides: [
    { headline: 'किस ग्रह पर एक दिन', query: 'milky way galaxy' },
    { headline: 'शुक्र', subline: '243 दिन' },
    { headline: 'रोज़ एक नया तथ्य' },
    { headline: 'रोज़ एक नया तथ्य' },
  ],
};

test('the planets fallback can never be published', () => {
  assert.ok(offNicheReasons(planets).length > 0);
  const decision = publishDecision({
    generated: false, reviewed: true, fallback: true, category: 'space', spec: planets, allowReviewed: true,
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reasons.join(' '), /FACTVIZER|not finance|not publishable/);
});

test('fresh finance may publish, a reviewed fallback only with the flag', () => {
  const spec = {
    brand: 'Rajesh Technical Traders',
    topic: 'ROCE और नकद',
    category: 'fundamentals',
    slides: [{ headline: 'Profit बढ़ा, नकद नहीं', query: 'stock exchange' }],
  };
  assert.deepEqual(offNicheReasons(spec), []);
  assert.equal(publishDecision({
    generated: true, category: 'fundamentals', spec,
  }).ok, true);
  assert.equal(publishDecision({
    generated: false, reviewed: true, fallback: true, category: 'fundamentals', spec,
  }).ok, false);
  assert.equal(publishDecision({
    generated: false, reviewed: true, fallback: true, category: 'fundamentals', spec, allowReviewed: true,
  }).ok, true);
});

test('the checked-in carousel is finance under the account brand and is not publishable by default', async () => {
  const spec = JSON.parse(await readFile('pipeline/specs/carousel-hindi.json', 'utf8'));
  assert.equal(spec.brand, 'Rajesh Technical Traders');
  assert.equal(spec.category, 'fundamentals');
  assert.equal(spec.reviewed, true);
  assert.equal(spec.fallback, true);
  assert.equal(JSON.stringify(spec).includes('FACTVIZER'), false);
  assert.equal(/ग्रह|milky way|solar/i.test(JSON.stringify(spec)), false);
  assert.equal(spec.slides.length, 10);
  assert.equal(publishDecision({
    generated: false, reviewed: true, fallback: true, category: spec.category, spec,
  }).ok, false);
});

test('padded filler slides are not given a market citation', () => {
  const spec = normalizeSpec({
    slides: [
      { band: 'center', headline: 'किस ग्रह पर', query: 'milky way' },
      { headline: 'शुक्र', subline: '243 दिन', source: 'NASA', query: 'venus' },
      { headline: 'रोज़ एक नया तथ्य', subline: 'Follow me', query: 'space' },
    ],
  });
  const filler = spec.slides.filter((s) => /रोज़ एक नया तथ्य/.test(s.headline || ''));
  assert.ok(filler.length > 1);
  assert.ok(filler.every((s) => !/NSE \/ BSE/.test(String(s.source || ''))));
});

test('frame 0 of an instant hook is fully visible, and that frame is the cover', () => {
  assert.equal(hookOpacity(0, { instant: true }), 1);
  assert.ok(hookOpacity(0, { instant: false }) < 0.05);
  assert.equal(hookOpacity(20, { instant: false }), 1);
  assert.equal(coverTimestamp({ instant: true }), 0);
  assert.equal(coverTimestamp({ instant: false }), 20 / 30);
});

test('a 31.8s reel is brought inside 20–30s, a much longer one is rejected', () => {
  const close = fitPlan(31.83);
  assert.equal(close.action, 'speed');
  assert.ok(close.target <= 30 && close.target >= 20);
  assert.ok(close.factor <= 1.15);
  assert.equal(fitPlan(25).action, 'keep');
  assert.equal(fitPlan(45).action, 'reject');
});

test('provider failures name the HTTP status and do not retry a balance problem', () => {
  const balance = describeProviderFailure({
    name: 'deepseek', status: 402, detail: 'Insufficient Balance sk-abc123secret',
  });
  assert.equal(balance.retryable, false);
  assert.match(balance.message, /HTTP 402/);
  assert.match(balance.message, /balance/);
  assert.equal(balance.message.includes('sk-abc123secret'), false);

  const empty = describeProviderFailure({
    name: 'deepseek', status: 200, detail: 'segments: expected array, received undefined',
  });
  assert.equal(empty.retryable, true);
  assert.match(empty.message, /HTTP 200/);
  assert.match(empty.message, /parsing problem/);

  const parsed = extractJsonObject('note {"segments":[{"type":"hook"}]} trailing');
  assert.equal(parsed.segments[0].type, 'hook');
});

test('preview does not share the publish queue, and a failed script does not publish', async () => {
  const carousel = await readFile('.github/workflows/carousel.yml', 'utf8');
  assert.match(carousel, /carousel-preview/);
  assert.match(carousel, /preview:/);
  assert.match(carousel, /pipeline\/out\/caption\.txt/);
  assert.match(carousel, /preview != 'true'/);
  assert.match(carousel, /--require-generated/);

  const reel = await readFile('.github/workflows/build-reel.yml', 'utf8');
  assert.match(reel, /cron: '17 16 \* \* \*'/);
  assert.match(reel, /build-reel-preview/);
  assert.match(reel, /--require-generated/);
  assert.match(reel, /pipeline\/out\/caption\.txt/);
  assert.match(reel, /preview != 'true'/);

  const build = await readFile('pipeline/build-reel.js', 'utf8');
  assert.match(build, /instant: true/);
  assert.match(build, /coverTimestamp/);
  const scene = await readFile('pipeline/src/render/scenes/card.html', 'utf8');
  assert.match(scene, /data\.instant/);
  assert.match(scene, /opacity = 1/);
});
