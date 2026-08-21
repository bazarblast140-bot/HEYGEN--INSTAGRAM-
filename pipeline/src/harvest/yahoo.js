// OHLC candles from Yahoo Finance's chart endpoint.
//
// No API key, no registration. It is an undocumented endpoint, so treat a shape
// change as expected rather than exceptional — every field is validated below and
// a bad payload throws instead of silently producing a wrong chart.
//
// Blocked by the network policy inside Claude Code sessions; works on GitHub
// Actions runners. Use fixtures/ for local development.

// Yahoo rate-limits shared CI address ranges hard — a GitHub runner gets a 429 on
// the first call more often than not. Both hosts serve the same data from
// different pools, so rotating across them and backing off turns a near-certain
// failure into a near-certain success.
const HOSTS = [
  'https://query1.finance.yahoo.com/v8/finance/chart',
  'https://query2.finance.yahoo.com/v8/finance/chart',
];

// Yahoo rejects requests without a browser-shaped User-Agent.
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

export const SYMBOLS = {
  nifty: '^NSEI',
  banknifty: '^NSEBANK',
  sensex: '^BSESN',
  usdinr: 'INR=X',
  crude: 'CL=F',
};

/** Resolve a friendly name ("nifty") or pass a raw Yahoo ticker ("RELIANCE.NS") through. */
export function resolveSymbol(nameOrTicker) {
  return SYMBOLS[nameOrTicker] || nameOrTicker;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchCandles(nameOrTicker, {
  interval = '1d',
  range = '3mo',
  attempts = 6,
  onRetry,
} = {}) {
  const symbol = resolveSymbol(nameOrTicker);
  const query = `${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;

  let payload;
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const url = `${HOSTS[attempt % HOSTS.length]}/${query}`;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });

      // 429 and 5xx are worth another go on the other host; a 404 is not.
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`Yahoo returned ${res.status} for ${symbol}`);
        const waitMs = Math.round(1000 * 2 ** attempt + Math.random() * 500);
        onRetry?.(attempt + 1, res.status, waitMs);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) throw new Error(`Yahoo returned ${res.status} for ${symbol}`);
      payload = await res.json();
      break;
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1) break;
      await sleep(Math.round(1000 * 2 ** attempt));
    }
  }

  if (!payload) throw lastError || new Error(`Could not reach Yahoo for ${symbol}`);
  if (payload?.chart?.error) throw new Error(`Yahoo error for ${symbol}: ${payload.chart.error.description}`);

  const result = payload?.chart?.result?.[0];
  const quote = result?.indicators?.quote?.[0];
  if (!result?.timestamp || !quote) throw new Error(`Unexpected Yahoo payload shape for ${symbol}`);

  // Yahoo emits nulls for holidays and halted sessions; drop those rows entirely
  // rather than letting a null reach the chart scale.
  const candles = result.timestamp
    .map((ts, i) => ({
      t: ts * 1000,
      o: quote.open[i],
      h: quote.high[i],
      l: quote.low[i],
      c: quote.close[i],
      v: quote.volume[i] ?? 0,
    }))
    .filter((d) => [d.o, d.h, d.l, d.c].every((n) => typeof n === 'number' && Number.isFinite(n)));

  if (candles.length < 2) throw new Error(`Only ${candles.length} usable candles for ${symbol}`);

  return {
    symbol,
    name: result.meta?.shortName || symbol,
    currency: result.meta?.currency || 'INR',
    interval,
    candles,
    source: 'yahoo-finance',
    fetchedAt: new Date().toISOString(),
  };
}

/** Close-over-previous-close change, the figure quoted in market reports. */
export function summarise(series) {
  const { candles } = series;
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const change = last.c - prev.c;

  return {
    last: last.c,
    prevClose: prev.c,
    change,
    changePct: (change / prev.c) * 100,
    direction: change >= 0 ? 'up' : 'down',
    dayHigh: last.h,
    dayLow: last.l,
    date: new Date(last.t).toISOString().slice(0, 10),
  };
}
