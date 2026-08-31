// Hand-supplied pictures fill the gaps the search leaves, and nothing else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { fillGaps, listPictures, pictureFor } from '../pipeline/src/render/pictures.js';

async function tmpdir(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pictures-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const base = (name) => (name === null ? null : path.basename(name));

test('a filename matches a query that contains all of its words', async () => {
  const files = ['/p/venus.jpg', '/p/mars.jpg'];
  assert.equal(base(pictureFor('venus surface radar', files)), 'venus.jpg');
});

test('the more specific filename wins', async () => {
  const files = ['/p/venus.jpg', '/p/venus-surface.jpg'];
  assert.equal(base(pictureFor('venus surface radar', files)), 'venus-surface.jpg');
});

// The failure that would put the wrong picture on a live post: a filename that
// shares one word with the query but means something else entirely.
test('sharing one word is not a match', async () => {
  const files = ['/p/solar-flare.jpg'];
  assert.equal(pictureFor('solar panel rooftop', files), null);
  assert.equal(base(pictureFor('solar flare eruption', files)), 'solar-flare.jpg');
});

test('default is never matched by name', async () => {
  assert.equal(pictureFor('default settings screen', ['/p/default.jpg']), null);
});

test('only real image files, and never an empty one', async () => {
  const dir = await tmpdir({ 'venus.jpg': 'x', 'notes.txt': 'x', 'empty.png': '' });
  assert.deepEqual((await listPictures(dir)).map(base), ['venus.jpg']);
});

test('a missing folder is not an error', async () => {
  assert.deepEqual(await listPictures('/definitely/not/a/directory'), []);
});

const spec = () => ({
  slides: [
    { query: 'venus planet globe', background: '/searched/01.jpg' },
    { query: 'quantum computer chip' },
    { query: 'something nobody drew' },
  ],
});

test('a slide that found a photo keeps it', async () => {
  const dir = await tmpdir({ 'venus.jpg': 'x' });
  const { spec: after } = await fillGaps(spec(), { dir });
  assert.equal(after.slides[0].background, '/searched/01.jpg');
});

test('a slide the search missed gets the hand-supplied picture', async () => {
  const dir = await tmpdir({ 'quantum-computer.jpg': 'x' });
  const { spec: after, filled } = await fillGaps(spec(), { dir });
  assert.equal(filled, 1);
  assert.equal(base(after.slides[1].background), 'quantum-computer.jpg');
  assert.equal(after.slides[2].background, undefined);   // still a gradient
});

test('default fills what no topic matched', async () => {
  const dir = await tmpdir({ 'quantum-computer.jpg': 'x', 'default.jpg': 'y' });
  const { spec: after, filled } = await fillGaps(spec(), { dir });
  assert.equal(filled, 2);
  assert.equal(base(after.slides[1].background), 'quantum-computer.jpg');
  assert.equal(base(after.slides[2].background), 'default.jpg');
});

// The same picture twice in one carousel reads as a bug; a gradient does not.
test('no picture is used twice in one carousel', async () => {
  const dir = await tmpdir({ 'default.jpg': 'y' });
  const { spec: after, filled } = await fillGaps(spec(), { dir });
  assert.equal(filled, 1);
  assert.equal(base(after.slides[1].background), 'default.jpg');
  assert.equal(after.slides[2].background, undefined);
});

test('an empty folder leaves the spec exactly as it was', async () => {
  const before = spec();
  const { spec: after, filled } = await fillGaps(before, { dir: await tmpdir() });
  assert.equal(filled, 0);
  assert.deepEqual(after, before);
});

// --- the account's own pictures, which are not a fallback ---

import { attachFixed } from '../pipeline/src/render/pictures.js';

const sixSlides = () => ({
  slides: [
    { query: 'milky way galaxy' },
    { query: 'venus planet globe' },
    { query: 'jupiter planet' },
    { query: 'hubble space telescope', cta: true },
  ],
});

test('cover goes on slide 1 and follow on the cta card', async () => {
  const dir = await tmpdir({ 'cover.jpg': 'x', 'follow.jpg': 'y' });
  const { spec: after, attached } = await attachFixed(sixSlides(), { dir });
  assert.equal(attached, 2);
  assert.equal(base(after.slides[0].background), 'cover.jpg');
  assert.equal(after.slides[1].background, undefined);
  assert.equal(after.slides[2].background, undefined);
  assert.equal(base(after.slides[3].background), 'follow.jpg');
});

// The follow card is found by its flag, not by being last -- a generated
// carousel is free to put it anywhere.
test('the follow card is found by its cta flag', async () => {
  const dir = await tmpdir({ 'follow.jpg': 'y' });
  const spec = { slides: [{ query: 'a' }, { query: 'b', cta: true }, { query: 'c' }] };
  const { spec: after } = await attachFixed(spec, { dir });
  assert.equal(base(after.slides[1].background), 'follow.jpg');
  assert.equal(after.slides[2].background, undefined);
});

test('with no cta flag the last slide is the follow card', async () => {
  const dir = await tmpdir({ 'follow.jpg': 'y' });
  const spec = { slides: [{ query: 'a' }, { query: 'b' }] };
  const { spec: after } = await attachFixed(spec, { dir });
  assert.equal(base(after.slides[1].background), 'follow.jpg');
});

test('no cover and no follow leaves the spec untouched', async () => {
  const before = sixSlides();
  const { spec: after, attached } = await attachFixed(before, { dir: await tmpdir({ 'venus.jpg': 'x' }) });
  assert.equal(attached, 0);
  assert.deepEqual(after, before);
});

// cover.jpg on a slide about book covers would be the embarrassing failure.
test('reserved names never match a topic', async () => {
  const files = ['/p/cover.jpg', '/p/follow.jpg', '/p/default.jpg'];
  assert.equal(pictureFor('book cover design', files), null);
  assert.equal(pictureFor('follow the money', files), null);
});
