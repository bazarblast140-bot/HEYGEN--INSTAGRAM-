// News slides carry 1-2 short spoken-Hindi explainer lines above the real screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { explainLines, fallbackExplain, plainHindi, isDevanagari, EXPLAIN_MAX, PLAIN_MAX } from '../pipeline/realsource/lib/explainer.mjs';

const A = { kicker: 'Finance', title: 'SBI Card लेगा 1% fee', headline: 'SBI Card to charge 1% fee on rent payments from Dec 1', bodyText: 'SBI Card will levy 1% fee from December 1 on rent and wallet loads.' };

test('Devanagari model lines pass when short and their numbers are in the article', () => {
  const ok = ['SBI Card 1 दिसंबर से 1% फीस लेगा।', 'मतलब: किराया और वॉलेट पेमेंट महँगा होगा।'];
  assert.deepEqual(explainLines({ ...A, explain: ok }), ok);
});

test('Roman Hinglish/English, invented number, too long, Devanagari digits, missing or junk -> Devanagari fallback, never throws', () => {
  const fb = fallbackExplain(A);
  assert.equal(fb.length, 2); assert.match(fb[0], /^खबर: /); assert.ok(isDevanagari(fb[0])); assert.match(fb[1], /^मतलब: /);
  assert.deepEqual(explainLines({ ...A, explain: ['SBI Card 1 Dec se 1% fee lega.', 'Matlab rent mehenga hoga.'] }), fb);
  assert.deepEqual(explainLines({ ...A, explain: ['SBI Card will charge 1% fee'] }), fb);
  assert.deepEqual(explainLines({ ...A, explain: ['फीस 7% होगी।'] }), fb);
  assert.deepEqual(explainLines({ ...A, explain: ['फीस १% होगी।'] }), fb);
  assert.deepEqual(explainLines({ ...A, explain: ['क'.repeat(EXPLAIN_MAX + 1)] }), fb);
  assert.deepEqual(explainLines(A), fb);
  assert.deepEqual(explainLines({ ...A, explain: 42 }), fb);
  assert.doesNotThrow(() => explainLines(undefined));
  for (const l of fallbackExplain({ kicker: 'Market', title: 'ख'.repeat(300) })) assert.ok(l.length <= EXPLAIN_MAX);
  for (const k of ['Market', 'Stocks', 'Mutual Funds', 'Finance', undefined]) for (const l of fallbackExplain({ kicker: k, title: 'Nifty jumps 2% on bank rally' })) {
    assert.ok(isDevanagari(l), `fallback "${l}" is Devanagari`); assert.ok(!/Nifty jumps/.test(l), 'English title is not used'); assert.ok(l.length <= EXPLAIN_MAX);
  }
});

test('summary box text (plain) is Devanagari, number-checked, else Devanagari fallback', () => {
  const good = 'SBI Card अब किराए और वॉलेट पेमेंट पर 1% फीस लेगा।';
  assert.equal(plainHindi({ ...A, plain: good }), good);
  for (const bad of ['SBI Card ab rent par 1% fee lega.', 'SBI Card will levy a fee of 1%.', 'अब 5% fee लगेगी।', 'क'.repeat(PLAIN_MAX + 1)]) {
    const x = plainHindi({ ...A, plain: bad });
    assert.equal(x, fallbackExplain(A).join(' ')); assert.ok(isDevanagari(x));
  }
  assert.doesNotThrow(() => plainHindi(undefined));
});

test('pick asks for Devanagari explain/plain and flags Roman copy only as a soft retry problem', async () => {
  const { scriptProblems } = await import('../pipeline/realsource/pick.mjs');
  assert.deepEqual(scriptProblems({ articles: [{ cand: 1, plain: 'SBI Card अब 1% फीस लेगा।', explain: ['SBI Card 1 दिसंबर से 1% फीस लेगा।'] }] }), []);
  const p = scriptProblems({ articles: [{ cand: 2, plain: 'SBI Card ab fee lega', explain: ['Matlab mehenga'] }] });
  assert.equal(p.length, 2);
  const src = await fs.readFile(new URL('../pipeline/realsource/pick.mjs', import.meta.url), 'utf8');
  assert.match(src, /attempt < 4 \? scriptProblems\(pick\)/);
});

test('pick prompt asks for the explain field; build attaches it without adding a problem', async () => {
  const pick = await fs.readFile(new URL('../pipeline/realsource/pick.mjs', import.meta.url), 'utf8');
  assert.match(pick, /"explain": 1-2 VERY short spoken Hindi lines in DEVANAGARI script/);
  assert.match(pick, /"plain": [^\n]*DEVANAGARI script/);
  const build = await fs.readFile(new URL('../pipeline/realsource/build.mjs', import.meta.url), 'utf8');
  assert.match(build, /A\.explain = explainLines\(A, body\)/);
  assert.match(build, /A\.plain = plainHindi\(A, body\)/);
  const wf = await fs.readFile(new URL('../.github/workflows/midday-realsource.yml', import.meta.url), 'utf8');
  assert.match(wf, /fonts-noto-core/);
  await fs.access(new URL('../pipeline/realsource/fonts/noto-devanagari.ttf', import.meta.url));
  assert.ok(!/explain[^\n]*problems\.push|P\([^\n]*explain/.test(build));
});

test('template renders the explainer above the screenshot on every news slide', async () => {
  const html = await fs.readFile(new URL('../pipeline/realsource/template.html', import.meta.url), 'utf8');
  const js = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const ctx = { window: {}, document: { querySelectorAll: () => [] } }; vm.createContext(ctx); vm.runInContext(js, ctx);
  const r = (x, y, w, h) => ({ x, y, w, h });
  const art = (kicker, i) => ({ kicker, siteName: `S${i}`, dateIso: '2026-10-29', dir: `a${i}`, dpr: 2, natural: { w: 1600, h: 3000 },
    h1: r(40, 300, 700, 80), headlineLines: [r(40, 300, 700, 40)], date: { rect: r(40, 390, 300, 20) },
    key: { rects: [r(40, 600, 600, 20)], block: r(40, 600, 700, 60) }, mast: null,
    title: `T${i}`, coverLine: 'C', plain: 'P', summary: 'S', checkLine: 'K', explain: [`Line1 ${kicker}`, 'Matlab <b>x</b>'] });
  const bars = Array.from({ length: 60 }, (_, i) => ({ date: `2026-08-${String(i % 28 + 1).padStart(2, '0')}`, xCss: 100 + i * 10, h: 23000, l: 22500 }));
  const D = { today: '2026-10-29', pct: 0.4, livePct: 0.4, livePrice: 23085, livePrev: { date: '2026-10-28', c: 22997 }, capturedAtIst: '2026-10-29 14:30:00',
    T: { o: 1, h: 2, l: 1, c: 2 }, S: { price: 22179.9, date: '2026-10-08', x: 500 }, R1: { price: 23489, date: '2026-09-20' }, R2: null,
    mapping: { a: 5000, b: -0.2 }, tvNatural: { w: 1720, h: 2000 }, tv5Natural: { w: 1720, h: 2000 }, newsNatural: {},
    meta: { dpr: 2, pane: { x: 10, y: 50, w: 800, h: 800 }, spacingCss: 9 }, bars: bars.map((b, i) => ({ ...b, date: i === 30 ? '2026-10-08' : i === 40 ? '2026-09-20' : b.date })),
    intra: { mapping: { a: 5000, b: -0.2 }, meta: { dpr: 2, pane: { x: 10, y: 50, w: 800, h: 800 }, spacingCss: 9 }, firstX: 100, range: 236, rangePct: 1.03,
      high: { x: 600, price: 23150, time: '12:00' }, low: { x: 200, price: 22913, time: '09:30' }, open: { x: 100, price: 23065, time: '09:15' },
      close: { x: 900, price: 23085, time: '14:25', asOf: '14:30', isClose: false }, yahooCheck: { compared: 60, worstDevPts: 3 } },
    articles: ['Market', 'Stocks', 'Mutual Funds', 'Finance'].map(art), copy: { hook: 'आज: H<br>x' } };
  D.news = D.articles[0];
  const S = ctx.build(D);
  for (let n = 3; n <= 6; n += 1) {
    const out = S[n]();
    const e = out.indexOf('data-qa="explain"'), shot = out.indexOf('data-qa="shot"');
    assert.ok(e > 0 && e < shot, `slide ${n}: explainer above the screenshot`);
    assert.ok(!out.includes('<b>x</b>'), 'explainer text is escaped');
    const top = Number(/data-qa="explain" style="[^"]*top:(\d+)px/.exec(out)[1]);
    const sTop = Number(/data-qa="shot" style="[^"]*top:(\d+)px/.exec(out.slice(e))[1]);
    assert.ok(sTop > top + 100, `slide ${n}: screenshot starts below the explainer`);
  }
});
