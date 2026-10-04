// Evening market carousel: NSE trading days only, and only on a close that is
// dated today (IST) and checked in code. No "aaj" claim on stale data.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { NSE_HOLIDAYS, marketClosed, parseChart, closeStory, marketCloseStories } from '../pipeline/src/carousel/market.js';
import { missedSlots } from '../pipeline/src/health/missed-publish.js';
import { storyNumbers } from '../pipeline/src/carousel/quality.js';

const ts = (iso) => Date.parse(iso) / 1000;
// Yahoo daily candles are stamped 09:15 IST (03:45Z). A holiday shows up as a null row.
const chart = (rows, meta = {}) => ({ chart: { result: [{
  meta: { regularMarketTime: rows.at(-1)[0] + 6 * 3600 + 900, regularMarketPrice: rows.at(-1)[1], ...meta },
  timestamp: rows.map((r) => r[0]),
  indicators: { quote: [{ close: rows.map((r) => r[1]), high: rows.map((r) => r[2] ?? r[1]), low: rows.map((r) => r[3] ?? r[1]) }] },
}] } });
const day = (d, close, high, low) => [ts(`${d}T03:45:00Z`), close, high, low];

test('the 2026 NSE holiday list is the official one (circular CMTR71775) plus 15 Jan', () => {
  assert.deepEqual([...NSE_HOLIDAYS], [
    '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
    '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
  ]);
  for (const d of NSE_HOLIDAYS) {
    const wd = new Date(`${d}T12:00:00+05:30`).getUTCDay();
    assert.ok(wd >= 1 && wd <= 5, `${d} is a weekday holiday`);
  }
  assert.equal(marketClosed('2026-10-02'), 'NSE holiday');
  assert.equal(marketClosed('2026-10-03'), 'weekend');
  assert.equal(marketClosed('2026-10-04'), 'weekend');
  assert.equal(marketClosed('2026-10-05'), null, 'the market reopens on Monday 5 Oct');
  assert.equal(marketClosed('2026-11-08'), 'weekend', 'Diwali Sunday (Muhurat) is not a regular session');
  assert.match(marketClosed('2027-01-04'), /no NSE holiday list/, 'fails closed until the 2027 list is added');
});

test('a close dated today is parsed, rounded and checked; holiday null rows are ignored', () => {
  const json = chart([day('2026-10-01', 22421.94921875), day('2026-10-02', null), day('2026-10-05', 22610.4501953125, 22650.1, 22380.3)]);
  const c = parseChart(json, { today: '2026-10-05', name: 'NIFTY 50' });
  assert.equal(c.ok, true);
  assert.deepEqual([c.date, c.close, c.prevClose, c.change, c.changePct, c.high, c.low], ['2026-10-05', 22610.45, 22421.95, 188.5, 0.84, 22650.1, 22380.3]);
  const story = closeStory({ name: 'NIFTY 50', symbol: '^NSEI' }, c);
  assert.equal(story.site, 'Yahoo Finance');
  const pool = storyNumbers([story]);
  for (const n of ['22610.45', '22421.95', '188.5', '0.84', '22650.1', '22380.3']) assert.ok(pool.has(n), `${n} is in the source pool`);
});

test('stale, inconsistent or thin data is refused', () => {
  const holidayToday = chart([day('2026-09-30', 22620.45), day('2026-10-01', 22421.95), day('2026-10-02', null)]);
  assert.match(parseChart(holidayToday, { today: '2026-10-02' }).reason, /latest candle is 2026-10-01, not today 2026-10-02/);
  const old = chart([day('2026-10-01', 22421.95), day('2026-10-05', 22500)], { regularMarketTime: ts('2026-10-01T10:00:00Z') });
  assert.match(parseChart(old, { today: '2026-10-05' }).reason, /last trade is from 2026-10-01/);
  const disagree = chart([day('2026-10-01', 22421.95), day('2026-10-05', 22500)], { regularMarketPrice: 21000 });
  assert.match(parseChart(disagree, { today: '2026-10-05' }).reason, /disagrees/);
  const wild = chart([day('2026-10-01', 22421.95), day('2026-10-05', 30000)]);
  assert.match(parseChart(wild, { today: '2026-10-05' }).reason, /implausible/);
  assert.match(parseChart(chart([day('2026-10-05', 22500)]), { today: '2026-10-05' }).reason, /fewer than two/);
  assert.equal(parseChart({}, { today: '2026-10-05' }).ok, false);
});

const fetchFor = (bySymbol) => async (url) => {
  const sym = decodeURIComponent(url.split('/chart/')[1].split('?')[0]);
  if (bySymbol[sym] instanceof Error) throw bySymbol[sym];
  return { ok: true, status: 200, json: async () => bySymbol[sym] };
};
const good = chart([day('2026-10-01', 22421.95), day('2026-10-05', 22610.45)]);
const sensex = chart([day('2026-10-01', 73800.1), day('2026-10-05', 74250.6)]);
const monday1645 = Date.parse('2026-10-05T11:15:00Z');

test('marketCloseStories: verified NIFTY (+ SENSEX) on a trading day after 15:30 IST, otherwise a skip reason', async () => {
  const ok = await marketCloseStories({ now: monday1645, fetchImpl: fetchFor({ '^NSEI': good, '^BSESN': sensex }) });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.indices.map((i) => [i.name, i.close]), [['NIFTY 50', 22610.45], ['SENSEX', 74250.6]]);
  assert.equal(ok.stories[0].date, '2026-10-05');

  const noSensex = await marketCloseStories({ now: monday1645, fetchImpl: fetchFor({ '^NSEI': good, '^BSESN': new Error('HTTP 500') }) });
  assert.equal(noSensex.ok, true, 'SENSEX is optional');
  assert.equal(noSensex.stories.length, 1);

  const noNifty = await marketCloseStories({ now: monday1645, fetchImpl: fetchFor({ '^NSEI': new Error('HTTP 429'), '^BSESN': sensex }) });
  assert.equal(noNifty.ok, false);
  assert.match(noNifty.reason, /NIFTY 50: HTTP 429 — no market carousel on unverified data/);

  const stale = await marketCloseStories({ now: Date.parse('2026-10-06T11:15:00Z'), fetchImpl: fetchFor({ '^NSEI': good, '^BSESN': sensex }) });
  assert.match(stale.reason, /latest candle is 2026-10-05, not today 2026-10-06/);

  let called = 0;
  const count = async () => { called += 1; throw new Error('should not fetch'); };
  assert.match((await marketCloseStories({ now: Date.parse('2026-10-04T11:15:00Z'), fetchImpl: count })).reason, /not a trading day \(weekend\)/);
  assert.match((await marketCloseStories({ now: Date.parse('2026-10-02T11:15:00Z'), fetchImpl: count })).reason, /not a trading day \(NSE holiday\)/);
  assert.match((await marketCloseStories({ now: Date.parse('2026-10-05T09:00:00Z'), fetchImpl: count })).reason, /not closed yet/);
  assert.equal(called, 0);
});

test('slot health does not report the evening market post missing on a non-trading day', () => {
  const after = (d) => new Date(`${d}T14:37:00Z`); // 20:07 IST
  const slots = (d) => missedSlots({ now: after(d), env: {}, media: [], carouselEntries: [], reelPublishEntries: [{ date: d, mediaId: '1' }] });
  assert.ok(slots('2026-10-05').includes('evening'), 'a trading day without the post is missed');
  assert.equal(slots('2026-10-04').includes('evening'), false);
  assert.equal(slots('2026-10-02').includes('evening'), false);
});
