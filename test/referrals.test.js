import { test } from 'node:test';
import assert from 'node:assert/strict';

import { referralCaptionBlock } from '../pipeline/src/carousel/referrals.js';

test('market carousel descriptions receive disclosed referral links', () => {
  const block = referralCaptionBlock({ category: 'markets' });

  assert.match(block, /^\n\nयह referral link है।/);
  assert.match(block, /Zerodha: https:\/\/zerodha\.com\/open-account\?c=KU3466/);
  assert.match(block, /Delta Exchange: https:\/\/www\.delta\.exchange\/\?code=TPBYQA/);
  assert.doesNotMatch(block, /\\n/);
});

test('non-market topics do not receive referral links', () => {
  for (const category of ['money', 'economy', 'banking', 'tax', 'insurance', 'scams', 'space']) {
    assert.equal(referralCaptionBlock({ category }), '', category);
  }
});
