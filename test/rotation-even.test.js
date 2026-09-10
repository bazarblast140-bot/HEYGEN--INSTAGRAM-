// The account read as two things — space and AI — because space was listed
// four times in a pool of eight subjects. Fixing that was not enough on its
// own: an intermediate pool of 32 entries with the old offset gave "food" four
// turns in three weeks and "space" none, and the whole suite passed, because
// nothing here asserted that the rotation is even.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POOL, STRIDE, SLOT_OFFSET, BRIEFS, categoryFor } from '../pipeline/src/carousel/categories.js';

const day = (n) => new Date(Date.UTC(2026, 8, 10 + n)).toISOString().slice(0, 10);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

test('every subject in the pool has a brief to write from', () => {
  for (const category of POOL) {
    assert.ok(BRIEFS[category], `"${category}" is in the rotation with no brief`);
  }
});

test('no subject is listed more than once', () => {
  assert.equal(new Set(POOL).size, POOL.length, 'a repeated entry is a weighting in disguise');
});

// Without this the rotation revisits a few subjects and never reaches others.
test('the stride walks the whole pool', () => {
  assert.equal(gcd(STRIDE, POOL.length), 1, `stride ${STRIDE} and pool ${POOL.length} share a factor`);
});

test('over one cycle every subject gets exactly one morning and one evening', () => {
  const mornings = {};
  const evenings = {};
  for (let d = 0; d < POOL.length; d += 1) {
    const date = day(d);
    mornings[categoryFor(date, 'morning')] = (mornings[categoryFor(date, 'morning')] || 0) + 1;
    evenings[categoryFor(date, 'evening')] = (evenings[categoryFor(date, 'evening')] || 0) + 1;
  }
  for (const category of POOL) {
    assert.equal(mornings[category], 1, `${category} got ${mornings[category] || 0} mornings in a cycle`);
    assert.equal(evenings[category], 1, `${category} got ${evenings[category] || 0} evenings in a cycle`);
  }
});

test('a day never runs the same subject twice', () => {
  for (let d = 0; d < POOL.length * 2; d += 1) {
    const date = day(d);
    assert.notEqual(categoryFor(date, 'morning'), categoryFor(date, 'evening'), `both posts on ${date}`);
  }
});

// The offset used to be 10 against a stride of 5, which made the evening pick
// the morning pick of two days later.
test('the evening pick is not a morning pick from the same week', () => {
  for (let d = 0; d < POOL.length; d += 1) {
    const evening = categoryFor(day(d), 'evening');
    for (let ahead = 1; ahead <= 5; ahead += 1) {
      assert.notEqual(evening, categoryFor(day(d + ahead), 'morning'),
        `evening of ${day(d)} repeats as morning of ${day(d + ahead)}`);
    }
  }
  assert.equal(SLOT_OFFSET * 2, POOL.length, 'the offset should stay half the pool');
});
