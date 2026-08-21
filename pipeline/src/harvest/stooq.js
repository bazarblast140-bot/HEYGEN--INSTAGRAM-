// Daily OHLC from Stooq, as a second source when Yahoo refuses.
//
// Yahoo rate-limits shared CI address ranges so aggressively that six retries
// across both of its hosts still came back 429 on a GitHub runner. Retrying harder
// was not the fix; having somewhere else to ask was.
//
// Stooq serves plain CSV over a bare GET — no key, no cookies, no browser dance —
// which is exactly what a scheduled job needs. It carries daily bars only, which
// is all the pre-market brief uses.

const HOSTS = ['https://stooq.com', 'https://stooq.pl'];

// A browser User-Agent, because a bare fetch is what several of these hosts
// answer with an HTML interstitial instead of the CSV they advertise.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

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

/**
 * Index symbols start with a caret, and that caret is the whole problem.
 *
 * encodeURIComponent turns it into %5E, and Stooq answered that with an HTML
 * page rather than the CSV it advertises — which read like "Stooq is broken"
 * when it was really "that is not the symbol you meant". So the caret is sent
 * as-is first, and the encoded form is kept only as a fallback in case a host
 * disagrees.
 */
function urlVariants(symbol) {
  const raw = `s=${symbol}&i=d`;
  const encoded = `s=${encodeURIComponent(symbol)}&i=d`;
  return HOSTS.flatMap((host) => [
    `${host}/q/d/l/?${raw}`,
    `${host}/q/d/l/?${encoded}`,
  ]);
}

export async function fetchCandles(nameOrTicker, { bars = 90, onAttempt } = {}) {
  const symbol = resolveSymbol(nameOrTicker);

  let text = null;
  const refusals = [];

  for (const url of urlVariants(symbol)) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/csv,*/*' } });
      if (!res.ok) { refusals.push(`${res.status} ${url}`); continue; }

      const body = await res.text();

      // Three different non-answers, all arriving as HTTP 200: an HTML page, the
      // literal words "No data", and anything that is not a CSV header. None of
      // them is a reason to stop trying the other hosts.
      if (/^\s*</.test(body)) { refusals.push(`HTML ${url}`); continue; }
      if (/no data/i.test(body.slice(0, 200))) { refusals.push(`"No data" ${url}`); continue; }
      if (!/^date,/i.test(body)) { refusals.push(`not CSV ${url}`); continue; }

      onAttempt?.(url);
      text = body;
      break;
    } catch (err) {
      refusals.push(`${String(err.message).slice(0, 40)} ${url}`);
    }
  }

  if (!text) throw new Error(`Stooq gave no CSV for ${symbol} — ${refusals.join('; ')}`);

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
