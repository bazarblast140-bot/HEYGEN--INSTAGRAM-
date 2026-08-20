// Deterministic synthetic OHLC, for developing the renderer where the network
// policy blocks Yahoo (Claude Code sessions) and for reproducible tests.
//
// These are NOT real market numbers. Anything produced from this series is
// stamped `synthetic: true` so it can never be mistaken for a real session and
// published by accident — the QC gate refuses to publish a synthetic reel.

/** Mulberry32: small seeded PRNG, so the same seed always yields the same series. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticSeries({
  symbol = '^NSEI',
  name = 'NIFTY 50 (SYNTHETIC)',
  start = 24800,
  bars = 60,
  seed = 20260820,
  drift = 0.0006,
  vol = 0.008,
  endDate,
} = {}) {
  const rand = rng(seed);
  const candles = [];
  let close = start;

  // Walk back from the most recent weekday to collect exactly `bars` trading days,
  // then replay them forward. Timestamps snap to UTC midnight so two calls on the
  // same day produce byte-identical output.
  const days = tradingDaysEndingAt(endDate ? Date.parse(endDate) : Date.now(), bars);

  for (const t of days) {
    const open = close;
    // Box-Muller for a normal-ish step, so the series has realistic tails.
    const u = Math.max(rand(), 1e-9);
    const shock = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    close = open * (1 + drift + shock * vol);

    const body = Math.abs(close - open);
    const high = Math.max(open, close) + body * rand() * 1.4 + open * 0.0008;
    const low = Math.min(open, close) - body * rand() * 1.4 - open * 0.0008;

    candles.push({
      t,
      o: round(open),
      h: round(high),
      l: round(low),
      c: round(close),
      v: Math.round(180e6 + rand() * 140e6),
    });
  }

  return {
    symbol,
    name,
    currency: 'INR',
    interval: '1d',
    candles,
    source: 'synthetic',
    synthetic: true,
    fetchedAt: new Date().toISOString(),
  };
}

const round = (n) => Math.round(n * 100) / 100;

/** The `count` most recent Mon–Fri UTC midnights ending on or before `endMs`, oldest first. */
function tradingDaysEndingAt(endMs, count) {
  const day = 86400000;
  let cursor = Math.floor(endMs / day) * day;
  const out = [];
  while (out.length < count) {
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) out.push(cursor);
    cursor -= day;
  }
  return out.reverse();
}
