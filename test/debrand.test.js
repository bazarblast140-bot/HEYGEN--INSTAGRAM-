// "linux penguin" returns a penguin, and it reached the feed twice on a Linux
// story. The prompt already forbade company names in queries; a prompt is a
// request, so this is the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deBrand, isBranded, NEUTRAL } from '../pipeline/src/render/backgrounds.js';

test('the query that actually went wrong is replaced', () => {
  assert.ok(isBranded('linux penguin'));
  assert.ok(NEUTRAL.includes(deBrand('linux penguin')));
});

// Dropping the brand word alone leaves "penguin", and the penguin was the bug.
test('the whole query is replaced, not just the brand word', () => {
  const out = deBrand('linux penguin');
  assert.doesNotMatch(out, /penguin/i);
  assert.doesNotMatch(out, /linux/i);
});

test('other unambiguous brands too', () => {
  for (const q of ['openai model launch', 'nvidia chip factory', 'github code review', 'android phone screen']) {
    assert.ok(isBranded(q), `${q} was not caught`);
  }
});

// An animals or food carousel must keep its apples and its pythons.
test('an ambiguous word on its own is left alone', () => {
  for (const q of ['apple orchard harvest', 'python snake coiled', 'swift bird flying', 'ruby gemstone macro']) {
    assert.equal(isBranded(q), false, `${q} was wrongly treated as a brand`);
    assert.equal(deBrand(q), q);
  }
});

test('the same word in a technology sentence is a brand', () => {
  assert.ok(isBranded('apple laptop software'));
  assert.ok(isBranded('python code developer'));
  assert.ok(isBranded('meta ai model'));
});

test('an ordinary query passes through untouched', () => {
  for (const q of ['venus planet globe', 'ancient stone temple', 'data center servers']) {
    assert.equal(deBrand(q), q);
  }
});

// Two branded slides in one carousel must not get the same replacement.
test('the replacement rotates by slide', () => {
  assert.notEqual(deBrand('linux penguin', 0), deBrand('nvidia chip', 1));
});

test('nothing to check is not an error', () => {
  assert.equal(isBranded(''), false);
  assert.equal(isBranded(null), false);
  assert.equal(deBrand(undefined), undefined);
});
