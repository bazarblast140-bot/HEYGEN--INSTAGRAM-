// The account read as two things — space and AI — because space was listed
// four times in a pool of eight subjects. Fixing that was not enough on its
// own: an intermediate pool of 32 entries with the old offset gave "food" four
// turns in three weeks and "space" none, and the whole suite passed, because
// nothing here asserted that the rotation is even.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { POOL, FINANCE, STRIDE, SLOT_OFFSET, BRIEFS, categoryFor } from '../pipeline/src/carousel/categories.js';

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

test('over one cycle every general subject gets exactly one morning', () => {
  const mornings = {};
  for (let d = 0; d < POOL.length; d += 1) {
    const c = categoryFor(day(d), 'morning');
    mornings[c] = (mornings[c] || 0) + 1;
  }
  for (const category of POOL) {
    assert.equal(mornings[category], 1, `${category} got ${mornings[category] || 0} mornings in a cycle`);
  }
});

// The evening is money, and it walks its own shorter list.
test('over one finance cycle every money subject gets exactly one evening', () => {
  const evenings = {};
  for (let d = 0; d < FINANCE.length; d += 1) {
    const c = categoryFor(day(d), 'evening');
    evenings[c] = (evenings[c] || 0) + 1;
  }
  for (const category of FINANCE) {
    assert.equal(evenings[category], 1, `${category} got ${evenings[category] || 0} evenings`);
  }
});

test('every money subject has a brief, and none of them is a general one', () => {
  for (const category of FINANCE) {
    assert.ok(BRIEFS[category], `"${category}" is an evening subject with no brief`);
    assert.ok(!POOL.includes(category), `"${category}" is in both pools — money belongs to the evening`);
  }
});

// 506 people followed a trading account. The evening post is the one that
// speaks to them, and it must never be anything else.
test('the evening is always money and the morning never is', () => {
  for (let d = 0; d < 40; d += 1) {
    assert.ok(FINANCE.includes(categoryFor(day(d), 'evening')), `evening of ${day(d)} is not money`);
    assert.ok(!FINANCE.includes(categoryFor(day(d), 'morning')), `morning of ${day(d)} is money`);
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

// The one rule on this account that is not about quality. A Hindi facts page
// telling 506 people which share to buy is a different kind of mistake from a
// dull slide, and it is the prompt that has to carry it.
test('the money rule forbids advice, not merely discourages it', async () => {
  const { SYSTEM } = await import('../pipeline/src/carousel/prompt.js');

  assert.match(SYSTEM, /सलाह नहीं देते/, 'the prompt must say outright that it gives no advice');
  for (const forbidden of ['ख़रीदें', 'बेचें', 'भविष्यवाणी', 'टिप']) {
    assert.ok(SYSTEM.includes(forbidden), `the rule should name "${forbidden}" as forbidden`);
  }
  // And it must name the sources, because a remembered number is the other way
  // this goes wrong.
  for (const source of ['RBI', 'SEBI']) {
    assert.ok(SYSTEM.includes(source), `the rule should point at ${source}`);
  }
  // Every money subject must be covered by the rule by name.
  const { FINANCE } = await import('../pipeline/src/carousel/categories.js');
  for (const category of FINANCE) {
    assert.ok(SYSTEM.includes(category), `the money rule does not mention "${category}"`);
  }
});
