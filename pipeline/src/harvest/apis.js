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

/**
 * Alpha Vantage's free tier meters two different ways and says so in the same
 * field, which is how a ladder can defeat itself: the second rung fired inside
 * the same second as the first and was refused for pacing, so the E T F was
 * never actually tested.
 *
 *   "1 request per second" / "spreading out"   slow down, then ask again
 *   "25 requests per day"                      the day is spent, stop asking
 *
 * The first is a wait; the second is a wall. Treating them alike either burns
 * the daily allowance on retries or abandons a key that would have answered a
 * second later.
 */
function throttleKind(message) {
  const m = String(message);
  if (/per day|daily (rate )?limit/i.test(m)) return 'daily';
  if (/per second|spreading out/i.test(m)) return 'pace';
  return null;
}

const PACE_MS = 1300;
const sleep = (ms) => (ms > 0 ? new Promise((resolve) => { setTimeout(resolve, ms); }) : Promise.resolve());

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
    // 401/403 is the key itself and 429 is usually the daily credit limit —
    // neither is fixed by asking for a different symbol. A 429 that names a
    // per-second rate is the exception: that one is fixed by waiting.
    err.paced = body?.code === 429 && throttleKind(body?.message) === 'pace';
    err.exhausted = [401, 403, 429].includes(body?.code) && !err.paced;
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
  // The distinction matters to the ladder below. Error Message is this symbol
  // being wrong, which the next rung may fix. Note and Information cover both
  // meters — the day's 25 requests being spent, and the one-per-second pacing
  // rule — so which of the two it is decides whether to stop or to wait.
  const metered = body?.Note || body?.Information;
  const complaint = metered || body?.['Error Message'];
  if (complaint) {
    const kind = metered ? throttleKind(metered) : null;
    throw Object.assign(
      new Error(`Alpha Vantage: ${String(complaint).slice(0, 180)}`),
      // A pacing refusal is neither: it is the same request, asked too soon.
      { exhausted: Boolean(metered) && kind !== 'pace', paced: kind === 'pace' },
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

async function fetchWithPacing(provider, candidate, opts, paceMs) {
  try {
    return await provider.fetch(candidate, opts);
  } catch (err) {
    if (!err.paced) throw err;
    // The vendor asked for slower, not for less. One wait and one retry is the
    // whole remedy; a second refusal is something other than pacing.
    await sleep(paceMs);
    return provider.fetch(candidate, opts);
  }
}

/**
 * Try each configured provider in turn, and within a provider each rung of the
 * symbol ladder. A provider that refuses is reported and skipped, because the
 * point of having two is that one of them answers.
 */
export async function fetchCandles(nameOrTicker, { bars = 90, onAttempt, paceMs = PACE_MS } = {}) {
  const providers = configuredProviders();
  if (!providers.length) {
    throw new Error(
      'No market data key. Set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY — no keyless '
      + 'source (Yahoo, Stooq) is reachable from a CI runner.',
    );
  }

  const refusals = [];
  let asked = false;
  for (const provider of providers) {
    for (const candidate of candidatesFor(provider.name, nameOrTicker)) {
      // Rungs are spaced, not fired together. Alpha Vantage allows one request
      // per second, so a ladder walked at full speed refuses its own second rung
      // for pacing and reports it as though the symbol were wrong.
      if (asked) await sleep(paceMs);
      asked = true;

      try {
        onAttempt?.(`${provider.name} ${candidate.symbol}`);
        return await fetchWithPacing(provider, candidate, { bars, apiKey: env(provider.key) }, paceMs);
      } catch (err) {
        refusals.push(`${provider.name}/${candidate.symbol}: ${err.message}`);
        if (exhausted(err)) break;
      }
    }
  }

  throw new Error(`Every market data provider refused — ${refusals.join(' | ')}`);
}
