#!/usr/bin/env node
// Pick TODAY's 4 articles for the midday real-source carousel and write <out>/articles.json.
//
//   node pipeline/realsource/pick.mjs [--out pipeline/out/realsource] [--date YYYY-MM-DD]
//
// 1. Publisher RSS (no keys): Mint markets/money, CNBC-TV18 market/personal-finance, ET mutual funds.
//    Only items published today (IST); stock tips / buy-sell calls are dropped.
// 2. Every candidate is opened in headless Chromium (capture-news.mjs) so we have the text that is
//    really VISIBLE on the page, plus its date line.
// 3. The script model (pipeline/src/script/providers.js) picks one article per kind — Market, Stocks,
//    Mutual Funds, Finance — and writes simple Hinglish copy using ONLY that visible text. It must
//    copy one key sentence verbatim (that is what gets highlighted).
// 4. Code re-checks everything (key sentence and every quoted string really in the visible text,
//    every number we print present in the article, lengths, one article per kind). One retry with
//    the problems listed; then exit 3 = skip the day. build.mjs repeats the checks on the final capture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { captureNews } from './lib/capture-news.mjs';
import { resolveProvider, callOpenAICompatible } from '../src/script/providers.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const istNow = new Date(Date.now() + 5.5 * 3600e3).toISOString();
const date = opt('date', istNow.slice(0, 10));
const out = path.resolve(opt('out', path.join('pipeline', 'out', 'realsource')));
const DESKTOP = { width: 1200, dpr: 2, mobile: false };
const MOBILE = { width: 480, dpr: 3, mobile: true };
export const FEEDS = [
  { site: 'Mint', url: 'https://www.livemint.com/rss/markets', capture: DESKTOP },
  { site: 'CNBC-TV18', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/market.xml', capture: MOBILE },
  { site: 'Mint', url: 'https://www.livemint.com/rss/money', capture: DESKTOP },
  { site: 'CNBC-TV18', url: 'https://www.cnbctv18.com/commonfeeds/v1/cne/rss/personal-finance.xml', capture: MOBILE },
  { site: 'Economic Times', url: 'https://economictimes.indiatimes.com/mf/rssfeeds/359241701.cms', capture: DESKTOP },
];
export const KINDS = ['Market', 'Stocks', 'Mutual Funds', 'Finance'];
// Tips, calls and live blogs are not news to explain; they never reach the post.
export const DROP = /stocks? to (buy|sell|watch)|buy or sell|top \d+ stocks|target price|multibagger|should you buy|\bbuy\b.*\bstock|live updates|live blog|horoscope/i;
const MAX_CANDIDATES = 14;

export function parseItems(xml) {
  const tag = (it, t) => { const m = new RegExp(`<${t}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${t}>`).exec(it); return m ? m[1].trim() : ''; };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => ({ title: tag(m[1], 'title').replace(/&amp;/g, '&'), link: tag(m[1], 'link'), pubDate: tag(m[1], 'pubDate') }));
}
/** IST date (YYYY-MM-DD) of an RSS pubDate; feeds without an offset are IST. */
export function istDateOf(pub) {
  const s = String(pub || '').trim();
  const t = /[+-]\d{4}$|GMT|UTC|Z$/.test(s) ? Date.parse(s) : Date.parse(`${s} +0530`);
  return Number.isNaN(t) ? null : new Date(t + 5.5 * 3600e3).toISOString().slice(0, 10);
}
const numbers = (t) => String(t || '').match(/\d[\d,]*(?:\.\d+)?/g) || [];

// Loose schema so a long field comes back as fixable feedback, not a parse failure.
export const LIMITS = { hook: 40, title: 48, coverLine: 50, plain: 170, summary: 120, captionLine: 130, contains: 60 };
export const Pick = z.object({
  hook: z.string().min(4).max(400),
  articles: z.array(z.object({
    cand: z.number().int(), kicker: z.enum(KINDS), key: z.string().min(30).max(600),
    title: z.string().min(4).max(400), coverLine: z.string().min(4).max(400), plain: z.string().min(10).max(800),
    summary: z.string().min(6).max(600), captionLine: z.string().min(6).max(600), contains: z.array(z.string().min(2).max(400)).min(2).max(4),
  })).length(4),
});

/** Problems with a model pick against the visible text of the candidates, or []. */
const norm = (x) => String(x).replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();

export function pickProblems(pick, cands) {
  const out = [];
  if (/\d/.test(pick.hook)) out.push('hook must not contain numbers');
  if (pick.hook.length > LIMITS.hook) out.push(`hook is ${pick.hook.length} chars, max ${LIMITS.hook}`);
  const kinds = new Set(pick.articles.map((a) => a.kicker));
  if (kinds.size !== 4) out.push('need exactly one article per kind: Market, Stocks, Mutual Funds, Finance');
  if (new Set(pick.articles.map((a) => a.cand)).size !== 4) out.push('the 4 articles must be 4 different candidates');
  for (const a of pick.articles) {
    const c = cands[a.cand];
    if (!c) { out.push(`cand ${a.cand} does not exist`); continue; }
    const body = norm(`${c.headline} ${c.text}`);
    if (!body.includes(norm(a.key))) out.push(`cand ${a.cand}: key sentence is not copied verbatim from the visible text`);
    if (!numbers(a.key).length) out.push(`cand ${a.cand}: key sentence has no number`);
    for (const s of a.contains) if (!body.includes(norm(s))) out.push(`cand ${a.cand}: "${s}" is not in the visible text`);
    for (const f of ['title', 'coverLine', 'plain', 'summary', 'captionLine']) if (a[f].length > LIMITS[f]) out.push(`cand ${a.cand}: ${f} is ${a[f].length} chars, max ${LIMITS[f]}`);
    for (const x of a.contains) if (x.length > LIMITS.contains) out.push(`cand ${a.cand}: contains entry is ${x.length} chars, max ${LIMITS.contains}`);
    for (const f of ['title', 'coverLine', 'plain', 'summary', 'captionLine']) {
      for (const n of numbers(String(a[f]).replace(/CNBC[- ]?TV ?18/gi, ''))) if (!body.includes(n)) out.push(`cand ${a.cand}: number ${n} in ${f} is not in the article`);
    }
  }
  return out;
}

const SYSTEM = `You write a daily Instagram carousel for @rajesh_technical_trader (Indian retail investors).
You get today's news articles (the text a reader sees on the page). Choose exactly 4: one "Market" (Nifty/Sensex/market move or market-wide news), one "Stocks" (a specific company/stock news, NOT a buy/sell tip), one "Mutual Funds" (MF/ETF/NFO/SEBI-MF news), one "Finance" (personal finance, banking, tax, RBI/SEBI regulation).
Rules: use ONLY facts written in that article's text. Never add numbers that are not in the text. No advice, no predictions, no "buy/sell".
Language: simple Hinglish — Hindi in Devanagari with common English finance words in Latin (e.g. "Nifty", "exit load", "profit"). captionLine is Hinglish in Latin script only.
Return JSON: {"hook": short Devanagari headline for the cover, no digits, max 40 chars,
 "articles":[{"cand": candidate number, "kicker": "Market"|"Stocks"|"Mutual Funds"|"Finance",
 "key": ONE sentence copied EXACTLY character-for-character from the article text, containing a number, 30-260 chars,
 "title": slide title, STRICTLY under 45 characters, "coverLine": STRICTLY under 40 characters (count them), "plain": 1-2 short sentences explaining the key fact, max 170 chars,
 "summary": one line max 120 chars ending with "(<site>)", "captionLine": Latin-script Hinglish max 130 chars,
 "contains": 2-4 short exact strings from the text (numbers with units) that prove the facts you wrote}]}`;

async function main() {
  await fs.mkdir(out, { recursive: true });
  const seen = new Set(); const pools = [];
  for (const f of FEEDS) {
    let xml = '';
    try { const r = await fetch(f.url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(20000) }); xml = r.ok ? await r.text() : ''; } catch { /* feed down */ }
    const items = parseItems(xml).filter((it) => istDateOf(it.pubDate) === date && !DROP.test(it.title) && /^https:\/\//.test(it.link) && !seen.has(it.link));
    items.forEach((it) => seen.add(it.link));
    console.log(`feed ${f.site} ${f.url}: ${items.length} today`);
    pools.push(items.map((it) => ({ ...it, site: f.site, capture: f.capture })));
  }
  const queue = [];
  for (let i = 0; queue.length < MAX_CANDIDATES && pools.some((p) => p[i]); i += 1) for (const p of pools) if (p[i] && queue.length < MAX_CANDIDATES) queue.push(p[i]);
  const cands = [];
  for (const it of queue) {
    try {
      const N = await captureNews({ out: path.join(out, 'cand', String(cands.length)), url: it.link, key: '', log: () => {}, ...it.capture });
      const pub = (N.metaTime || N.modTime || '').slice(0, 10);
      if (pub !== date) { console.log(`  skip (published ${pub}): ${it.title.slice(0, 70)}`); continue; }
      const text = String(N.bodyText || ''); const at = Math.max(0, text.indexOf(N.headline.slice(0, 40)));
      cands.push({ url: it.link, site: it.site, capture: it.capture, headline: N.headline, text: text.slice(at, at + 4000) });
    } catch (err) { console.log(`  skip (${String(err.message).slice(0, 60)}): ${it.title.slice(0, 70)}`); }
  }
  console.log(`${cands.length} candidates captured`);
  if (cands.length < 4) { console.error('fewer than 4 usable articles today — skipping'); process.exit(3); }
  const provider = resolveProvider();
  if (!provider || provider.kind === 'anthropic') { console.error('no OpenAI-compatible script model configured — skipping'); process.exit(3); }
  let user = `Today is ${date}. Candidates:\n\n${cands.map((c, i) => `### cand ${i} — ${c.site}\nHEADLINE: ${c.headline}\nTEXT: ${c.text.slice(0, 2500)}`).join('\n\n')}`;
  let pick = null; let problems = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      ({ output: pick } = await callOpenAICompatible({ provider, system: SYSTEM, user, schema: Pick }));
      problems = pickProblems(pick, cands);
    } catch (err) { problems = [String(err.message).slice(0, 300)]; pick = null; }
    await fs.writeFile(path.join(out, `pick-attempt-${attempt}.json`), `${JSON.stringify({ pick, problems }, null, 1)}\n`);
    console.log(`model attempt ${attempt}: ${problems.length ? problems.join(' | ') : 'ok'}`);
    if (!problems.length) break;
    user += `\n\nYour previous answer:\n${pick ? JSON.stringify(pick) : '(unparseable)'}\nIt was rejected:\n- ${problems.join('\n- ')}\nKeep everything else, fix exactly these (use only numbers printed in that candidate's TEXT), and send the full JSON again.`;
  }
  if (problems.length) { console.error('model pick failed the checks 3 times — skipping'); process.exit(3); }
  const articles = KINDS.map((k) => pick.articles.find((a) => a.kicker === k)).map((a) => {
    const c = cands[a.cand];
    return {
      id: a.kicker.toLowerCase().replace(/\s+/g, '-'), kicker: a.kicker, siteName: c.site, url: c.url, key: a.key, capture: c.capture,
      title: a.title, coverLine: a.coverLine, plain: a.plain, summary: a.summary, captionLine: a.captionLine,
      checks: [{ type: 'contains', all: a.contains }],
    };
  });
  const cfg = { hook: `${pick.hook}<br>4 ख़बरें, 1 असली chart`, articles, pickedAt: new Date().toISOString(), model: provider.model };
  await fs.writeFile(path.join(out, 'articles.json'), `${JSON.stringify(cfg, null, 1)}\n`);
  console.log(`articles.json: ${articles.map((a) => `${a.kicker}: ${a.siteName}`).join(' · ')}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e.message); process.exit(3); });
