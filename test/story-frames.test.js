// What the story shows, and what it must not lose showing it.
//
// The first story this account posted was the cover slide alone: a question,
// no answer, no sign that anything followed it. Nothing there stops a thumb,
// and Instagram's API cannot attach a link, poll or any other sticker to a
// story published this way, so there is no tappable route to the post either.
// Words are the only route, which makes it worth being careful about them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { storyFrames, bestFact } from '../pipeline/src/carousel/story.js';

// A spec as it reaches the renderer: footnotes already filled in from sources.
const spec = {
  slides: [
    { band: 'center', headline: 'सवाल?', footnote: '', cta: false },
    { headline: 'भंडार', subline: 'सितंबर 2025 में 700 अरब डॉलर के पार', footnote: 'RBI, सितंबर 2025' },
    { headline: 'बचाव', subline: 'यह रुपये को गिरने से बचाता है', footnote: 'RBI, 2025' },
    { headline: 'फ़ॉलो', subline: 'और अपडेट के लिए', footnote: '', cta: true },
  ],
};

test('the frame after the cover is the most concrete fact, not the first one', () => {
  // "700 अरब डॉलर" says something standing alone; "रुपये को गिरने से बचाता है"
  // does not. A story frame has to work with no carousel behind it.
  assert.equal(bestFact(spec.slides), 1);
});

test('the source survives onto the story', () => {
  // The call to action used to be written over the footnote, and the footnote
  // IS the source line -- so a money slide went out claiming an RBI figure with
  // no citation, which is exactly what money.js exists to prevent.
  const [, fact] = storyFrames(spec);
  assert.equal(fact.footnote, 'RBI, सितंबर 2025');
  assert.equal(fact.callout, 'पूरी पोस्ट प्रोफ़ाइल पर');
});

test('the cover says how many slides are waiting', () => {
  const [cover] = storyFrames(spec);
  assert.match(cover.callout, /4 स्लाइड/);
  assert.match(cover.callout, /पूरी पोस्ट/);
});

test('the follow card is never the fact frame', () => {
  const frames = storyFrames(spec);
  assert.equal(frames.length, 2);
  assert.equal(frames.some((f) => f.cta), false);
});

test('a post with no fact slide still gets its cover', () => {
  const frames = storyFrames({ slides: [{ band: 'center', headline: 'सवाल?' }] });
  assert.equal(frames.length, 1);
  assert.match(frames[0].callout, /पूरी पोस्ट/);
});

test('an empty spec asks for no story rather than throwing', () => {
  assert.deepEqual(storyFrames({}), []);
  assert.deepEqual(storyFrames({ slides: [] }), []);
});

// The scene reads `callout` out of its load() argument. It renders inside a
// browser, where every element with an id is also a global — so if the name is
// missing from the destructuring, `callout` silently resolves to the <div> and
// the frame goes out reading "[object HTMLDivElement]". It did.
test('the scene destructures callout instead of finding the element', () => {
  const scene = fs.readFileSync('pipeline/src/render/scenes/slide.html', 'utf8');
  const load = scene.slice(scene.indexOf('load(data) {'), scene.indexOf('} = data;'));
  assert.match(load, /^\s*callout = '',/m, 'callout is not destructured in load()');
});
