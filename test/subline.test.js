// The renderer shrinks text until it occupies the number of lines the spec
// asked for. A subline written as one long unbroken sentence therefore came out
// at the minimum size -- readable on a laptop, not on a phone. It is repaired
// before rendering rather than rejected, because there is only one right answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { balanceSubline, SUBLINE_ONE_LINE } from '../pipeline/build-carousel.js';

// The one that actually reached the feed at 40px.
const LIVE = 'कैलिफोर्निया में उम्र सत्यापन कानून से Linux मुक्त, डेवलपर्स के लिए राहत';

test('a long single line is broken in two', () => {
  const out = balanceSubline(LIVE);
  const lines = out.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines.join(' '), LIVE);
});

test('the break lands near the middle, so neither line is a stub', () => {
  const [a, b] = balanceSubline(LIVE).split('\n');
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  assert.ok(ratio > 0.6, `lines are lopsided: ${a.length} vs ${b.length}`);
});

test('a short line is left alone', () => {
  const short = 'दशकों के खोए PC गेम्स';
  assert.ok(short.length <= SUBLINE_ONE_LINE);
  assert.equal(balanceSubline(short), short);
});

test('two lines are kept as two', () => {
  assert.equal(balanceSubline('पहली पंक्ति\nदूसरी पंक्ति'), 'पहली पंक्ति\nदूसरी पंक्ति');
});

test('three lines fold into two', () => {
  assert.equal(balanceSubline('एक\nदो\nतीन'), 'एक\nदो तीन');
});

test('nothing to break is not an error', () => {
  assert.equal(balanceSubline(null), null);
  assert.equal(balanceSubline(''), '');
  const oneWord = 'क'.repeat(SUBLINE_ONE_LINE + 10);
  assert.equal(balanceSubline(oneWord), oneWord);
});
