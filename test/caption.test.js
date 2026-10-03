// The caption that went out on the live post carried the same ten hashtags
// twice: the model wrote a row of them at the end of its caption, and the build
// appended the hashtags field underneath.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { composeCaption, reflowHook } from '../pipeline/build-carousel.js';
import { BROKER_CTA } from '../pipeline/src/publish/cta.js';

const CTA_RE = new RegExp(BROKER_CTA.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

test('hashtags the model wrote into the caption are not printed twice', () => {
  const caption = composeCaption({
    caption: 'क्या आप जानते हैं? 🐢\n\nजानवरों की दुनिया.\n\n#विज्ञान #जानवर #turtle',
    hashtags: ['#विज्ञान', '#जानवर', '#turtle', '#animals'],
  }, '#factvizer');

  assert.equal(caption.match(/#विज्ञान/g).length, 1);
  assert.equal(caption, [
    'क्या आप जानते हैं? 🐢',
    '',
    'जानवरों की दुनिया.',
    '',
    'Save karo, share karo, comment mein apna sawal likho.',
    '',
    '#विज्ञान #जानवर #turtle #animals #factvizer',
    '',
    BROKER_CTA,
  ].join('\n'));
});

// Instagram treats these as one tag. A reader sees two.
test('the same tag in two cases is one tag', () => {
  const caption = composeCaption({ caption: 'text', hashtags: ['#Venus', '#venus'] }, '#factvizer');
  assert.equal(caption, `text\n\nSave karo, share karo, comment mein apna sawal likho.\n\n#Venus #factvizer\n\n${BROKER_CTA}`);
});

test('the brand tag is always there, exactly once', () => {
  assert.match(composeCaption({ caption: 'text', hashtags: [] }, '#factvizer'), /#factvizer\n\n.*link in bio\.$/);
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

test('a caption drops referral links and keeps at most five tags', () => {
  const caption = composeCaption({
    caption: [
      'ROCE गिर रहा है।',
      '',
      'यह referral link है। इनमें से किसी link से account खोलने पर हमें referral benefit मिल सकता है।',
      'Zerodha: https://zerodha.com/open-account?c=KU3466',
      'Upstox: https://upstox.onelink.me/0H1s/3T23',
      'INDmoney: https://indmoney.onelink.me/RmHC/615z6rm1',
      'Delta Exchange: https://www.delta.exchange/?code=TPBYQA',
    ].join('\n'),
    hashtags: ['#roce', '#stocks', '#nifty', '#investing', '#trading', '#extra', '#sixth'],
  });

  assert.match(caption, /^ROCE गिर रहा है।/);
  assert.match(caption, /Save karo, share karo, comment mein apna sawal likho\./);
  assert.equal((caption.match(CTA_RE) || []).length, 1);
  assert.equal(caption.includes('http'), false);
  assert.equal(caption.includes('Zerodha'), false);
  assert.equal(caption.includes('#stocks'), false);
  assert.equal(caption.includes('#investing'), false);
  assert.equal(caption.includes('#trading'), false);
  assert.match(caption, /#roce/);
  assert.ok((caption.match(/#/g) || []).length <= 5);
});

test('a model save/follow line is not printed again, and broad tags are dropped', () => {
  const caption = composeCaption({
    caption: [
      'Revenue बढ़ रहा है लेकिन margin गिर रहा है? यही सबसे बड़ा red flag हो सकता है।',
      '',
      'Operating Margin, ROCE और Operating Cash Flow को साथ पढ़ना सीखें — सिर्फ revenue growth देखना काफी नहीं है।',
      '',
      'सेव करें और ऐसे finance insights के लिए फॉलो करें।',
    ].join('\n'),
    hashtags: ['#stockmarket', '#nifty', '#investing', '#शेयरबाजार', '#finance'],
  });

  assert.equal(caption.includes('सेव करें'), false);
  assert.equal(caption.includes('फॉलो करें'), false);
  assert.equal((caption.match(/Save karo, share karo, comment mein apna sawal likho\./g) || []).length, 1);
  assert.equal((caption.match(CTA_RE) || []).length, 1);
  assert.equal(caption.includes('#stockmarket'), false);
  assert.equal(caption.includes('#finance'), false);
  assert.equal(caption.includes('#investing'), false);
  assert.match(caption, /#nifty/);
  assert.match(caption, /#शेयरबाजार/);
  assert.match(caption, /#roce/);
  assert.match(caption, /#cashflow/);
  assert.ok((caption.match(/#/g) || []).length <= 5);
  assert.match(caption, /^Revenue बढ़ रहा है/);
});

test('the model view line is not printed beside the standard save/share/comment CTA', () => {
  const model = 'Aapka view kya hai? Save, share, aur comment karein.';
  const caption = composeCaption({
    caption: `NIFTYBEES ne ek pattern banaya.\n\n${model}`,
    hashtags: ['#nifty50'],
  });

  assert.equal(caption.includes(model), false);
  assert.equal(caption.includes('Aapka view kya hai'), false);
  assert.equal(caption.includes('Save, share, aur comment karein'), false);
  assert.equal((caption.match(/Save karo, share karo, comment mein apna sawal likho\./g) || []).length, 1);
  assert.match(caption, /^NIFTYBEES ne ek pattern banaya\./);
});
