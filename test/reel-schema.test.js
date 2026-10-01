import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseReelDraft } from '../pipeline/src/script/generate.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/script/prompt.js';

const card = {
  chips: ['FII'],
  headline: 'Kharidari',
  power: 'CASH',
  stat: null,
  footnote: 'NSE',
};

test('a beats array with no body becomes segments and a spoken body', () => {
  const parsed = parseReelDraft({
    family: 'market',
    topic: 'Nifty flat band',
    verdict: 'FLAT BAND',
    caption: 'Nifty flat band.',
    hashtags: ['#nifty50'],
    beats: [
      { type: 'hook', say: 'Market kholne se pehle teen baatein.', caption: 'Teen baatein', power: 'TEEN' },
      { type: 'chart', say: 'Nifty ne aaj flat band diya.', caption: 'flat band', power: 'FLAT' },
      { type: 'stock', say: 'Volume trading screen pe upar hai.', caption: 'volume upar', power: 'VOLUME' },
      { type: 'card', say: 'F I I ne cash market me kharidari ki.', caption: 'F I I kharidari', power: 'FII', card },
    ],
  });

  assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('; '));
  assert.equal(parsed.data.segments.length, 4);
  assert.equal(parsed.data.segments[0].type, 'hook');
  assert.match(parsed.data.body, /teen baatein/);
  assert.match(parsed.data.body, /flat band/);
  assert.equal(parsed.data.segments[1].card, null);
  assert.equal(parsed.data.segments[2].query, 'stock market screen');
  assert.equal(parsed.data.segments[0].seconds, null);
  assert.equal(parsed.data.segments[0].query, null);
  assert.equal(parsed.data.segments[0].article, null);
  assert.equal(parsed.data.segments[0].card.headline, 'Teen baatein');
});

test('omitted per-segment fields are filled instead of failing the schema', () => {
  const parsed = parseReelDraft({
    family: 'market',
    topic: 'Nifty volume',
    verdict: 'QUIET',
    caption: 'Volume up.',
    hashtags: ['#nifty50'],
    segments: [
      { type: 'hook', say: 'Teen baatein, market kholne se pehle.', caption: 'Teen baatein', power: 'TEEN' },
      { type: 'chart', say: 'Nifty ne flat band diya aaj.', caption: 'flat band', power: 'FLAT' },
    ],
  });

  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  const hook = parsed.data.segments[0];
  assert.equal(hook.seconds, null);
  assert.equal(hook.query, null);
  assert.equal(hook.article, null);
  assert.equal(typeof hook.card, 'object');
  assert.equal(parsed.data.segments[1].card, null);
  assert.match(parsed.data.body, /Teen baatein/);
});

test('a spec that already uses segments still gets a body when the model omits it', () => {
  const parsed = parseReelDraft({
    family: 'policy',
    topic: 'RBI rate hold',
    verdict: 'HOLD',
    caption: 'Rate same.',
    hashtags: ['#rbi'],
    segments: [
      {
        type: 'card',
        say: 'R B I ne rate nahi badla.',
        caption: 'rate same',
        power: 'RATE',
        seconds: null,
        query: null,
        article: null,
        card,
      },
    ],
  });

  assert.equal(parsed.success, true, parsed.success ? '' : JSON.stringify(parsed.error.issues));
  assert.equal(parsed.data.body, 'R B I ne rate nahi badla.');
  assert.equal(parsed.data.segments[0].card.headline, 'Kharidari');
});

test('the prompt names segments and body, and JSON mode stays on', async () => {
  const text = buildUserPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' });
  assert.match(text, /"segments"/);
  assert.match(text, /"body"/);
  assert.match(text, /to "beats"/);
  assert.match(SYSTEM, /never "beats"/);
  const provider = await readFile('pipeline/src/script/providers.js', 'utf8');
  assert.match(provider, /response_format: \{ type: 'json_object' \}/);
  assert.match(provider, /obj\.beats/);
});
