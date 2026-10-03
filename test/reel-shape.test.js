import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { checkReelShape, durationNote } from '../pipeline/src/script/generate.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/script/prompt.js';
import { reelContainerParams } from '../pipeline/src/publish/instagram.js';
import { shapeCaption } from '../pipeline/src/publish/caption.js';

test('a reel that opens with a greeting is rejected', () => {
  const problems = checkReelShape({
    topic: 'nifty volume',
    segments: [{ type: 'hook', say: 'Namaste, main Rajesh. Aaj teen baatein.', caption: 'Namaste, main Rajesh' }],
  });
  assert.ok(problems.some((p) => /Namaste|main Rajesh/i.test(p)));
});

test('spoken length is aimed at 20 to 30 seconds', () => {
  const problems = checkReelShape({
    topic: 'nifty volume',
    segments: [{ type: 'hook', say: 'ek do teen', caption: 'teen baatein' }],
  });
  assert.ok(problems.some((p) => /56–78/.test(p)));
  assert.ok(problems.some((p) => /do not add filler/.test(p)));
});

test('duration outside 20 to 30 seconds is a note', () => {
  assert.equal(durationNote(25), null);
  assert.match(durationNote(15), /20–30/);
  assert.match(durationNote(40), /20–30/);
});

test('the prompt asks for a text hook and five tags', () => {
  const text = buildUserPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' });
  assert.match(text, /20 and 28 seconds/);
  assert.match(text, /56 to 78 words/);
  assert.match(text, /full-frame text card/);
  assert.match(text, /at most 5/);
  assert.match(text, /Do not open with "Namaste"/);
});

test('the prompt requires one saveable lesson and a curiosity hook', () => {
  assert.match(SYSTEM, /one concrete, saveable lesson/);
  assert.match(SYSTEM, /common mistake/);
  assert.match(SYSTEM, /A data recap is not a reel/);
  assert.match(SYSTEM, /first two seconds/);
  const text = buildUserPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' });
  assert.match(text, /Teach one saveable lesson/);
  assert.match(text, /curiosity hook for the first two seconds/);
  assert.match(text, /not a recap of the close, the percent, and the day low/);
  assert.match(text, /Do not open by reading out the percent, the close, and the low/);
});

test('an ETF standing in for the index is not mixed with the index percent', () => {
  const text = buildUserPrompt({
    market: { name: 'NIFTYBEES', tracks: 'NIFTY 50', change: '-0.42%', close: 258.45 },
    news: [],
    date: '2026-10-01',
  });
  assert.match(text, /The percentage\s+change belongs to NIFTY 50/);
  assert.match(text, /The rupee level belongs to NIFTYBEES/);
  assert.match(text, /Do not mix them in the same claim/);
  assert.match(text, /Never say the index fell to the E T F's\s+price/);
  assert.match(text, /never quote both the index percent and the E T F level/);
});

test('checked-in reel specs do not open with a greeting', async () => {
  for (const file of ['pipeline/specs/default.json', 'pipeline/specs/sip.json']) {
    const spec = JSON.parse(await readFile(file, 'utf8'));
    const opening = `${spec.segments[0].say} ${spec.segments[0].caption}`;
    assert.equal(/namaste|main rajesh/i.test(opening), false, file);
    assert.ok(spec.hashtags.length <= 5, file);
  }
});

test('the first frame is a card and a cover image is extracted', async () => {
  const text = await readFile(new URL('../pipeline/build-reel.js', import.meta.url), 'utf8');
  assert.match(text, /i === 0 && segment\.type === 'hook'/);
  assert.match(text, /scene: 'card\.html'/);
  assert.match(text, /reel-cover\.jpg/);
  const workflow = await readFile(new URL('../.github/workflows/build-reel.yml', import.meta.url), 'utf8');
  assert.match(workflow, /cron: '17 16 \* \* \*'/);
  assert.match(workflow, /--cover/);
});

test('a cover url is sent only when one was provided', () => {
  const bare = reelContainerParams({ videoUrl: 'https://example.com/reel.mp4', caption: 'hook' });
  assert.equal(bare.media_type, 'REELS');
  assert.equal('cover_url' in bare, false);
  const covered = reelContainerParams({
    videoUrl: 'https://example.com/reel.mp4',
    coverUrl: 'https://example.com/cover.jpg',
  });
  assert.equal(covered.cover_url, 'https://example.com/cover.jpg');
});

test('a reel caption ends with a prompt and five tags', () => {
  const caption = shapeCaption({
    caption: 'Nifty flat band.\n\nVolume pichhle hafte se zyada hai.',
    hashtags: ['#nifty', '#nse', '#banknifty', '#intraday', '#fii', '#sensex'],
  });
  assert.match(caption, /^Nifty flat band\./);
  assert.match(caption, /Save karo, share karo, comment mein apna sawal likho\./);
  assert.match(caption, /link in bio\.$/);
  assert.equal((caption.match(/#/g) || []).length, 5);
});
