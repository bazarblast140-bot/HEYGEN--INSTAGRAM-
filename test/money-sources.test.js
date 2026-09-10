// A money slide has to say which document its number came from.
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

const slide = (over = {}) => ({ band: 'bottom', headline: 'शीर्षक', subline: 'आँकड़ा', source: 'RBI, 2025', cta: false, ...over });

const spec = (category, slides) => ({ category, topic: 'विषय', slides });

test('it applies to the money pool and to nothing else', () => {
  for (const c of FINANCE) assert.equal(isMoney(c), true, `${c} should be money`);
  for (const c of POOL) assert.equal(isMoney(c), false, `${c} should not be money`);
});

test('a source with no year is flagged', () => {
  const problems = checkMoneySources(spec('economy', [
    slide({ band: 'center', subline: null, source: null }),
    slide({ source: 'भारतीय रिज़र्व बैंक (RBI), ऐतिहासिक आँकड़े' }),
  ]));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /slide 2/);
  assert.match(problems[0], /no year/);
});

test('a source naming its report and date passes', () => {
  const problems = checkMoneySources(spec('economy', [
    slide({ source: 'RBI, साप्ताहिक सांख्यिकीय पूरक, सितंबर 2025' }),
    slide({ source: 'विश्व बैंक, World Development Indicators 2024' }),
  ]));
  assert.deepEqual(problems, []);
});

test('the cover and the follow card are asked for nothing', () => {
  const problems = checkMoneySources(spec('markets', [
    slide({ band: 'center', subline: null, source: null }),
    slide({ cta: true, subline: 'और अपडेट के लिए', source: null }),
  ]));
  assert.deepEqual(problems, []);
});

test('a science post is left alone', () => {
  const problems = checkMoneySources(spec('space', [slide({ source: 'NASA' })]));
  assert.deepEqual(problems, []);
});

test('it is advisory: softProblems carries it, validateShape does not', () => {
  const bad = spec('economy', [slide({ source: 'RBI' })]);
  assert.equal(softProblems(bad).some((p) => /no year/.test(p)), true);
  assert.equal(validateShape(bad, []).some((p) => /no year/.test(p)), false);
});
