// Neither market provider is reachable from a dev container, and both report
// failure inside an HTTP 200 — which is exactly how a wrong chart reaches a
// posted reel without anything looking broken. So both are covered here.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MODULE = '../pipeline/src/harvest/apis.js';

/**
 * Load the module fresh with one provider configured and one canned response.
 * `payload` may be a function of the requested URL, for tests where the answer
 * depends on which symbol was asked for.
 */
async function withProvider(env, payload, { onAttempt } = {}) {
  for (const k of ['TWELVEDATA_API_KEY', 'ALPHAVANTAGE_API_KEY']) delete process.env[k];
  Object.assign(process.env, env);
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (typeof payload === 'function' ? payload(String(url)) : payload),
  });
  const mod = await import(`${MODULE}?v=${Math.random()}`);
  return mod.fetchCandles('nifty', { bars: 90, onAttempt });
}

const TWELVE = {
  meta: { symbol: 'NIFTY 50', currency: 'INR' },
  status: 'ok',
  // Newest first, which is how Twelve Data sends it.
  values: [
    { datetime: '2026-08-21', open: '25900', high: '26010', low: '25880', close: '25990', volume: '0' },
    { datetime: '2026-08-20', open: '25800', high: '25950', low: '25790', close: '25900', volume: '0' },
    { datetime: '2026-08-19', open: '25700', high: '25820', low: '25690', close: '25800', volume: '0' },
  ],
};

// Deliberately out of order: Alpha Vantage keys an object by date, and object
// key order is not a promise anyone made.
const ALPHA = {
  'Time Series (Daily)': {
    '2026-08-21': { '1. open': '25900', '2. high': '26010', '3. low': '25880', '4. close': '25990', '5. volume': '12' },
    '2026-08-19': { '1. open': '25700', '2. high': '25820', '3. low': '25690', '4. close': '25800', '5. volume': '10' },
    '2026-08-20': { '1. open': '25800', '2. high': '25950', '3. low': '25790', '4. close': '25900', '5. volume': '11' },
  },
};

const oldestFirst = (candles) => candles.every((c, i, a) => i === 0 || a[i - 1].t <= c.t);

test('twelve data parses, and reverses to oldest-first', async () => {
  const series = await withProvider({ TWELVEDATA_API_KEY: 'k' }, TWELVE);
  assert.equal(series.source, 'twelvedata');
  assert.equal(series.candles.length, 3);
  assert.ok(oldestFirst(series.candles), 'the chart draws left to right');
  assert.equal(series.candles.at(-1).c, 25990);
});

test('alpha vantage parses, and sorts by date rather than trusting key order', async () => {
  const series = await withProvider({ ALPHAVANTAGE_API_KEY: 'k' }, ALPHA);
  assert.equal(series.source, 'alphavantage');
  assert.ok(oldestFirst(series.candles), 'object key order is not chronological');
  assert.equal(series.candles.at(-1).c, 25990);
});

// Each of these arrives as HTTP 200 with a normal-looking body.
for (const [label, env, payload, expected] of [
  ['twelve data reports an error in a 200', { TWELVEDATA_API_KEY: 'k' },
    { status: 'error', code: 400, message: 'symbol not found' }, /symbol not found/],
  ['alpha vantage reports a throttle in a 200', { ALPHAVANTAGE_API_KEY: 'k' },
    { Note: 'Our standard API rate limit is 25 requests per day' }, /rate limit/],
  ['alpha vantage reports a bad symbol in a 200', { ALPHAVANTAGE_API_KEY: 'k' },
    { 'Error Message': 'Invalid API call.' }, /Invalid API call/],
]) {
  test(label, async () => {
    await assert.rejects(() => withProvider(env, payload), expected);
  });
}

test('no key names the variable to set', async () => {
  await assert.rejects(() => withProvider({}, {}), /TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY/);
});

// The ladder. A free tier that withholds the index but sells the E T F tracking
// it is the ordinary case, not the exotic one -- an index is the product these
// vendors are selling.
test('falls back to the E T F when the index symbol is refused', async () => {
  const tried = [];
  const series = await withProvider(
    { ALPHAVANTAGE_API_KEY: 'k' },
    (url) => (url.includes('NSEI') ? { 'Error Message': 'Invalid API call.' } : ALPHA),
    { onAttempt: (label) => tried.push(label) },
  );

  assert.deepEqual(tried, ['alphavantage NSEI', 'alphavantage NIFTYBEES.BSE']);
  assert.equal(series.symbol, 'NIFTYBEES.BSE');
  // The name is the E T F's own, and the relationship is stated rather than
  // silently collapsed. A reel that prints an E T F price under an index label
  // is making a false claim about the market.
  assert.equal(series.name, 'NIFTYBEES');
  assert.equal(series.tracks, 'NIFTY 50');
});

test('an index that answers never reaches the E T F rung', async () => {
  const tried = [];
  const series = await withProvider({ ALPHAVANTAGE_API_KEY: 'k' }, ALPHA,
    { onAttempt: (label) => tried.push(label) });

  assert.deepEqual(tried, ['alphavantage NSEI']);
  assert.equal(series.name, 'NIFTY 50');
  assert.equal(series.tracks, null, 'the index is not a proxy for itself');
});

// A throttle is about the key, not the symbol. Walking the ladder through one
// spends another of the day's 25 requests to be told the same thing.
test('a spent daily allowance stops the ladder instead of walking it', async () => {
  const tried = [];
  await assert.rejects(() => withProvider(
    { ALPHAVANTAGE_API_KEY: 'k' },
    { Note: 'Our standard API rate limit is 25 requests per day' },
    { onAttempt: (label) => tried.push(label) },
  ), /rate limit/);

  assert.deepEqual(tried, ['alphavantage NSEI'], 'one request, not two');
});

test('twelve data stops the ladder on a credit limit too', async () => {
  const tried = [];
  await assert.rejects(() => withProvider(
    { TWELVEDATA_API_KEY: 'k' },
    { status: 'error', code: 429, message: 'You have run out of API credits' },
    { onAttempt: (label) => tried.push(label) },
  ), /API credits/);

  assert.deepEqual(tried, ['twelvedata NIFTY 50']);
});

test('an unknown ticker is tried as written, with no invented proxy', async () => {
  const { candidatesFor } = await import(`${MODULE}?v=${Math.random()}`);
  assert.deepEqual(candidatesFor('alphavantage', 'TATAMOTORS.BSE'),
    [{ symbol: 'TATAMOTORS.BSE', name: 'TATAMOTORS.BSE' }]);
});
