// Custom cover for the Facebook Reel the companion posts (owner rule 1-Nov-2026:
// every Reel on IG/FB carries a topic cover with big Hindi (Devanagari) text,
// never an auto frame).
//
// Source order: the Paise YouTube custom thumbnail for the same video (via the
// pkp:video:<id> YouTube id) is used as the background, and a big Devanagari
// headline is always code-drawn on top, kept out of the bottom 25% (Reel UI
// safe zone). With no thumbnail the background is a plain gradient. The
// headline is Devanagari text from the caption / YouTube title; when neither
// has any, a Devanagari topic line is built from keywords (never Latin-only).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const COVER_FONT = path.resolve(HERE, '..', '..', 'assets', 'fonts-ttf', 'noto-devanagari.ttf');
export const COVER_W = 1080;
export const COVER_H = 1920;
const DEVA = /[\u0900-\u097F]/;

export function hasDevanagari(t) { return DEVA.test(String(t || '')); }

const TOPICS = [
  [/\b(q[1-4]|results?|earnings|profit)\b/i, 'तिमाही नतीजे'],
  [/\bbreak ?out\b/i, 'ब्रेकआउट ट्रेड प्लान'],
  [/\b(nifty|sensex|market close|closing)\b/i, 'आज का मार्केट'],
  [/\b(ipo)\b/i, 'IPO अपडेट'],
  [/\b(dividend)\b/i, 'डिविडेंड अपडेट'],
  [/\b(analysis|chart|technical)\b/i, 'शेयर एनालिसिस'],
  [/\b(news)\b/i, 'बड़ी खबर'],
];

function clean(t) {
  return String(t || '').replace(/#\S+/g, '').replace(/pkp:video:\S+/gi, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F]/gu, '').replace(/\s+/g, ' ').trim();
}

/** { main, sub }: main is always Devanagari, short enough for big type. */
export function coverHeadline({ caption = '', ytTitle = '' } = {}) {
  const first = clean(String(caption).split('\n').find((l) => l.trim()) || '');
  const yt = clean(ytTitle);
  const pick = [yt, first].find(hasDevanagari);
  if (pick) {
    const [main, ...rest] = pick.split(/\s*[|:]\s*/).filter(Boolean);
    return { main: main.slice(0, 60), sub: rest.join(' · ').slice(0, 60) };
  }
  const text = `${yt} ${first}`;
  const found = [];
  for (const [re, hi] of TOPICS) if (re.test(text) && !found.includes(hi)) found.push(hi);
  const main = found[0] || 'आज की बड़ी सीख';
  // A leading ticker / company word (Latin caps) stays as the sub line.
  const ticker = (text.match(/\b[A-Z][A-Z&.-]{2,15}\b/) || [])[0] || '';
  return { main, sub: [ticker, found[1]].filter(Boolean).join(' · ') };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 1080x1920 HTML; text lives in the top ~70%, bottom 25% kept clear. */
export function coverHtml({ main, sub = '', bgDataUri = '', fontSrc = '' }) {
  const size = main.length > 32 ? 104 : main.length > 18 ? 124 : 150;
  const bg = bgDataUri
    ? `url(${bgDataUri}) center/cover no-repeat`
    : 'linear-gradient(160deg,#0b3d2e 0%,#0f172a 60%,#111 100%)';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Deva;src:url('${fontSrc}');font-weight:100 900}
html,body{margin:0;width:${COVER_W}px;height:${COVER_H}px;overflow:hidden;background:#000}
.bg{position:absolute;inset:-40px;background:${bg};filter:${bgDataUri ? 'blur(3px) brightness(.6)' : 'none'}}
.box{position:absolute;left:60px;right:60px;top:260px;bottom:${Math.round(COVER_H * 0.27)}px;display:flex;flex-direction:column;justify-content:center;gap:40px}
.main{font-family:Deva;font-weight:800;font-size:${size}px;line-height:1.3;color:#fff;background:rgba(0,0,0,.55);border-left:18px solid #ffd400;padding:30px 40px;border-radius:24px;text-shadow:0 4px 12px #000}
.sub{font-family:Deva;font-weight:700;font-size:64px;line-height:1.3;color:#111;background:#ffd400;padding:16px 32px;border-radius:18px;align-self:flex-start}
</style></head><body><div class="bg"></div><div class="box"><div class="main">${esc(main)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div></body></html>`;
}

/** Render with Playwright Chromium → JPEG Buffer. */
export async function renderCover(opts) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: COVER_W, height: COVER_H } });
    const fontSrc = `data:font/ttf;base64,${fs.readFileSync(COVER_FONT).toString('base64')}`;
    await page.setContent(coverHtml({ ...opts, fontSrc }), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const ok = await page.evaluate(() => document.fonts.check('800 100px Deva', 'क'));
    if (!ok) throw new Error('Devanagari font did not load');
    return await page.screenshot({ type: 'jpeg', quality: 88 });
  } finally {
    await browser.close();
  }
}

/** YouTube custom thumbnail bytes for a video id (maxres, then hq), or null. */
export async function youtubeThumb(videoId, fetchImpl = globalThis.fetch) {
  if (!videoId) return null;
  for (const q of ['maxresdefault', 'hqdefault']) {
    try {
      const res = await fetchImpl(`https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${q}.jpg`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5000) return buf;
    } catch { /* next */ }
  }
  return null;
}

export async function youtubeTitle(videoId, fetchImpl = globalThis.fetch) {
  if (!videoId) return '';
  try {
    const res = await fetchImpl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return '';
    return String((await res.json()).title || '');
  } catch { return ''; }
}

/** Build the cover: { buffer, from, headline } or throws. */
export async function buildReelCover({ caption, yt, fetchImpl = globalThis.fetch, render = renderCover }) {
  const [ytTitle, thumb] = await Promise.all([youtubeTitle(yt, fetchImpl), youtubeThumb(yt, fetchImpl)]);
  const headline = coverHeadline({ caption, ytTitle });
  if (!hasDevanagari(headline.main)) throw new Error('cover headline has no Devanagari text');
  const bgDataUri = thumb ? `data:image/jpeg;base64,${thumb.toString('base64')}` : '';
  if (!fs.existsSync(COVER_FONT)) throw new Error('Devanagari font missing');
  const buffer = await render({ ...headline, bgDataUri });
  if (!buffer || buffer.length < 10000) throw new Error('cover render empty');
  return { buffer, from: thumb ? 'youtube-thumb+drawn-hindi' : 'drawn-hindi', headline };
}
