// Where a beat ends, and where a word ends. Both are arithmetic over a
// synthesiser's output, both are invisible when wrong — the reel just feels
// slightly off — and neither can be checked by looking at the finished file.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignBeats } from '../pipeline/src/presenter/narration.js';
import { wordsFromCharacterAlignment } from '../pipeline/src/presenter/voice-providers.js';

// A real HeyGen response, trimmed to the spoken words. Note the gap between
// "Traders." ending at 2.7 and "Aaj" starting at 3.22: that silence is where a
// cut belongs.
const WORDS = [
  { word: 'Namaste', start: 0.199, end: 0.599 },
  { word: 'doston,', start: 0.639, end: 1.1 },
  { word: 'Rajesh', start: 1.5, end: 1.839 },
  { word: 'Technical', start: 1.899, end: 2.279 },
  { word: 'Traders.', start: 2.359, end: 2.7 },
  { word: 'Aaj', start: 3.22, end: 3.399 },
  { word: 'Nifty', start: 3.46, end: 3.74 },
  { word: 'ne', start: 3.779, end: 3.899 },
  { word: 'pachas', start: 3.959, end: 4.259 },
  { word: 'hazar', start: 4.36, end: 4.599 },
  { word: 'ka', start: 4.699, end: 4.759 },
  { word: 'level', start: 4.839, end: 5.059 },
  { word: 'tod', start: 5.139, end: 5.339 },
  { word: 'diya.', start: 5.4, end: 5.639 },
];
const BEATS = [
  'Namaste doston, Rajesh Technical Traders.',
  'Aaj Nifty ne pachas hazar ka level tod diya.',
];
const TOTAL = 5.982;

test('a beat ends in the pause, not inside the last word', () => {
  const [first, second] = alignBeats({ words: WORDS, spokenPerBeat: BEATS, totalDuration: TOTAL });

  // Word-share estimation put this at 2.136s — before "Traders." had finished.
  assert.ok(first >= 2.7, `cut at ${first}s would clip "Traders." (ends 2.7s)`);
  assert.ok(first <= 3.22, `cut at ${first}s would land after "Aaj" had started`);
  assert.ok(Math.abs(first + second - TOTAL) < 0.01, 'beats must fill the narration exactly');
});

test('alignment refuses rather than guessing when it cannot trust the timings', () => {
  assert.equal(alignBeats({ words: [], spokenPerBeat: BEATS, totalDuration: TOTAL }), null);
  // The synthesiser disagreeing wildly with the script means its indices cannot
  // mark beat boundaries; a fallback is better than a confident wrong answer.
  assert.equal(alignBeats({ words: WORDS, spokenPerBeat: ['one two three'], totalDuration: TOTAL }), null);
});

test('words are rebuilt from character alignment, not by splitting on spaces', () => {
  const text = 'Aaj  Nifty ne.'; // double space, trailing punctuation
  const chars = [...text];
  const words = wordsFromCharacterAlignment({
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => i * 0.1),
    character_end_times_seconds: chars.map((_, i) => (i + 1) * 0.1),
  });

  assert.deepEqual(words.map((w) => w.word), ['Aaj', 'Nifty', 'ne.']);
  assert.ok(Math.abs(words[0].end - 0.3) < 1e-9);
  assert.ok(Math.abs(words[1].start - 0.5) < 1e-9, 'the double space must not become a word');
});

test('malformed alignment yields no words rather than a wrong timeline', () => {
  assert.deepEqual(wordsFromCharacterAlignment(undefined), []);
  assert.deepEqual(wordsFromCharacterAlignment({
    characters: ['a', 'b'], character_start_times_seconds: [0], character_end_times_seconds: [1],
  }), []);
});
