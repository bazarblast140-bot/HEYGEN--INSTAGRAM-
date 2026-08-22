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

/**
 * Each instrument is a ladder, not a symbol.
 *
 * Free tiers routinely carry equities and withhold indices — an index is the
 * product these vendors sell. So when the index is refused, the next rung is an
 * ETF that tracks it: NIFTYBEES holds the NIFTY 50 constituents, so its daily
 * shape is the index's shape, and a chart drawn from it is the same chart.
 *
 * The price is not the same number, though — NIFTYBEES trades near 280 while the
 * index sits near 26,000 — so a rung that is a proxy says so in `tracks`, and
 * keeps its own name. A reel must never print an ETF's price under an index's
 * label; that is a false statement about the market, not a display detail.
 *
 * Twelve Data names an index plainly; Alpha Vantage wants an exchange suffix and
 * only lists BSE for India, which is why the proxy rungs differ per provider.
 */
export const SYMBOLS = {
  twelvedata: {
    nifty: [
      { symbol: 'NIFTY 50', name: 'NIFTY 50' },
      { symbol: 'NIFTYBEES', exchange: 'NSE', name: 'NIFTYBEES', tracks: 'NIFTY 50' },
    ],
    banknifty: [
      { symbol: 'NIFTY BANK', name: 'NIFTY BANK' },
      { symbol: 'BANKBEES', exchange: 'NSE', name: 'BANKBEES', tracks: 'NIFTY BANK' },
    ],
    // No SENSEX ETF is listed here because none was verified. A guessed ticker
    // spends a request from a 25-a-day budget to learn nothing.
    sensex: [{ symbol: 'SENSEX', name: 'SENSEX' }],
  },
  alphavantage: {
    nifty: [
      { symbol: 'NSEI', name: 'NIFTY 50' },
      { symbol: 'NIFTYBEES.BSE', name: 'NIFTYBEES', tracks: 'NIFTY 50' },
    ],
    banknifty: [
      { symbol: 'NSEBANK', name: 'NIFTY BANK' },
      { symbol: 'BANKBEES.BSE', name: 'BANKBEES', tracks: 'NIFTY BANK' },
    ],
    sensex: [{ symbol: 'BSESN', name: 'SENSEX' }],
  },
};

/** An unlisted ticker is passed through as written, on its own, with no proxy. */
export function candidatesFor(provider, nameOrTicker) {
  return SYMBOLS[provider]?.[nameOrTicker] || [{ symbol: nameOrTicker, name: nameOrTicker }];
}

/**
 * Some refusals are about this symbol; others are about this key, today.
 * Only the first kind is worth walking the ladder for — retrying a throttle with
 * a different symbol spends another request to be told the same thing.
 */
function exhausted(err) {
  return Boolean(err?.exhausted);
}

function toCandle(o, h, l, c, v, t) {
  return { t, o: Number(o), h: Number(h), l: Number(l), c: Number(c), v: Number(v) || 0 };
}

const usable = (d) => [d.o, d.h, d.l, d.c].every((n) => Number.isFinite(n));

async function fromTwelveData(candidate, { bars, apiKey }) {
  const { symbol } = candidate;
  const url = `${TWELVE}?symbol=${encodeURIComponent(symbol)}&interval=1day`
    + (candidate.exchange ? `&exchange=${encodeURIComponent(candidate.exchange)}` : '')
    + `&outputsize=${bars}&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  // Twelve Data reports failure inside a 200, so the status code is not enough.
  if (body?.status === 'error' || body?.code >= 400) {
    const err = new Error(`Twelve Data: ${body?.message || `HTTP ${res.status}`}`);
    // 429 is the daily credit limit; 401/403 is the key itself. Neither is fixed
    // by asking for a different symbol.
    err.exhausted = [401, 403, 429].includes(body?.code);
    throw err;
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
    name: candidate.name || body.meta?.symbol || symbol,
    tracks: candidate.tracks || null,
    currency: body.meta?.currency || 'INR',
    interval: '1d',
    candles,
    source: 'twelvedata',
    fetchedAt: new Date().toISOString(),
  };
}

async function fromAlphaVantage(candidate, { bars, apiKey }) {
  const { symbol } = candidate;
  const url = `${ALPHA}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}`
    + `&outputsize=compact&apikey=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await res.json().catch(() => null);

  // Alpha Vantage answers a throttle or an unknown symbol with HTTP 200 and a
  // prose field. Each one names a different problem, so each is reported as it is.
  //
  // The distinction matters to the ladder below: Note and Information are the
  // day's 25 requests being spent, or an endpoint the free tier does not sell.
  // Error Message is this symbol being wrong, which the next rung may fix.
  const spent = body?.Note || body?.Information;
  const complaint = spent || body?.['Error Message'];
  if (complaint) {
    throw Object.assign(
      new Error(`Alpha Vantage: ${String(complaint).slice(0, 180)}`),
      { exhausted: Boolean(spent) },
    );
  }

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
    name: candidate.name || symbol,
    tracks: candidate.tracks || null,
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
 * Try each configured provider in turn, and within a provider each rung of the
 * symbol ladder. A provider that refuses is reported and skipped, because the
 * point of having two is that one of them answers.
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
    for (const candidate of candidatesFor(provider.name, nameOrTicker)) {
      try {
        onAttempt?.(`${provider.name} ${candidate.symbol}`);
        return await provider.fetch(candidate, { bars, apiKey: env(provider.key) });
      } catch (err) {
        refusals.push(`${provider.name}/${candidate.symbol}: ${err.message}`);
        if (exhausted(err)) break;
      }
    }
  }

  throw new Error(`Every market data provider refused — ${refusals.join(' | ')}`);
}
