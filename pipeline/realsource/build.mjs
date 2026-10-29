#!/usr/bin/env node
// Midday real-source carousel (9 slides) + one Story frame per slide. Posts NOTHING.
//   node run.mjs --articles articles-<date>.json [--date YYYY-MM-DD] [--out dir] [--skip-chart] [--skip-news] [--allow-problems]
// Slides: 1 cover · 2 NIFTY 5m (TradingView, Yahoo-checked) · 3–6 real articles (highlight + zoom + code check)
//         7 analysis on the NIFTY daily chart (levels by rule) · 8 summary (news vs analysis) · 9 CTA
// Stories: story-01..09.jpg = each slide letterboxed into 1080x1920 (no crop); the last carries the profile prompt.
// Package: <out>/package = pipeline/specs/oneoff/midday-<date>/ (slot midday).
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureChart } from './lib/capture-chart.mjs';
import { captureNews } from './lib/capture-news.mjs';
import { explainLines } from './lib/explainer.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = HERE;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const istNow = new Date(Date.now() + 5.5 * 3600e3).toISOString();
const date = opt('date', istNow.slice(0, 10));
const out = path.resolve(opt('out', path.join('pipeline', 'out', 'realsource')));
const cfg = JSON.parse(await fs.readFile(opt('articles', path.join(out, 'articles.json')), 'utf8'));
const pkgRel = `pipeline/specs/oneoff/midday-${date}`;
const t0 = Date.now();
const log = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s] ${s}`);
const fmt = (v) => Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dshort = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d} ${MON[m - 1]}`; };
await fs.mkdir(out, { recursive: true });
const problems = [];

// 1. charts (daily for levels, 5m for today) + verification
if (!flag('skip-chart')) {
  await captureChart({ out, log });
  await captureChart({ out, log, interval: '5', prefix: 'tv5', zoomSteps: 4 });
}
execFileSync('python3', [path.join(LIB, 'lib', 'data.py'), out, date], { stdio: ['ignore', 'ignore', 'inherit'] });
const D = JSON.parse(await fs.readFile(path.join(out, 'data.json'), 'utf8'));
execFileSync('python3', [path.join(LIB, 'lib', 'intraday.py'), out, date], { stdio: ['ignore', 'ignore', 'inherit'] });
const I = JSON.parse(await fs.readFile(path.join(out, 'intraday.json'), 'utf8'));
D.intra = I;
// A tolerated TradingView wick spike on today's low (intraday.py / wicks.py) must not reach
// the daily slides either: the support level uses today's agreed low, same as the 5m slide.
if (I.low?.spikeCorrected) {
  const win = D.bars.slice(-10).map((b) => (b.date === date ? { ...b, l: I.low.price } : b));
  const sb = win.reduce((m, b) => (b.l < m.l ? b : m));
  D.S = { price: sb.l, date: sb.date, x: sb.xCss * D.meta.dpr, is52wLow: Boolean(D.low52 && sb.l <= D.low52.l + 0.06) };
}
// Midday: today's candle is live by design. Every other chart check stays hard.
const LIVE_OK = /before the 15:30 IST close|today's bar does not match Yahoo OHLC exactly \(open-only|session incomplete/;
problems.push(...D.problems.filter((x) => !LIVE_OK.test(x)), ...I.problems.filter((x) => !LIVE_OK.test(x)).map((x) => `5m: ${x}`));
if (D.T.date !== date) problems.push(`last daily bar ${D.T.date} is not ${date}`);
// The day's close is only claimed from the 15:25 bar after 15:30; any earlier
// bar is an intraday price shown with its own time, never called the close.
if (I.close.isClose && Math.abs(D.T.c - I.close.price) > 0.06) problems.push(`daily close ${D.T.c} != 5m close ${I.close.price}`);
if (!I.close.verified) problems.push('printed Nifty price is not Yahoo-verified');
const capMin = Number(D.capturedAtIst.slice(11, 13)) * 60 + Number(D.capturedAtIst.slice(14, 16));
if (capMin < 10 * 60 + 30) problems.push(`chart captured at ${D.capturedAtIst.slice(11, 16)} IST — too early in the session for a midday post`);
if (D.yahooLast && Math.abs(D.T.o - D.yahooLast.o) > 0.06) problems.push(`today's open ${D.T.o} != Yahoo open ${D.yahooLast.o}`);

// 2. articles
const ART = [];
for (const [i, a] of cfg.articles.entries()) {
  const dir = `a${i + 1}`;
  if (!flag('skip-news')) await captureNews({ out: path.join(out, dir), url: a.url, key: a.key, log, width: 480, dpr: 3, mobile: true, ...(a.capture || {}) });
  const N = JSON.parse(await fs.readFile(path.join(out, dir, 'news.json'), 'utf8'));
  const b = await fs.readFile(path.join(out, dir, 'news.png'));
  const A = { ...N, ...a, key: N.key, dir, natural: { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } };
  A.dateIso = (N.metaTime || N.modTime || '').slice(0, 10) || null;
  const P = (x) => problems.push(`${a.id}: ${x}`);
  if (A.dateIso !== date) P(`article published ${A.dateIso || '?'}, not ${date}`);
  {
    const [yy, mm, dd] = date.split('-').map(Number); const mon = MON[mm - 1];
    const today = new RegExp(`(${mon}[a-z]*\\.? ${dd},? ${yy}|${dd} ${mon}[a-z]* ${yy})`);
    if (!N.date || !today.test(N.date.text)) P(`visible date line "${N.date?.text || '-'}" does not show ${date}`);
  }
  if (!N.key) P('key sentence not found');
  else if (!N.key.rects?.length) P('key sentence is in the page source but not visible on screen');
  // OCR guard: the headline, key sentence and date must really be readable in the screenshot where we crop/highlight
  const ocr = (rects, text) => (rects?.length ? Number(execFileSync('python3', [path.join(HERE, 'lib', 'ocrcheck.py'), path.join(out, dir, 'news.png'), String(N.dpr), JSON.stringify(rects), text], { encoding: 'utf8' }).trim()) : 0);
  A.ocr = { headline: ocr(N.headlineLines, N.headline), key: N.key ? ocr(N.key.rects, N.key.text) : 0, date: N.date ? ocr([N.date.rect], N.date.text) : 0 };
  if (A.ocr.headline < 0.8) P(`headline not readable in the screenshot (OCR ${A.ocr.headline})`);
  if (A.ocr.key < 0.8) P(`key sentence not readable in the screenshot (OCR ${A.ocr.key})`);
  if (A.ocr.date < 0.5) P(`date line not readable in the screenshot (OCR ${A.ocr.date})`);
  const body = `${N.headline} ${N.key?.text || ''} ${N.key?.blockText || ''} ${N.bodyText || ''}`;
  const lines = [];
  for (const c of a.checks || []) {
    if (c.type === 'contains') {
      const miss = c.all.filter((s) => !body.includes(s));
      if (miss.length) P(`article text lacks ${miss.join(', ')}`); else lines.push(`${c.all.join(', ')} — article में लिखा है`);
    } else if (c.type === 'pct') {
      const v = (c.to / c.from - 1) * 100;
      if (!(body.includes(String(c.from)) && body.includes(String(c.to)) && body.includes(c.claimText))) P('pct inputs not in the article');
      if (v < c.claimMin || v > c.claimMax) P(`${c.from}→${c.to} = ${v.toFixed(1)}%, article says "${c.claimText}"`);
      lines.push(`Code check: ${c.from} → ${c.to} = +${v.toFixed(1)}% (“${c.claimText}” सही)`);
    } else if (c.type === 'nifty-move') {
      const m = /gained ([\d,.]+) points, or ([\d.]+)%, to ([\d,.]+) at .*?after opening at ([\d,.]+)/.exec(N.key?.text || '');
      const num = (s) => Number(s.replace(/,/g, '').replace(/\.$/, ''));
      const prev = D.bars.find((x) => x.date < date && D.bars.indexOf(x) === D.bars.length - 2) || D.bars[D.bars.length - 2];
      if (!m) { P('could not parse the Nifty move sentence'); continue; }
      const [pts, pct, lvl, open] = [num(m[1]), num(m[2]), num(m[3]), num(m[4])];
      const okPrev = Math.abs(lvl - pts - prev.c) <= 0.06;
      const okOpen = Math.abs(open - D.yahooLast.o) <= 0.06;
      const okPct = Math.abs((pts / prev.c) * 100 - pct) <= 0.01;
      if (!okPrev) P(`${fmt(lvl)} − ${fmt(pts)} = ${fmt(lvl - pts)} ≠ previous close ${fmt(prev.c)}`);
      if (!okOpen) P(`article open ${open} ≠ Yahoo open ${D.yahooLast.o}`);
      if (!okPct) P(`${pts}/${prev.c} = ${(pts / prev.c * 100).toFixed(3)}% ≠ ${pct}%`);
      lines.push(`Code check: ${fmt(lvl)} − ${fmt(pts)} = ${fmt(prev.c)} (${dshort(prev.date)} close) · open = Yahoo open`);
    }
  }
  // every number we print for this article must be in the article itself
  for (const t of [a.plain, a.coverLine, a.summary]) for (const n of t.match(/\d(?:[\d,]*\d)?(?:\.\d+)?/g) || []) {
    if (!body.includes(n)) P(`number ${n} in our text is not in the article`);
  }
  A.checkLine = lines.join(' · ');
  A.explain = explainLines(A, body); // 1-2 spoken-Hindi lines above the screenshot; never a problem
  ART.push(A);
}

// One live number everywhere (cover, caption): the latest 5m candle vs the previous daily close.
{
  const prev = D.bars[D.bars.length - 2];
  if (!prev || prev.date >= date) problems.push('no previous daily close for the live % change');
  D.livePrev = prev; D.livePrice = I.close.price; D.livePct = Math.round((I.close.price / prev.c - 1) * 10000) / 100;
}
const DATA = { ...D, articles: ART, news: ART[0], copy: { hook: cfg.hook },
  tv5Natural: await (async () => { const b = await fs.readFile(path.join(out, 'tv5.png')); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; })(),
  tvNatural: await (async () => { const b = await fs.readFile(path.join(out, 'tv.png')); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; })() };

// 3. render slides + story frames
await fs.copyFile(path.join(HERE, 'template.html'), path.join(out, 'slides.html'));
for (const f of ['inter-600.ttf', 'inter-700.ttf', 'noto-devanagari.ttf']) await fs.copyFile(path.join(LIB, 'fonts', f), path.join(out, f));
const NS = 9;
const br = await chromium.launch();
const qa = {};
try {
  const p = await br.newPage({ viewport: { width: 1080, height: 1350 } });
  await p.goto('file://' + path.join(out, 'slides.html'));
  await p.evaluate((d) => { window.DATA = d; }, DATA);
  await p.evaluate(async () => { await Promise.all([...document.fonts].map((f) => f.load())); await document.fonts.ready; });
  for (let n = 1; n <= NS; n += 1) {
    await p.evaluate((n) => window.render(n), n);
    await p.evaluate(async () => { await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); });
    await p.waitForTimeout(250);
    qa[n] = await p.evaluate(() => window.qa(1350));
    await p.screenshot({ path: path.join(out, `slide-${n}.jpg`), type: 'jpeg', quality: 92 });
  }
  // Story frames: whole slide, letterboxed (1080x1350 at y=285) on the brand background.
  const s = await br.newPage({ viewport: { width: 1080, height: 1920 } });
  for (let n = 1; n <= NS; n += 1) {
    const last = n === NS;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: 'Inter'; src: url('inter-700.ttf'); font-weight: 700 900; }
@font-face { font-family: 'Noto Devanagari'; src: url('noto-devanagari.ttf'); font-weight: 100 900; }
*{margin:0;padding:0;box-sizing:border-box} html,body{width:1080px;height:1920px;overflow:hidden}
body{font-family:'Inter','Noto Devanagari','Noto Color Emoji',sans-serif;background:repeating-linear-gradient(90deg,#121C2A 0 1px,transparent 1px 54px),repeating-linear-gradient(0deg,#121C2A 0 1px,transparent 1px 54px),linear-gradient(180deg,#070C18 0%,#040810 100%)}
img{position:absolute;left:0;top:${last ? 150 : 285}px;width:1080px;height:1350px}
.p{position:absolute;left:50px;right:50px;top:1530px;text-align:center;color:#0A0A0A;background:#FACC15;border-radius:28px;padding:26px 20px;font-weight:800;font-size:52px;line-height:1.3}
.t{position:absolute;left:0;right:0;top:60px;text-align:center;color:#94A3B8;font-weight:700;font-size:38px}
</style></head><body>${last ? '<div class="t">' + dshort(date) + ' की ख़बरें · पूरी post feed में</div>' : ''}<img src="slide-${n}.jpg">${last ? '<div class="p" data-qa="prompt">Poora padhne ke liye profile dekho 👆<br>@rajesh_technical_trader</div>' : ''}</body></html>`;
    await fs.writeFile(path.join(out, `story-${n}.html`), html);
    await s.goto('file://' + path.join(out, `story-${n}.html`));
    await s.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))); });
    if (last) { const r = await s.evaluate(() => { const e = document.querySelector('.p').getBoundingClientRect(); return e.bottom; }); if (r > 1900) qa.story = [`prompt off the frame (${r})`]; }
    await s.screenshot({ path: path.join(out, `story-${String(n).padStart(2, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
} finally { await br.close(); }
const qaProblems = Object.entries(qa).flatMap(([n, ps]) => ps.map((x) => `slide ${n}: ${x}`));
log(qaProblems.length ? `LAYOUT QA: ${qaProblems.length} problem(s)\n  ${qaProblems.join('\n  ')}` : 'layout QA: no cut text, no overlaps, no footer collisions');

// 4. caption, SOURCE.md
const pct = D.livePct;
const EMO = { Market: '📈', Stocks: '💹', 'Mutual Funds': '🏦', Finance: '⚖️' };
if (ART.length !== 4) problems.push(`${ART.length} articles — the midday carousel takes exactly 4`);
for (const A of ART) for (const n of String(A.captionLine || '').match(/\d(?:[\d,]*\d)?(?:\.\d+)?/g) || []) {
  if (!`${A.headline} ${A.key?.text || ''} ${A.bodyText || ''}`.includes(n)) problems.push(`${A.id}: caption number ${n} is not in the article`);
}
const caption = `${dshort(date)} ki 4 badi khabrein + asli Nifty chart 📊

📈 Nifty ${I.close.isClose ? 'close' : `${I.close.asOf} IST tak`} ${fmt(D.livePrice)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%) — TradingView
${ART.map((A) => `${EMO[A.kicker] || '📰'} ${A.kicker}: ${A.captionLine} — ${A.siteName}`).join('\n')}

Analysis (khabar nahi): Nifty ${fmt(D.S.price)} key support, ${fmt(D.R1.price)} resistance — chart rule se, guaranteed nahi.

Sabhi khabrein ${dshort(date)} ki hain, source har slide par. Chart: TradingView (NSE:NIFTY).
Sirf shiksha ke liye — nivesh salah nahi.

Save karo, follow karo @rajesh_technical_trader

#stockmarket #nifty50 #mutualfunds #sharemarket #investing #personalfinance #stockmarketindia #technicalanalysis #nse
`;
await fs.writeFile(path.join(out, 'caption.txt'), caption);
await fs.writeFile(path.join(out, 'source.md'), `# Sources — midday carousel ${date}

Generated ${istNow.slice(0, 16).replace('T', ' ')} IST by midday/build/run.mjs. Nothing published by this script.

## Charts — TradingView public page (not logged in)
- 5m: ${I.meta.url} — captured ${I.meta.capturedAt} (UTC); ${I.bars} candles; ${I.yahooCheck?.compared} matched to Yahoo ^NSEI 5m (worst ${I.yahooCheck?.worstDevPts} pt, tolerance ${I.yahooCheck?.tolerancePts}); high ${fmt(I.high.price)} @${I.high.time}, low ${fmt(I.low.price)} @${I.low.time}, open ${fmt(I.open.price)} @${I.open.time}, last ${fmt(I.close.price)} @${I.close.time} IST; range ${fmt(I.range)} (code)
- 1D: ${D.meta.url} — captured ${D.capturedAtIst} IST; bars dated by Yahoo ^NSEI match; today live ${fmt(D.T.c)} at daily capture; slides use the 5m ${I.close.time} candle ${fmt(D.livePrice)} = ${pct.toFixed(2)}% vs ${D.livePrev.date} close ${fmt(D.livePrev.c)}; open ${fmt(D.T.o)} = Yahoo open
- Levels (rule, code): support ${fmt(D.S.price)} (${D.S.date} low, lowest of 10 sessions); resistance ${fmt(D.R1.price)}${D.R2 ? `–${fmt(D.R2.price)}` : ''} (pivot highs)

## Articles
${ART.map((A, i) => `### ${i + 3}. ${A.kicker} — ${A.siteName}
- ${A.url}
- Headline: "${A.headline}"; date on page "${A.date?.text || ''}"; published ${A.metaTime}
- Highlighted: "${A.key?.text}"
- Checks: ${A.checkLine}
- OCR of the screenshot: headline ${A.ocr.headline}, key ${A.ocr.key}, date ${A.ocr.date}`).join('\n')}

## Problems
${[...problems, ...qaProblems].map((x) => `- ⚠ ${x}`).join('\n') || '- none — all code checks and layout QA passed'}
`);

// 5. package
const pkg = path.resolve(pkgRel);
await fs.rm(pkg, { recursive: true, force: true });
await fs.mkdir(path.join(pkg, 'slides'), { recursive: true });
await fs.mkdir(path.join(pkg, 'stories'), { recursive: true });
const files = []; const stories = [];
for (let n = 1; n <= NS; n += 1) {
  const f = `${String(n).padStart(2, '0')}.jpg`;
  await fs.copyFile(path.join(out, `slide-${n}.jpg`), path.join(pkg, 'slides', f)); files.push(`${pkgRel}/slides/${f}`);
  await fs.copyFile(path.join(out, `story-${f}`), path.join(pkg, 'stories', f)); stories.push(`${pkgRel}/stories/${f}`);
}
await fs.copyFile(path.join(out, 'caption.txt'), path.join(pkg, 'caption.txt'));
await fs.copyFile(path.join(out, 'source.md'), path.join(pkg, 'SOURCE.md'));
const all = [...problems, ...qaProblems];
await fs.writeFile(path.join(pkg, 'carousel-report.json'), JSON.stringify({
  spec: 'oneoff/realsource-midday', slides: NS, width: 1080, height: 1350, format: 'jpeg', files, stories,
  topic: `${dshort(date)}: market, stocks, MF, finance — real sources`, category: 'stocks', brand: 'Rajesh Technical Traders',
  generated: true, fallback: false, reviewed: true, verifiedSource: true, sourceFresh: true, publishable: all.length === 0,
  slot: 'midday', istDate: date,
  quality: { ok: all.length === 0, problems: all, checks: 'TradingView 1D/5m vs Yahoo ^NSEI; article dates = today; every printed number found in its article; computed checks; layout QA' },
  lines: [{ n: 1, headline: cfg.hook.replace(/<br>/g, ' '), subline: null, source: null },
    { n: 2, headline: `Nifty 5m: range ${fmt(I.range)} points`, subline: null, source: 'TradingView' },
    ...ART.map((A, i) => ({ n: 3 + i, headline: A.title, subline: A.plain, source: `${A.siteName} ${A.dateIso}` })),
    { n: 7, headline: 'Analysis: Nifty key levels', subline: null, source: 'TradingView' },
    { n: 8, headline: 'आज का सार', subline: null, source: null }, { n: 9, headline: 'Save · Follow', subline: null, source: null }],
}, null, 1) + '\n');
execFileSync('python3', ['-c', `
from PIL import Image
o='${out}'
ims=[Image.open(f'{o}/slide-{i}.jpg').resize((432,540)) for i in range(1,${NS + 1})]
st=[Image.open(f'{o}/story-{i:02d}.jpg').resize((304,540)) for i in (1,${NS})]
s=Image.new('RGB',(5*440,1100),'white')
for k,im in enumerate(ims): s.paste(im,((k%5)*440,(k//5)*550))
x=4*440
for k,im in enumerate(st): s.paste(im,(4*440+ (0 if k==0 else 0), 550)) if False else None
s.save(f'{o}/sheet.jpg', quality=85)
t=Image.new('RGB',(9*312,540),'white')
for k in range(1,${NS + 1}): t.paste(Image.open(f'{o}/story-{k:02d}.jpg').resize((304,540)),((k-1)*312,0))
t.save(f'{o}/story-sheet.jpg', quality=85)`]);
log(`done → ${out} (package → ${pkgRel})`);
if (all.length) { console.error(`\n${all.length} problem(s) — NOT publishable:\n  ${all.join('\n  ')}`); if (!flag('allow-problems')) process.exit(2); }
