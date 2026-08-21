// Daily OHLC from Stooq, as a second source when Yahoo refuses.
//
// Yahoo rate-limits shared CI address ranges so aggressively that six retries
// across both of its hosts still came back 429 on a GitHub runner. Retrying harder
// was not the fix; having somewhere else to ask was.
//
// Stooq serves plain CSV over a bare GET — no key, no cookies, no browser dance —
// which is exactly what a scheduled job needs. It carries daily bars only, which
// is all the pre-market brief uses.

const BASE = 'https://stooq.com/q/d/l/';

export const SYMBOLS = {
  nifty: '^nsei',
  banknifty: '^nsebank',
  sensex: '^bsesn',
  usdinr: 'usdinr',
  crude: 'cl.f',
};

export function resolveSymbol(nameOrTicker) {
  return SYMBOLS[nameOrTicker] || String(nameOrTicker).toLowerCase().replace(/\.ns$/, '.in');
}

export async function fetchCandles(nameOrTicker, { bars = 90 } = {}) {
  const symbol = resolveSymbol(nameOrTicker);
  const res = await fetch(`${BASE}?s=${encodeURIComponent(symbol)}&i=d`, {
    headers: { Accept: 'text/csv' },
  });
  if (!res.ok) throw new Error(`Stooq returned ${res.status} for ${symbol}`);

  const text = await res.text();

  // Stooq answers a bad symbol with a 200 and the body "No data", so the status
  // code alone proves nothing.
  if (/no data/i.test(text.slice(0, 200))) throw new Error(`Stooq has no data for ${symbol}`);

  const lines = text.trim().split('\n');
  const header = lines[0].toLowerCase();
  if (!header.startsWith('date')) throw new Error(`Unexpected Stooq response for ${symbol}: ${lines[0].slice(0, 80)}`);

  const candles = lines.slice(1)
    .map((line) => {
      const [date, o, h, l, c, v] = line.split(',');
      return {
        t: Date.parse(`${date}T00:00:00Z`),
        o: Number(o), h: Number(h), l: Number(l), c: Number(c),
        v: Number(v) || 0,
      };
    })
    .filter((d) => Number.isFinite(d.t) && [d.o, d.h, d.l, d.c].every(Number.isFinite))
    .slice(-bars);

  if (candles.length < 2) throw new Error(`Only ${candles.length} usable candles from Stooq for ${symbol}`);

  return {
    symbol,
    name: nameOrTicker === 'nifty' ? 'NIFTY 50' : symbol.toUpperCase(),
    currency: 'INR',
    interval: '1d',
    candles,
    source: 'stooq',
    fetchedAt: new Date().toISOString(),
  };
}
