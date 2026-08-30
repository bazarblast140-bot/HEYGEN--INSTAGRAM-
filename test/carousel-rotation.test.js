// The rotation's whole job is to stop two similar days landing together, and
// the failure it exists to prevent is invisible in a single call — you only see
// it across a week. So it is checked across a week, and across a full cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POOL, STRIDE, SLOT_OFFSET, SLOTS, categoryFor, slotFor, dayNumber } from '../pipeline/src/carousel/categories.js';

const gcd = (a, b) => (b ? gcd(b, a % b) : a);

test('the stride is coprime with the pool, so every weight is honoured', () => {
  assert.equal(gcd(STRIDE, POOL.length), 1);

  // A coprime stride visits every index exactly once per cycle, which is what
  // keeps the weighting exact rather than approximate.
  const seen = new Set();
  for (let i = 0; i < POOL.length; i += 1) seen.add((i * STRIDE) % POOL.length);
  assert.equal(seen.size, POOL.length);
});

test('a full cycle picks each category exactly as often as its weight', () => {
  const start = dayNumber('2026-01-01');
  const counts = new Map();
  for (let i = 0; i < POOL.length; i += 1) {
    const day = new Date((start + i) * 86400000).toISOString().slice(0, 10);
    const c = categoryFor(day);
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  const expected = new Map();
  for (const c of POOL) expected.set(c, (expected.get(c) || 0) + 1);
  assert.deepEqual([...counts].sort(), [...expected].sort());
});

// The bug this replaced: stepping one at a time walks straight through a block
// of identical entries, so a category weighted 4 produced four days running.
test('no two consecutive days share a category, over two full cycles', () => {
  const start = dayNumber('2026-01-01');
  let previous = null;
  const runs = [];

  for (let i = 0; i < POOL.length * 2; i += 1) {
    const day = new Date((start + i) * 86400000).toISOString().slice(0, 10);
    const c = categoryFor(day);
    if (c === previous) runs.push(`${day} repeats ${c}`);
    previous = c;
  }

  assert.deepEqual(runs, []);
});

test('the same date always chooses the same category', () => {
  assert.equal(categoryFor('2026-03-14'), categoryFor('2026-03-14'));
  assert.equal(categoryFor(new Date('2026-03-14T18:30:00Z')), categoryFor('2026-03-14'));
});

// Two posts a day, and the trap moves: the stride keeps yesterday away from
// today and says nothing about 06:00 versus 17:00, which land on the same index
// unless the slot moves it.

const dates = (n, from = '2026-01-01') => {
  const start = dayNumber(from);
  return Array.from({ length: n }, (_, i) => new Date((start + i) * 86400000).toISOString().slice(0, 10));
};

test('the morning and evening posts are never the same category', () => {
  const same = dates(POOL.length * 2)
    .filter((d) => categoryFor(d, 'morning') === categoryFor(d, 'evening'));
  assert.deepEqual(same, []);
});

test('no two posts in a row repeat, reading the day as morning then evening', () => {
  const runs = [];
  let previous = null;
  for (const day of dates(POOL.length * 2)) {
    for (const slot of SLOTS) {
      const c = categoryFor(day, slot);
      if (c === previous) runs.push(`${day} ${slot} repeats ${c}`);
      previous = c;
    }
  }
  assert.deepEqual(runs, []);
});

test('over a full cycle each category comes up exactly twice its weight', () => {
  const counts = new Map();
  for (const day of dates(POOL.length)) {
    for (const slot of SLOTS) {
      const c = categoryFor(day, slot);
      counts.set(c, (counts.get(c) || 0) + 1);
    }
  }
  // Weights, doubled: the pool holds each category `weight` times, and each
  // slot walks the whole pool once per cycle.
  const weights = new Map();
  for (const c of POOL) weights.set(c, (weights.get(c) || 0) + 1);
  for (const [category, weight] of weights) assert.equal(counts.get(category), weight * 2, category);
});

// The offset has to clear the widest block of one category, in both directions:
// the gaps in the sequence alternate +SLOT_OFFSET and +(STRIDE - SLOT_OFFSET).
test('the slot offset clears the longest block of one category', () => {
  let longest = 1;
  let run = 1;
  for (let i = 1; i < POOL.length; i += 1) {
    run = POOL[i] === POOL[i - 1] ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  const circular = (step) => Math.min(((step % POOL.length) + POOL.length) % POOL.length,
    POOL.length - (((step % POOL.length) + POOL.length) % POOL.length));

  assert.ok(circular(SLOT_OFFSET) >= longest, 'the evening step lands inside a block');
  assert.ok(circular(STRIDE - SLOT_OFFSET) >= longest, 'the next morning lands inside the evening\'s block');
});

test('the slot is read from the clock, IST 06:00 and 17:00 being 00:30 and 11:30 UTC', () => {
  assert.equal(slotFor(new Date('2026-03-14T00:30:00Z')), 'morning');
  assert.equal(slotFor(new Date('2026-03-14T11:30:00Z')), 'evening');
  // A run that starts late is still the run it was scheduled as.
  assert.equal(slotFor(new Date('2026-03-14T05:45:00Z')), 'morning');
});

test('an unknown slot is refused rather than silently treated as morning', () => {
  assert.throws(() => categoryFor('2026-03-14', 'afternoon'), /Unknown slot/);
});
