// Indian market calendar and the day's verified close (evening slot).
//
// Trading days: Monday–Friday that are not NSE trading holidays. The 2026
// list is NSE circular CMTR71775 ("Trading holidays for the calendar year
// 2026", Capital Market segment), plus 15 Jan (municipal election day,
// notified later; BSE lists it too). Weekend holidays (15 Feb, 21 Mar,
// 15 Aug, 8 Nov Diwali with Muhurat trading) are already non-trading days.
//
// The close comes from the Yahoo Finance chart API (no key). It is used only
// when the latest daily candle's IST date is TODAY, the market has closed
// (15:30 IST) and the numbers are internally consistent; otherwise the
// evening market carousel is skipped — no "aaj" claim on stale data.

export const NSE_HOLIDAYS = new Set([
  '2026-01-15', // Municipal Corporation election (Maharashtra)
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25', // Christmas
]);

export const CLOSE_MINUTE = 15 * 60 + 30; // NSE cash market closes 15:30 IST

const istDate = (t) => new Date(new Date(t).getTime() + 330 * 60000).toISOString().slice(0, 10);
const istMinutes = (t) => { const d = new Date(new Date(t).getTime() + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

/** Why the Indian market is shut on this IST date, or null on a trading day. */
export function marketClosed(date) {
  const year = Number(String(date).slice(0, 4));
  if (year !== 2026) return 'no NSE holiday list for this year';
  const day = new Date(`${date}T12:00:00+05:30`).getUTCDay();
  if (day === 0 || day === 6) return 'weekend';
  if (NSE_HOLIDAYS.has(date)) return 'NSE holiday';
  return null;
}

/** Prompt block for a non-trading day, or ''. */
export function marketDayNote(date) {
  const why = marketClosed(date);
  return why
    ? `\n\n<market_day>\n${date} trading day नहीं है (${why}). "आज market", "आज Nifty/Sensex", "आज बंद हुआ", "आज खुला" जैसी कोई आज की market claim (price, open/close, index move) मत लिखो. ख़बर को उसकी अपनी तारीख़ से बताओ.\n</market_day>`
    : '';
}

export const INDICES = [
  { symbol: '^NSEI', name: 'NIFTY 50', required: true },
  { symbol: '^BSESN', name: 'SENSEX', required: false },
];

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Latest daily candle from a Yahoo chart response, checked.
 * Returns { ok:true, date, close, prevClose, change, changePct, high, low, at } or { ok:false, reason }.
 */
export function parseChart(json, { today, name = 'index' } = {}) {
  const r = json?.chart?.result?.[0];
  const ts = r?.timestamp || [];
  const q = r?.indicators?.quote?.[0] || {};
  const rows = ts.map((t, i) => ({ t: t * 1000, close: q.close?.[i], high: q.high?.[i], low: q.low?.[i] }))
    .filter((x) => Number.isFinite(x.close) && x.close > 0);
  if (rows.length < 2) return { ok: false, reason: `${name}: fewer than two daily closes in the response` };
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const date = istDate(last.t);
  if (date !== today) return { ok: false, reason: `${name}: latest candle is ${date}, not today ${today} (IST)` };
  const meta = r.meta || {};
  if (Number.isFinite(meta.regularMarketTime) && istDate(meta.regularMarketTime * 1000) !== today) {
    return { ok: false, reason: `${name}: last trade is from ${istDate(meta.regularMarketTime * 1000)}, not today` };
  }
  if (Number.isFinite(meta.regularMarketPrice) && Math.abs(meta.regularMarketPrice - last.close) / last.close > 0.005) {
    return { ok: false, reason: `${name}: last price ${meta.regularMarketPrice} disagrees with the candle close ${last.close}` };
  }
  const close = round2(last.close);
  const prevClose = round2(prev.close);
  const change = round2(close - prevClose);
  const changePct = round2((change / prevClose) * 100);
  if (Math.abs(changePct) > 15) return { ok: false, reason: `${name}: implausible move ${changePct}%` };
  const high = Number.isFinite(last.high) ? round2(last.high) : null;
  const low = Number.isFinite(last.low) ? round2(last.low) : null;
  if (high != null && low != null && (close > high + 0.01 || close < low - 0.01)) {
    return { ok: false, reason: `${name}: close ${close} outside the day range ${low}–${high}` };
  }
  return { ok: true, date, close, prevClose, change, changePct, high, low, at: last.t };
}

/** One story line for the generator; every number in it is code-checked. */
export function closeStory(index, c) {
  const dir = c.change >= 0 ? 'ऊपर' : 'नीचे';
  const range = c.high != null && c.low != null ? `, day high ${c.high}, day low ${c.low}` : '';
  return {
    title: `${index.name} ${c.date} को ${c.close} पर बंद (पिछला close ${c.prevClose}; ${Math.abs(c.change)} points / ${Math.abs(c.changePct)}% ${dir}${range})`,
    url: `https://finance.yahoo.com/quote/${encodeURIComponent(index.symbol)}/history`,
    site: 'Yahoo Finance',
    feed: 'market close',
    date: c.date,
    at: c.at,
    from: 'market-close',
  };
}

async function fetchChart(symbol, fetchImpl) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetchImpl(url, { headers: { 'user-agent': 'Mozilla/5.0 (carousel market close)' }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo chart ${symbol}: HTTP ${res.status}`);
  return res.json();
}

/**
 * Today's verified close for the evening slot.
 * { ok:true, date, stories:[...], indices:[{name, ...close}] } or { ok:false, reason }. Never throws.
 */
export async function marketCloseStories({ now = Date.now(), fetchImpl = fetch, onNote } = {}) {
  const today = istDate(now);
  const why = marketClosed(today);
  if (why) return { ok: false, reason: `${today} is not a trading day (${why}) — no market carousel` };
  if (istMinutes(now) < CLOSE_MINUTE) return { ok: false, reason: `the market has not closed yet (${today}, before 15:30 IST)` };
  const stories = [];
  const indices = [];
  for (const index of INDICES) {
    let c;
    try {
      c = parseChart(await fetchChart(index.symbol, fetchImpl), { today, name: index.name });
    } catch (err) {
      c = { ok: false, reason: `${index.name}: ${err.message}` };
    }
    if (!c.ok) {
      if (index.required) return { ok: false, reason: `${c.reason} — no market carousel on unverified data` };
      onNote?.(`market close: ${c.reason} — skipped`);
      continue;
    }
    stories.push(closeStory(index, c));
    indices.push({ name: index.name, symbol: index.symbol, ...c });
  }
  onNote?.(`market close verified for ${today}: ${indices.map((i) => `${i.name} ${i.close} (${i.changePct}%)`).join(', ')}`);
  return { ok: true, date: today, stories, indices };
}
