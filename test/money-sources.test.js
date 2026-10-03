// Money slides carry no source label nothing verified (was: a dated source).
//
// The first real evening post cited "भारतीय रिज़र्व बैंक (RBI), ऐतिहासिक आँकड़े"
// under a figure for 1991. Nobody can check that. The same post's best slide
// cited "RBI, साप्ताहिक सांख्यिकीय पूरक, सितंबर 2025", which anyone can.
//
// And the rule that this project has broken three times: a check on how a post
// is worded must never be the reason there is no post. So this one is advisory
// — proven here by where it is wired, not by intention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkMoneySources, isMoney } from '../pipeline/src/carousel/money.js';
import { softProblems, validateShape } from '../pipeline/src/carousel/generate.js';
import { FINANCE, POOL } from '../pipeline/src/carousel/categories.js';

const slide = (over = {}) => ({ band: 'bottom', headline: 'शीर्षक', subline: 'आँकड़ा', source: null, cta: false, ...over });

const spec = (category, slides) => ({ category, topic: 'विषय', slides });

test('it applies to the money pool and to nothing else', () => {
  for (const c of FINANCE) assert.equal(isMoney(c), true, `${c} should be money`);
  for (const c of ['ai-news', 'latest-news', 'space']) {
    assert.equal(isMoney(c), false, `${c} should not be money`);
  }
  assert.equal(POOL.some((c) => !FINANCE.includes(c)), false);
});

test('a dated label is no longer asked for: an unverified source label on a money slide is refused', () => {
  const problems = checkMoneySources(spec('fundamentals', [
    slide({ band: 'center', subline: null, source: null }),
    slide({ source: 'SBI होम लोन EMI कैलकुलेटर 2025' }),
  ]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /slide 2/);
  assert.match(problems[0], /nothing in the pipeline verified/);
});

test('no label, or the literal calculation note, passes', () => {
  const calc = { type: 'emi', principal: 5000000, rate: 8.5, years: 20 };
  const problems = checkMoneySources(spec('personal-finance', [
    slide({ source: null }),
    slide({ calc, source: 'Calculation: standard EMI formula (monthly reducing balance)' }),
  ]));
  assert.deepEqual(problems, []);
});

test('the cover and the follow card are asked for nothing', () => {
  const problems = checkMoneySources(spec('fundamentals', [
    slide({ band: 'center', subline: null, source: null }),
    slide({ cta: true, subline: 'और अपडेट के लिए', source: null }),
  ]));
  assert.deepEqual(problems, []);
});

test('a science post is left alone', () => {
  const problems = checkMoneySources(spec('space', [slide({ source: 'NASA' })]));
  assert.deepEqual(problems, []);
});

test('softProblems carries it to the model; validateShape does not', () => {
  const bad = spec('fundamentals', [slide({ source: 'RBI, 2025' })]);
  assert.equal(softProblems(bad).some((p) => /nothing in the pipeline verified/.test(p)), true);
  assert.equal(validateShape(bad, []).some((p) => /verified/.test(p)), false);
});
