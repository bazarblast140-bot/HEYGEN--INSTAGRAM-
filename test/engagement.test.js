// Likes are a thin measure, and on this account they are the only one: the
// insights edge answers "(#10) Application does not have permission". So the
// joining has to be right, because it is all the evidence there will be.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { slotOfPost, dateOfPost, join, byAngle } from '../pipeline/src/publish/engagement.js';

// Instagram timestamps are UTC; the slots are 06:07, 13:07 and 17:07 IST.
test('a post lands in the slot it was published for', () => {
  assert.equal(slotOfPost('2026-09-10T00:40:00+0000'), 'morning');   // 06:10 IST
  assert.equal(slotOfPost('2026-09-10T07:40:00+0000'), 'midday');    // 13:10 IST
  assert.equal(slotOfPost('2026-09-10T11:40:00+0000'), 'evening');   // 17:10 IST
});

// A late post must still count as its own slot, not the next one.
test('a post an hour late is still its own slot', () => {
  assert.equal(slotOfPost('2026-09-10T02:00:00+0000'), 'morning');   // 07:30 IST
  assert.equal(slotOfPost('2026-09-10T09:30:00+0000'), 'midday');    // 15:00 IST
});

test('the date is the Indian date, not the UTC one', () => {
  // 23:00 IST on the 10th is 17:30 UTC on the 10th — same day.
  assert.equal(dateOfPost('2026-09-10T17:30:00+0000'), '2026-09-10');
  // 01:00 IST on the 11th is 19:30 UTC on the 10th — the Indian day has turned.
  assert.equal(dateOfPost('2026-09-10T19:30:00+0000'), '2026-09-11');
});

const entries = [
  { date: '2026-09-10 morning', topic: 'बुध ग्रह', angle: 'space' },
  { date: '2026-09-10 midday', topic: 'आज की ख़बरें', angle: 'technology' },
  { date: '2026-09-09 evening', topic: 'गोल्डबैक', angle: 'science' },
];
const posts = [
  { date: '2026-09-10', slot: 'morning', likes: 4, comments: 1, permalink: 'https://x/1' },
  { date: '2026-09-09', slot: 'evening', likes: 2, comments: 0, permalink: 'https://x/2' },
];

test('a post is matched to what was written that slot', () => {
  const rows = join(entries, posts);
  assert.equal(rows[0].likes, 4);
  assert.equal(rows[0].angle, 'space');
  assert.equal(rows[2].likes, 2);
});

// A slot with no post is a day the post did not go out — a different problem
// from a post nobody liked, and the report must not confuse the two.
test('a slot with no post reads as unknown, not as zero', () => {
  const rows = join(entries, posts);
  assert.equal(rows[1].likes, null, 'a missing post must not score zero likes');
});

test('subjects are ranked by average, with the count kept visible', () => {
  const rows = join([
    ...entries,
    { date: '2026-09-08 morning', topic: 'शुक्र', angle: 'space' },
  ], [
    ...posts,
    { date: '2026-09-08', slot: 'morning', likes: 10, comments: 0, permalink: 'https://x/3' },
  ]);

  const ranked = byAngle(rows.filter((r) => r.likes != null));
  assert.equal(ranked[0].angle, 'space');
  assert.equal(ranked[0].posts, 2, 'the count must survive so one lucky post is visible');
  assert.equal(ranked[0].average, 7);
  assert.equal(ranked[0].best.likes, 10);
});

test('nothing measured is not a crash', () => {
  assert.deepEqual(byAngle([]), []);
  assert.deepEqual(join([], []), []);
});
