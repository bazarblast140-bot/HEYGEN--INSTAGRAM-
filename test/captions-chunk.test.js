import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupWords, isParticle } from '../pipeline/src/assemble/captions.js';

function chunks(line) {
  return groupWords(line.split(/\s+/).filter(Boolean)).map((group) => (
    group.map((word) => (typeof word === 'string' ? word : word.word)).join(' ')
  ));
}

function assertPhraseChunks(line) {
  const parts = chunks(line);
  assert.equal(parts.join(' '), line);
  for (const part of parts) {
    const words = part.split(' ');
    assert.equal(isParticle(words[0]), false, `chunk starts on a particle: ${part}`);
    const meaningful = words.filter((word) => !isParticle(word));
    assert.ok(meaningful.length >= 2, `chunk has under two meaningful words: ${part}`);
  }
  return parts;
}

test('subtitle chunks keep Hindi postpositions with the noun phrase', () => {
  const line = 'Aaj NIFTYBEES girawat ke band me price ke saath band hua';
  const parts = assertPhraseChunks(line);

  for (const bad of ['ke band me', 'saath band', 'NIFTYBEES girawat ke']) {
    assert.equal(parts.includes(bad), false, bad);
  }
  for (const part of parts) {
    assert.equal(/\b(ke|ki|ka|me|mein|se|par|ko|saath|aur)$/.test(part), false, part);
  }
});

test('a particle-ending slice is not its own chunk when the phrase continues', () => {
  const parts = assertPhraseChunks('level close ke saath band hua aaj subah');
  assert.equal(parts.some((part) => part === 'saath band' || part.startsWith('saath ')), false);
  assert.equal(parts.some((part) => part.endsWith(' ke')), false);
});

test('timed word objects stay in order and do not open on a particle', () => {
  const words = 'NIFTYBEES girawat ke band me volume'.split(' ').map((word, index) => ({
    word,
    start: index,
    end: index + 1,
  }));
  const groups = groupWords(words);
  const text = groups.map((group) => group.map((item) => item.word).join(' '));
  assert.equal(text.join(' '), 'NIFTYBEES girawat ke band me volume');
  assert.equal(text.includes('ke band me'), false);
  assert.equal(text.includes('NIFTYBEES girawat ke'), false);
  assert.equal(groups[0][0].start, 0);
  assert.equal(isParticle(groups[0][0]), false);
});
