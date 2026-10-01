// A run that arrives without a slot used to become "evening" and publish at
// 06:09 IST. The slot now comes from the IST window, or the run does not post.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveRun } from '../pipeline/src/carousel/categories.js';
import { framesToPost } from '../pipeline/src/carousel/story.js';

const at = (iso) => new Date(iso);

test('a run with no slot at 06:07 IST does not post', () => {
  const decision = resolveRun({ event: 'workflow_dispatch', dispatchSlot: 'auto', now: at('2026-10-01T00:37:00Z') });
  assert.equal(decision.pending, false);
  assert.equal(decision.reason, 'outside');
  assert.equal(decision.slot, '');
});

test('12:30 IST is the optional midday post', () => {
  const decision = resolveRun({ now: at('2026-10-01T07:00:00Z') });
  assert.equal(decision.slot, 'midday');
  assert.equal(decision.pending, true);
  assert.equal(decision.reason, 'due');
});

test('19:30 IST is the main evening post', () => {
  const decision = resolveRun({ now: at('2026-10-01T14:00:00Z') });
  assert.equal(decision.slot, 'evening');
  assert.equal(decision.pending, true);
});

test('an explicit evening slot at 17:07 IST is the wrong time', () => {
  const decision = resolveRun({
    event: 'workflow_dispatch',
    dispatchSlot: 'evening',
    now: at('2026-10-01T11:37:00Z'),
  });
  assert.equal(decision.pending, false);
  assert.equal(decision.reason, 'wrong-time');
});

test('a scheduled run keeps its slot even when the clock is hours off', () => {
  const decision = resolveRun({
    event: 'schedule',
    cron: '0 14 * * *',
    now: at('2026-10-01T00:37:00Z'),
  });
  assert.equal(decision.slot, 'evening');
  assert.equal(decision.pending, true);
  assert.equal(decision.reason, 'due');
});

test('a second run in the same window does not post again', () => {
  const now = at('2026-10-01T14:00:00Z');
  const first = resolveRun({ now, entries: [] });
  const second = resolveRun({
    now,
    entries: [{ date: first.key, topic: 'ROCE' }],
  });
  assert.equal(second.pending, false);
  assert.equal(second.reason, 'duplicate');
});

test('the build uses the resolved slot, not the raw auto input', async () => {
  const text = await readFile(new URL('../.github/workflows/carousel.yml', import.meta.url), 'utf8');
  assert.match(text, /options: \['auto', 'midday', 'evening'\]/);
  assert.match(text, /default: 'auto'/);
  assert.equal(text.includes("format('--slot {0}', github.event.inputs.slot)"), false);
  assert.match(text, /steps\.slot\.outputs\.slot && format\('--slot \{0\}', steps\.slot\.outputs\.slot\)/);
});

const spec = {
  slides: [
    { band: 'center', headline: 'ROCE गिर रहा है', cta: false },
    { headline: 'नकद', subline: '2024 में 700 करोड़', cta: false },
    { headline: 'सेव करो', subline: 'फ़ॉलो करो', cta: true },
  ],
};

test('only the evening post gets a story, and only one frame', () => {
  assert.equal(framesToPost(spec, { slot: 'midday' }).length, 0);
  assert.equal(framesToPost(spec, { slot: '' }).length, 0);
  const frames = framesToPost(spec, { slot: 'evening' });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].headline, 'ROCE गिर रहा है');
});
