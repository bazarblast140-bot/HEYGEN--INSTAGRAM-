// What makes a background worth having.
//
// The first live carousel is the reason this file exists. The Venus slide came
// back as a featureless purple smear and the Jupiter slide as a solar-system
// diagram with Jupiter at the very edge — both matched their query, both showed
// the reader nothing. Search relevance and usefulness are not the same thing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bestPhoto, relevance } from '../pipeline/src/render/backgrounds.js';

const photo = (id, alt) => ({ id, alt });

test('a photo that describes the subject outranks one that does not', () => {
  assert.ok(relevance('the planet venus in space', 'venus planet') > relevance('a purple sky', 'venus planet'));
  assert.equal(relevance('', 'venus planet'), 0);
  assert.equal(relevance('venus', ''), 0);
});

test('stock-library filler is rejected even when it matches the query', () => {
  const chosen = bestPhoto([
    photo(1, 'abstract purple blurred background venus'),
    photo(2, 'the planet venus photographed by a spacecraft'),
  ], { query: 'venus planet', used: new Set() });

  assert.equal(chosen.id, 2);
});

test('every candidate being filler is a gradient, not a bad photo', () => {
  const chosen = bestPhoto([
    photo(1, 'blurred gradient wallpaper'),
    photo(2, 'abstract texture backdrop'),
  ], { query: 'venus planet', used: new Set() });

  assert.equal(chosen, null);
});

test('a photo already used in this carousel is not offered again', () => {
  const candidates = [photo(1, 'the planet venus'), photo(2, 'venus seen from orbit')];
  const used = new Set(['1']);
  assert.equal(bestPhoto(candidates, { query: 'venus planet', used }).id, 2);

  used.add('2');
  assert.equal(bestPhoto(candidates, { query: 'venus planet', used }), null);
});

// Ranking has to fall back to the library's own order, or two equally
// irrelevant photos would be picked at random between runs.
test('ties keep the source ordering', () => {
  const chosen = bestPhoto([
    photo(1, 'a rock'),
    photo(2, 'a stone'),
  ], { query: 'venus planet', used: new Set() });

  assert.equal(chosen.id, 1);
});
