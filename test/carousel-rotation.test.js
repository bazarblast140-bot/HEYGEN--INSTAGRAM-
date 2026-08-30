// The rotation's whole job is to stop two similar days landing together, and
// the failure it exists to prevent is invisible in a single call — you only see
// it across a week. So it is checked across a week, and across a full cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POOL, STRIDE, categoryFor, dayNumber } from '../pipeline/src/carousel/categories.js';

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
