// "Har bar new topic" is enforced here or nowhere. A model handed five similar
// days of numbers will find the same story in them five times.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooSimilar, findRepeat } from '../pipeline/src/script/topics.js';

test('near-equal topics count as repeats', () => {
  assert.ok(tooSimilar('HDFC Bank Q2 results', 'Q2 results of HDFC Bank'));
  assert.ok(tooSimilar('RBI repo rate cut', 'RBI policy repo rate decision'));
});

test('a topic wrapped in extra words is still the same topic', () => {
  // Jaccard scores this 0.43 and lets it through; containment is what catches it.
  assert.ok(tooSimilar('SIP inflows record high', 'Mutual fund SIP inflows hit record'));
  assert.ok(tooSimilar('HDFC Bank Q2 results', 'HDFC Bank Q2 results aur margin guidance'));
});

test('genuinely different subjects are not repeats', () => {
  assert.ok(!tooSimilar('FII selling in Indian equities', 'AI stocks rally in Nasdaq'));
  assert.ok(!tooSimilar('Gold ETF demand', 'Silver import duty'));
  // Both are "index makes a new high", but they are different indices.
  assert.ok(!tooSimilar('Nifty ka naya high', 'Sensex ka naya record'));
});

test('the ledger is searched, not just the latest entry', () => {
  const history = [
    { date: '2026-08-18', topic: 'Solar capex cycle' },
    { date: '2026-08-19', topic: 'FII selling pressure on banks' },
    { date: '2026-08-20', topic: 'Gold ETF demand' },
  ];
  assert.equal(findRepeat('Banks under FII selling pressure', history)?.date, '2026-08-19');
  assert.equal(findRepeat('Semiconductor fab subsidy', history), null);
});
