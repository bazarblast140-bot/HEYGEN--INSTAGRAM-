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

// Real titles, from the first CI run that used NASA. The ranker chose the first
// of each pair; the second is the picture a reader actually wants.
test('a photo OF the subject beats one that merely mentions it', () => {
  const chosen = bestPhoto([
    { id: 1, alt: 'STS-30 sunset with Venus near the center of the frame ATLANTIS' },
    { id: 2, alt: 'Venus - Computer Simulated Global View of the Northern Hemisphere' },
  ], { query: 'venus planet', used: new Set() });

  assert.equal(chosen.id, 2);
});

test('a title that opens with the subject wins on equal wording', () => {
  assert.ok(
    relevance('Jupiter and its moon Io', 'jupiter planet')
    > relevance('A wide view of the outer solar system including Jupiter', 'jupiter planet'),
  );
});

test('circumstance words are a penalty, not a match', () => {
  assert.ok(
    relevance('Earth from orbit', 'earth from space')
    > relevance('Crew briefing before launch, Earth globe on the table', 'earth from space'),
  );
});

// The bug that shipped: two slides of a live post came out as empty gradients.
// "Blurred background" is what a good photograph of a small animal looks like,
// and treating those words as disqualifying threw away every candidate.
test('a blurred background does not disqualify a photo of the subject', () => {
  const chosen = bestPhoto([
    { id: 1, alt: 'Hummingbird hovering near a flower with blurred background' },
  ], { query: 'hummingbird bird', used: new Set() });

  assert.equal(chosen?.id, 1);
});

test('an undescribed photo is used before falling back to the gradient', () => {
  const chosen = bestPhoto([
    { id: 1, alt: '' },
    { id: 2, alt: 'a wooden table' },
  ], { query: 'hummingbird bird', used: new Set() });

  assert.equal(chosen?.id, 1);
});

// Also from the live post: a slide about butterflies got a photograph of socks.
test('a person wearing the subject is not the subject', () => {
  const chosen = bestPhoto([
    { id: 1, alt: 'Photograph of feet in butterfly socks next to sneakers' },
    { id: 2, alt: 'Butterfly resting on a flower in summer sunlight' },
  ], { query: 'butterfly insect', used: new Set() });

  assert.equal(chosen.id, 2);
});

test('a drawing of the subject loses to a photograph of it', () => {
  const chosen = bestPhoto([
    { id: 1, alt: 'Cartoon drawing of an octopus' },
    { id: 2, alt: 'Octopus tentacles underwater' },
  ], { query: 'octopus tentacles', used: new Set() });

  assert.equal(chosen.id, 2);
});
