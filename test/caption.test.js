// The caption that went out on the live post carried the same ten hashtags
// twice: the model wrote a row of them at the end of its caption, and the build
// appended the hashtags field underneath.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeCaption, reflowHook } from '../pipeline/build-carousel.js';

test('hashtags the model wrote into the caption are not printed twice', () => {
  const caption = composeCaption({
    caption: 'क्या आप जानते हैं? 🐢\n\nजानवरों की दुनिया.\n\n#विज्ञान #जानवर #turtle',
    hashtags: ['#विज्ञान', '#जानवर', '#turtle', '#animals'],
  }, '#factvizer');

  assert.equal(caption.match(/#विज्ञान/g).length, 1);
  assert.equal(caption, 'क्या आप जानते हैं? 🐢\n\nजानवरों की दुनिया.\n\n#विज्ञान #जानवर #turtle #animals #factvizer');
});

// Instagram treats these as one tag. A reader sees two.
test('the same tag in two cases is one tag', () => {
  const caption = composeCaption({ caption: 'text', hashtags: ['#Venus', '#venus'] }, '#factvizer');
  assert.equal(caption, 'text\n\n#Venus #factvizer');
});

test('the brand tag is always there, exactly once', () => {
  assert.match(composeCaption({ caption: 'text', hashtags: [] }, '#factvizer'), /#factvizer$/);
  const already = composeCaption({ caption: 'text\n\n#factvizer', hashtags: ['#factvizer'] }, '#factvizer');
  assert.equal(already.match(/#factvizer/g).length, 1);
});

// A hashtag inside a sentence is part of the sentence, not the tag row.
test('only a trailing row of tags is lifted out', () => {
  const caption = composeCaption({ caption: 'देखो #विज्ञान कितना अजीब है', hashtags: ['#जानवर'] }, '#factvizer');
  assert.match(caption, /^देखो #विज्ञान कितना अजीब है\n\n/);
});

// The second lost post: the model wrote its caption as one 193-character
// paragraph, the length rule rejected all three attempts, and the day had no
// post. The opening line is repaired now instead of refused.
test('a long opening line is split at its first sentence end', () => {
  const long = 'जानवरों की दुनिया में ऐसे कई अजीब तथ्य छिपे हैं जो आपको हैरान कर देंगे, और इनमें से ज़्यादातर आपने कभी सुने भी नहीं होंगे। आइए जानते हैं।';
  const [hook, second] = reflowHook(long).split('\n');

  assert.ok(hook.length <= 125, `hook is ${hook.length}`);
  assert.match(hook, /।$/);
  assert.equal(second, 'आइए जानते हैं।');
  assert.equal(`${hook} ${second}`.replace(/\s+/g, ' '), long.replace(/\s+/g, ' '));
});

test('a short opening line is left exactly as written', () => {
  const fine = 'क्या आप जानते हैं? 🐢\n\nबाक़ी बात.';
  assert.equal(reflowHook(fine), fine);
});
