// Market data from a keyed API, because no keyless source reaches a CI runner.
//
// Measured, not assumed — every keyless candidate was swept from inside Actions:
//
//   stooq (4 URL variants, 2 hosts)  200, and an HTML page every time
//   yahoo query1 / query2           429 Too Many Requests
//
// Yahoo rate-limits shared CI address ranges and Stooq gates its CSV behind
// something a runner does not satisfy. Neither is a bug to fix; both are the
// answer to "may this machine have the data", and the answer is no.
//
// So the daily reel needs a key. Two providers are implemented rather than one,
// because their free tiers cover Indian symbols differently and which of them
// carries NIFTY today is not something this code should have an opinion about.
// Configure whichever is easier to get; the first one with a key answers.
//
//   TWELVEDATA_API_KEY    api.twelvedata.com
//   ALPHAVANTAGE_API_KEY  www.alphavantage.co
//
// Both return the same shape as the Yahoo harvester, so nothing downstream cares
// which one answered.

import { env } from '../../../src/config.js';

const TWELVE = 'https://api.twelvedata.com/time_series';
const ALPHA = 'https://www.alphavantage.co/query';

/** Twelve Data names an index plainly; Alpha Vantage wants an exchange suffix. */
export const SYMBOLS = {
  twelvedata: { nifty: 'NIFTY 50', banknifty: 'NIFTY BANK', sensex: 'SENSEX' },
  alphavantage: { nifty: 'NSEI', banknifty: 'NSEBANK', sensex: 'BSESN' },
};

function toCandle(o, h, l, c, v, t) {
  return { t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 };
}

const usable = (d) => [d.o, d.h, d.l, d.c].every((n) => Number.isFinite(n));

async function fromTwelveData(nameOrTicker, { bars, apiKey }) {
  const symbol = SYMBOLS.twelvedata[nameOrTicker] || nameOrTicker;
  const url = `${TWELVE}?symbol=${encodeURIComponent(symbol)}&interval=1day`
    + `&outputsize=${bars}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  // Twelve Data reports failure inside a 200, so the status code is not enough.
  if (body?.status === 'error' || body?.code >= 400) {
    throw new Error(`Twelve Data: ${body?.message || `HTTP ${res.status}`}`);
  }
  if (!Array.isArray(body?.values) || !body.values.length) {
    throw new Error(`Twelve Data returned no values for ${symbol}`);
  }

  // Newest first on the wire; the chart wants oldest first.
  const candles = body.values
    .map((v) => toCandle(v.open, v.high, v.low, v.close, v.volume, Date.parse(v.datetime)))
    .filter(usable)
    .reverse();

  if (candles.length < 2) throw new Error(`Only ${candles.length} usable candles from Twelve Data`);

  return {
    symbol,
    name: body.meta?.symbol || symbol,
    currency: body.meta?.currency || 'INR',
    interval: '1d',
    candles,
    source: 'twelvedata',
    fetchedAt: new Date().toISOString(),
  };
}

async function fromAlphaVantage(nameOrTicker, { bars, apiKey }) {
  const symbol = SYMBOLS.alphavantage[nameOrTicker] || nameOrTicker;
  const url = `${ALPHA}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}`
    + `&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  // Alpha Vantage answers a throttle or an unknown symbol with HTTP 200 and a
  // prose field. Each one names a different problem, so each is reported as it is.
  const complaint = body?.Note || body?.Information || body?.['Error Message'];
  if (complaint) throw new Error(`Alpha Vantage: ${String(complaint).slice(0, 180)}`);

  const series = body?.['Time Series (Daily)'];
  if (!series) throw new Error(`Alpha Vantage returned no daily series for ${symbol}`);

  const candles = Object.entries(series)
    .map(([date, row]) => toCandle(
      row['1. open'], row['2. high'], row['3. low'], row['4. close'], row['5. volume'], Date.parse(date),
    ))
    .filter(usable)
    .sort((a, b) => a.t - b.t)
    .slice(-bars);

  if (candles.length < 2) throw new Error(`Only ${candles.length} usable candles from Alpha Vantage`);

  return {
    symbol,
    name: symbol,
    currency: 'INR',
    interval: '1d',
    candles,
    source: 'alphavantage',
    fetchedAt: new Date().toISOString(),
  };
}

export const PROVIDERS = [
  { name: 'twelvedata', key: 'TWELVEDATA_API_KEY', fetch: fromTwelveData },
  { name: 'alphavantage', key: 'ALPHAVANTAGE_API_KEY', fetch: fromAlphaVantage },
];

export function configuredProviders() {
  return PROVIDERS.filter((p) => env(p.key));
}

/**
 * Try each configured provider in turn. A provider that refuses is reported and
 * skipped, because the point of having two is that one of them answers.
 */
export async function fetchCandles(nameOrTicker, { bars = 90, onAttempt } = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    throw new Error(
      'No market data key. Set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY — no keyless '
      + 'source (Yahoo, Stooq) is reachable from a CI runner.',
    );
  }

  const refusals = [];
  for (const provider of providers) {
    try {
      onAttempt?.(provider.name);
      return await provider.fetch(nameOrTicker, { bars, apiKey: env(provider.key) });
    } catch (err) {
      refusals.push(`${provider.name}: ${err.message}`);
    }
  }

  throw new Error(`Every market data provider refused — ${refusals.join(' | ')}`);
}
