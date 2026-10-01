import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkReelShape } from '../pipeline/src/script/generate.js';
import { buildUserPrompt } from '../pipeline/src/script/prompt.js';
import {
  retryNoteFor,
  shortenReelScript,
  spokenWordCount,
  wordCountProblem,
} from '../pipeline/src/script/length.js';

function sentence(n, label) {
  return Array.from({ length: n }, (_, i) => `${label}${i + 1}`).join(' ') + '.';
}

function beat(type, say, extra = {}) {
  return {
    type,
    say,
    caption: 'line',
    power: 'X',
    seconds: null,
    query: type === 'stock' ? 'stock market screen' : null,
    article: null,
    card: type === 'chart' ? null : { chips: [], headline: 'Line', power: 'X', stat: null, footnote: '' },
    ...extra,
  };
}

test('a 102-word script is cut into range without touching the hook or the CTA', () => {
  const hook = sentence(12, 'hook');
  const cta = sentence(12, 'cta');
  const spec = {
    topic: 'Nifty flat band',
    family: 'market',
    verdict: 'FLAT',
    caption: 'Nifty flat.',
    hashtags: ['#nifty50'],
    segments: [
      beat('hook', hook),
      beat('chart', sentence(12, 'chart')),
      beat('stock', sentence(12, 'stock')),
      beat('card', `${sentence(11, 'cardA')} ${sentence(11, 'cardB')}`),
      beat('card', `${sentence(11, 'cardC')} ${sentence(11, 'cardD')}`),
      beat('cutin', sentence(10, 'cut')),
      beat('card', cta),
    ],
  };

  assert.equal(spokenWordCount(spec), 102);
  const shortened = shortenReelScript(spec);
  const words = spokenWordCount(shortened);
  assert.ok(words >= 56 && words <= 78, `landed on ${words}`);
  assert.equal(shortened.segments[0].say, hook);
  assert.equal(shortened.segments[shortened.segments.length - 1].say, cta);
  assert.ok(shortened.segments.some((s) => s.type === 'chart'));
  assert.ok(shortened.segments.some((s) => s.type === 'stock'));
  assert.equal(shortened.body, shortened.segments.map((s) => s.say.trim()).join(' '));
  assert.equal(checkReelShape(shortened).some((p) => /words/.test(p)), false);
});

test('body cuts stay on sentence boundaries and drop a card before the chart', () => {
  const spec = {
    segments: [
      beat('hook', sentence(12, 'hook')),
      beat('chart', sentence(12, 'chart')),
      beat('stock', sentence(12, 'stock')),
      beat('card', `${sentence(20, 'keep')} ${sentence(20, 'drop')}`),
      beat('card', sentence(14, 'cta')),
    ],
  };
  assert.equal(spokenWordCount(spec), 90);
  const shortened = shortenReelScript(spec);
  const card = shortened.segments.find((s) => s.type === 'card' && s.say.startsWith('keep'));
  assert.ok(card, 'the earlier sentence of the body card stays');
  assert.equal(card.say.includes('drop1'), false);
  assert.match(card.say, /\.$/);
  assert.equal(spokenWordCount(shortened) <= 78, true);
  assert.equal(shortened.segments.find((s) => s.type === 'chart').say, spec.segments[1].say);
});

test('a short script is not padded', () => {
  const spec = {
    topic: 'nifty volume',
    segments: [beat('hook', 'ek do teen')],
  };
  const shortened = shortenReelScript(spec);
  assert.equal(shortened.segments[0].say, 'ek do teen');
  assert.equal(spokenWordCount(shortened), 3);
  const problems = checkReelShape(spec);
  assert.ok(problems.some((p) => /do not add filler/.test(p)));
});

test('a cut that would fall below 56 words is refused', () => {
  const spec = {
    segments: [
      beat('hook', sentence(14, 'hook')),
      beat('chart', sentence(14, 'chart')),
      beat('stock', sentence(14, 'stock')),
      beat('card', sentence(26, 'only')),
      beat('card', sentence(12, 'cta')),
    ],
  };
  assert.equal(spokenWordCount(spec), 80);
  const shortened = shortenReelScript(spec);
  assert.equal(spokenWordCount(shortened), 80);
  assert.equal(shortened.segments.length, spec.segments.length);
  assert.equal(shortened.segments[3].say, spec.segments[3].say);
});

test('retry feedback tells the model the exact count and the cut target', () => {
  const problem = wordCountProblem(102);
  assert.equal(
    problem,
    'your script had 102 words; it must be 56–78 words total; cut to 64 words',
  );
  const note = retryNoteFor([problem, 'no chart beat']);
  assert.match(note, /Your previous attempt was rejected:/);
  assert.match(note, /- your script had 102 words; it must be 56–78 words total; cut to 64 words/);
  assert.match(note, /- no chart beat/);
  assert.match(note, /Fix exactly these and return the full spec again\./);
  assert.match(wordCountProblem(40), /do not add filler/);
  assert.equal(wordCountProblem(64), null);
});

test('the prompt states the hook, body, and CTA budget', () => {
  const text = buildUserPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' });
  assert.match(text, /hook: 12 words/);
  assert.match(text, /body: 40 words/);
  assert.match(text, /CTA: 12 words/);
  assert.match(text, /12 \+ 40 \+ 12 = 64/);
  assert.match(text, /56 to 78/);
});
