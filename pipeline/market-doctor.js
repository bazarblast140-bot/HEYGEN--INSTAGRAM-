#!/usr/bin/env node
// Which market-data source actually answers from a CI runner?
//
// Both current sources fail there, for different reasons, and neither failure is
// fixable by trying harder:
//
//   Yahoo  429s. It already sends a browser User-Agent and already rotates
//          between query1 and query2, so this is the shared CI address range
//          being rate-limited, not a header problem.
//   Stooq  returned HTML where CSV was expected.
//
// The Stooq failure is the promising one, because the likely cause is a detail
// rather than a policy: the symbol for an index starts with a caret, and the
// request encodes it as %5E. So this tries the variants side by side and prints
// what each returns, the same way the text-to-speech sweep found /v1/tts.generate
// after eight wrong guesses.
//
//   node pipeline/market-doctor.js

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

const CANDIDATES = [
  // The caret, left alone. This is the hypothesis.
  ['stooq raw caret',     'https://stooq.com/q/d/l/?s=^nsei&i=d'],
  ['stooq encoded caret', 'https://stooq.com/q/d/l/?s=%5Ensei&i=d'],
  ['stooq .pl raw',       'https://stooq.pl/q/d/l/?s=^nsei&i=d'],
  // The quote endpoint returns one row rather than a history, which is still
  // enough to say the market moved -- the chart could fall back to a shorter series.
  ['stooq quote',         'https://stooq.com/q/l/?s=^nsei&f=sd2t2ohlcv&h&e=csv'],
  ['stooq sensex',        'https://stooq.com/q/d/l/?s=^bsesn&i=d'],
  // Confirm Yahoo is still refusing rather than assuming yesterday's result.
  ['yahoo query1',        'https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1mo'],
  ['yahoo query2',        'https://query2.finance.yahoo.com/v8/finance/chart/%5ENSEI?interval=1d&range=1mo'],
];

function verdict(body) {
  const head = body.slice(0, 60).replace(/\s+/g, ' ');
  if (/^\s*</.test(body)) return { good: false, why: `HTML: ${head}` };
  if (/no data/i.test(body.slice(0, 200))) return { good: false, why: 'body says "No data"' };
  if (/^date,/i.test(body)) {
    const rows = body.trim().split('\n').length - 1;
    return { good: true, why: `CSV, ${rows} rows, last: ${body.trim().split('\n').pop()}` };
  }
  if (/^symbol,/i.test(body)) return { good: true, why: `CSV quote: ${body.trim().split('\n').pop()}` };
  try {
    const parsed = JSON.parse(body);
    const result = parsed?.chart?.result?.[0];
    if (result) {
      const closes = (result.indicators?.quote?.[0]?.close || []).filter((n) => n != null);
      return { good: closes.length > 1, why: `JSON, ${closes.length} closes, last ${closes.at(-1)}` };
    }
    return { good: false, why: `JSON: ${head}` };
  } catch {
    return { good: false, why: head };
  }
}

import { configuredProviders, fetchCandles } from './src/harvest/apis.js';

// A configured provider is the only one expected to work here, so it is checked
// first and reported in full: which one answered, how many candles, and the last
// close. Without that, "the key is set" and "the key returns Indian index data"
// look identical until 7am.
async function checkKeyedProviders() {
  const providers = configuredProviders();
  if (!providers.length) {
    console.log(`  ${dim('No TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY — the reel stays on sample data.')}`);
    return false;
  }

  try {
    const series = await fetchCandles('nifty', {
      onAttempt: (name) => console.log(`  ${dim(`trying ${name}`)}`),
    });
    const last = series.candles.at(-1);
    console.log(`  ${ok('WORKS')} ${series.source.padEnd(20)} ${dim(
      `${series.name}, ${series.candles.length} candles, last close ${last.c} on ${new Date(last.t).toISOString().slice(0, 10)}`,
    )}`);
    return true;
  } catch (err) {
    console.log(`  ${bad('fail ')} keyed providers      ${dim(String(err.message).slice(0, 200))}`);
    return false;
  }
}

const keyed = await checkKeyedProviders();

const winners = [];

for (const [label, url] of CANDIDATES) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,application/json,*/*' } });
    const body = await res.text();
    const { good, why } = verdict(body);
    console.log(`  ${good ? ok('WORKS') : bad(String(res.status).padEnd(5))} ${label.padEnd(20)} ${dim(why.slice(0, 110))}`);
    if (good) winners.push({ label, url });
  } catch (err) {
    console.log(`  ${bad('err  ')} ${label.padEnd(20)} ${dim(String(err.message).slice(0, 110))}`);
  }
}

if (keyed) {
  console.log(`\n${ok('A keyed provider answered — the reel can carry real numbers.')}`);
} else if (winners.length) {
  console.log(`\n${ok(`${winners.length} keyless source(s) usable from CI:`)}\n${winners.map((w) => `  ${w.label}  ${w.url}`).join('\n')}`);
} else {
  console.log(`\n${bad('No source answered with usable data.')}`);
  console.log(dim('  Set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY (either, both free).'));
  console.log(dim('  The keyless rows above are why: this is a sourcing limit, not a bug.'));
}
