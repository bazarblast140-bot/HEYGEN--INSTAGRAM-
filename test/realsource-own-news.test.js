// Rajesh, 16 Oct 2026: "sidha har slide me apna apna news" — every slide shows only its own story.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../pipeline/realsource/template.html', import.meta.url), 'utf8');
const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const ctx = { window: {}, document: { querySelectorAll: () => [] } }; vm.createContext(ctx); vm.runInContext(js, ctx);

const r = (x, y, w, h) => ({ x, y, w, h });
const art = (kicker, i) => ({
  kicker, siteName: `Site${i}`, dateIso: '2026-10-16T10:00:00+05:30', dir: `a${i}`, dpr: 2, natural: { w: 1600, h: 3000 },
  h1: r(40, 300, 700, 80), headlineLines: [r(40, 300, 700, 40), r(40, 340, 500, 40)], date: { rect: r(40, 390, 300, 20) },
  key: { rects: [r(40, 600, 600, 20)], block: r(40, 600, 700, 60) }, mast: null,
  title: `TITLE_${kicker}`, coverLine: `COVER_${kicker}`, plain: `PLAIN_${kicker}`, summary: `SUMMARY_${kicker}`, checkLine: `CHECK_${kicker}`,
});
const KINDS = ['Market', 'Stocks', 'Mutual Funds', 'Finance'];
const bars = Array.from({ length: 60 }, (_, i) => ({ date: `2026-08-${String(i % 28 + 1).padStart(2, '0')}`, xCss: 100 + i * 10, h: 23000, l: 22500 }));
const D = {
  today: '2026-10-16', pct: 0.4, livePct: 0.4, livePrice: 23085.35, livePrev: { date: '2026-10-15', c: 22997.35 }, capturedAtIst: '2026-10-16 14:30:00',
  T: { o: 23065, h: 23150, l: 22913, c: 23085 }, S: { price: 22179.9, date: '2026-10-08', x: 500 }, R1: { price: 23489, date: '2026-09-20' }, R2: null,
  mapping: { a: 5000, b: -0.2 }, tvNatural: { w: 1720, h: 2000 }, tv5Natural: { w: 1720, h: 2000 }, newsNatural: {},
  meta: { dpr: 2, pane: { x: 10, y: 50, w: 800, h: 800 }, spacingCss: 9 }, bars: bars.map((b, i) => ({ ...b, date: i === 30 ? '2026-10-08' : i === 40 ? '2026-09-20' : b.date })),
  intra: { mapping: { a: 5000, b: -0.2 }, meta: { dpr: 2, pane: { x: 10, y: 50, w: 800, h: 800 }, spacingCss: 9 }, firstX: 100, range: 236, rangePct: 1.03,
    high: { x: 600, price: 23150, time: '12:00' }, low: { x: 200, price: 22913, time: '09:30' }, open: { x: 100, price: 23065, time: '09:15' },
    close: { x: 900, price: 23085, time: '14:25', asOf: '14:30', isClose: false }, yahooCheck: { compared: 60, worstDevPts: 3 } },
  articles: KINDS.map(art), copy: { hook: 'आज: HOOK_FROM_MARKET<br>4 ख़बरें, 1 असली chart' },
};
D.news = D.articles[0];

test('each slide shows only its own story (no list or recap of the other headlines)', () => {
  const S = ctx.build(D);
  const own = { 1: 'Market', 3: 'Market', 4: 'Stocks', 5: 'Mutual Funds', 6: 'Finance' };
  for (let n = 1; n <= 9; n += 1) {
    const out = S[n]();
    for (const k of KINDS) for (const f of ['TITLE', 'COVER', 'SUMMARY']) {
      if (own[n] === k) continue;
      assert.ok(!out.includes(`${f}_${k}`), `slide ${n} contains ${f}_${k}`);
    }
    assert.ok(!out.includes('4 ख़बरें'), `slide ${n} lists the stories`);
  }
  const s1 = S[1]();
  assert.match(s1, /data-hook[^>]*>आज: HOOK_FROM_MARKET</);
  assert.match(s1, /a0\/news\.png/, 'slide 1 shows the hook article\'s own screenshot');
  assert.match(s1, /Site0 · 16 Oct 2026/, 'with its source and date');
  assert.ok(!/a[123]\/news\.png/.test(s1));
});
