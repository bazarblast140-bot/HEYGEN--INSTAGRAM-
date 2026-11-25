import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shapeCaption, ENGAGEMENT, QUESTION_ENGAGEMENT, isModelCtaLine } from '../pipeline/src/publish/caption.js';

const caption = 'Expense ratio 1% vs 0.2%: 20 साल में ₹1.25 लाख का फर्क.\n\n#mutualfunds #sip';

test('default caption close is unchanged', () => {
  const out = shapeCaption({ caption, env: {} });
  assert.ok(out.includes(ENGAGEMENT));
  assert.ok(!out.includes(QUESTION_ENGAGEMENT));
});

test('CAPTION_CTA_STYLE=question swaps in one concrete comment ask, once', () => {
  const out = shapeCaption({ caption, env: { CAPTION_CTA_STYLE: 'question' } });
  assert.equal(out.split(QUESTION_ENGAGEMENT).length - 1, 1);
  assert.ok(!out.includes(ENGAGEMENT));
  assert.ok(out.indexOf(QUESTION_ENGAGEMENT) < out.indexOf('#mutualfunds'));
});

test('a re-shaped caption does not stack the question CTA', () => {
  const env = { CAPTION_CTA_STYLE: 'question' };
  const once = shapeCaption({ caption, env });
  assert.ok(isModelCtaLine(QUESTION_ENGAGEMENT));
  const twice = shapeCaption({ caption: once, env });
  assert.equal(twice.split(QUESTION_ENGAGEMENT).length - 1, 1);
});
