// A hand-made cover beats a searched one, and a missing folder changes nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { attachCover, coverFor } from '../pipeline/src/render/covers.js';

async function tmpdir(files = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'covers-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), body);
  }
  return dir;
}

const spec = (first = {}) => ({
  slides: [{ query: 'venus', ...first }, { query: 'jupiter' }, { query: 'mars' }],
});

test('the category file wins over the slot file and the default', async () => {
  const dir = await tmpdir({ 'space.jpg': 'a', 'morning.jpg': 'b', 'default.jpg': 'c' });
  assert.equal(path.basename(await coverFor({ category: 'space', slot: 'morning', dir })), 'space.jpg');
});

test('the slot file is used when the category has none', async () => {
  const dir = await tmpdir({ 'midday.png': 'a', 'default.jpg': 'c' });
  assert.equal(path.basename(await coverFor({ category: null, slot: 'midday', dir })), 'midday.png');
});

test('default is the last resort, not the first', async () => {
  const dir = await tmpdir({ 'default.webp': 'c' });
  assert.equal(path.basename(await coverFor({ category: 'animals', slot: 'evening', dir })), 'default.webp');
});

// The failure that would matter: an empty or absent folder must leave the spec
// exactly as it was, so the searched photos still run.
test('no folder, no change', async () => {
  const before = spec();
  const { spec: after, cover } = await attachCover(before, {
    category: 'space', slot: 'morning', dir: '/definitely/not/a/directory',
  });
  assert.equal(cover, null);
  assert.deepEqual(after, before);
});

test('an empty file is not a cover', async () => {
  const dir = await tmpdir({ 'space.jpg': '' });
  assert.equal(await coverFor({ category: 'space', slot: 'morning', dir }), null);
});

test('only slide 1 gets the cover', async () => {
  const dir = await tmpdir({ 'space.jpg': 'a' });
  const { spec: after } = await attachCover(spec(), { category: 'space', slot: 'morning', dir });
  assert.equal(path.basename(after.slides[0].background), 'space.jpg');
  assert.equal(after.slides[1].background, undefined);
  assert.equal(after.slides[2].background, undefined);
});

test('a slide that already has a picture keeps it', async () => {
  const dir = await tmpdir({ 'space.jpg': 'a' });
  const { spec: after, cover } = await attachCover(spec({ background: '/already/there.jpg' }), {
    category: 'space', slot: 'morning', dir,
  });
  assert.equal(cover, null);
  assert.equal(after.slides[0].background, '/already/there.jpg');
});
