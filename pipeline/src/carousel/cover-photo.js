// One photo on the carousel COVER (slide 1). Inner slides stay chart-boards.
//
// Why so strict: an earlier photo carousel put a US Form 1040 on an Indian
// finance post. A cover photo must be clearly about the topic — Indian context
// for finance (rupee notes, Indian banks and homes, NSE/BSE, Indian people and
// offices), the actual company/product/event for news and AI — and must not
// carry text or numbers of its own. So:
//
//   1. The model gives spec.coverPhoto = { queries, mustHave, avoid }. Finance
//      queries always carry "India" (appended if missing).
//   2. Search Pexels (free key), then Wikimedia Commons (no key, licence in the
//      metadata). At most 3 + 2 searches and 3 downloads per carousel.
//   3. Metadata check (alt text, page slug, Commons title/description/
//      categories): reject documents, forms, invoices, paper, screens, charts,
//      logos, foreign money/forms/places on finance; require an Indian marker
//      on finance and a must-have term on news/AI.
//   4. Visible-text check on the downloaded image with tesseract when the
//      binary is there (free, local): a photo with words or long numbers in it
//      is rejected. Without tesseract the metadata check stands alone.
//
// Never blocks a post: no key, nothing found, every candidate rejected, a
// network error — the cover keeps the v3 chart and the build goes on.

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FINANCE } from './categories.js';
import { relevance } from '../render/backgrounds.js';

const run = promisify(execFile);

export const MAX_QUERIES = 3;
export const MAX_DOWNLOADS = 3;

// Documents, paper and anything that is mostly text or numbers.
export const DOCUMENT = /\b(tax(es)?|forms?|1040|w-?2|irs|invoices?|receipts?|documents?|paperwork|papers?|letters?|certificates?|contracts?|agreements?|applications?|statements?|reports?|spreadsheets?|worksheets?|calculators?|newspapers?|books?|notebooks?|notepads?|sticky notes?|text|typography|words?|quotes?|signs?|signage|posters?|banners?|screenshots?|screens?|monitors?|charts?|graphs?|diagrams?|infographics?|maps?|logos?|icons?|illustrations?|vectors?|clip ?art|cartoons?|3d render|render|mockups?|templates?|menu|label|labels|ticket|tickets|cheques?|checks?|passport|aadhaar|pan card)\b/i;

// Foreign context that does not belong on an Indian finance cover.
export const FOREIGN = /\b(usa|u\.s\.|united states|america|american|dollars?|usd|euros?|pounds?|sterling|british|england|uk|yen|yuan|renminbi|wall street|nyse|nasdaq|london|new york|europe|european|china|chinese|japan|japanese|canada|canadian|australia|australian|germany|german|france|french|dubai|singapore|native americans?|reservation|oregon|arizona|california|texas|florida|trinidad|caribbean|west indies)\b/i;

export const INDIAN = /\b(india|indian|indians|rupees?|inr|mumbai|bombay|delhi|bengaluru|bangalore|kolkata|calcutta|chennai|hyderabad|pune|ahmedabad|jaipur|nse|bse|dalal street|sensex|nifty|desi|saree|sari|kurta|rbi|sbi|hdfc|icici)\b/i;

// Finance covers are scenes, not news photos of named people or ceremonies.
export const PEOPLE_EVENTS = /\b(president|prime minister|minister|chief minister|governor|politician|mp|mla|ceremony|inaugurat\w*|award\w*|delegation|probationers?|summit|conference|visit\w*|rally|protest|election|portrait of|meets?|meeting with|felicitat\w*)\b/i;

export const PEXELS_LICENCE = { licence: 'Pexels License', licenceUrl: 'https://www.pexels.com/license/' };
const FREE_COMMONS = /^(cc0|public domain|pd|cc[ -]by(-sa)?( \d(\.\d)?)?)/i;

const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => String(x).trim()).filter(Boolean);

/** The cover-photo request: model's queries (finance: always with India), must-have and avoid terms. */
export function photoRequest(spec) {
  const finance = FINANCE.includes(spec?.category);
  const asked = spec?.coverPhoto && typeof spec.coverPhoto === 'object' ? spec.coverPhoto : {};
  let queries = list(asked.queries).map((q) => q.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!queries.length) {
    const fallback = list(spec?.slides?.[0]?.query).filter((q) => q && q !== 'indian stock exchange');
    queries = finance ? [...fallback, 'Bombay Stock Exchange Mumbai'] : fallback;
  }
  if (finance) queries = queries.map((q) => (/\bindia(n)?\b/i.test(q) ? q : `${q} India`));
  queries = [...new Set(queries)].slice(0, MAX_QUERIES);
  return {
    finance,
    queries,
    mustHave: list(asked.mustHave).map((w) => w.toLowerCase()),
    avoid: list(asked.avoid).map((w) => w.toLowerCase()),
  };
}

const hasTerm = (text, term) => new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(s|es)?\\b`, 'i').test(text);

/**
 * Why this candidate may not be the cover, or null when it may.
 * candidate: { meta (all its text: alt, slug, title, description, categories), width, height, licence }
 */
export function rejectReason(candidate, request) {
  const meta = clean(candidate?.meta);
  if (!candidate?.image) return 'no image url';
  if (!meta) return 'no description to check it against';
  if ((candidate.width || 0) && Math.max(candidate.width, candidate.height || 0) < 900) return `too small (${candidate.width}×${candidate.height})`;
  const doc = meta.match(DOCUMENT);
  if (doc) return `looks like a document / text image ("${doc[0]}")`;
  const avoid = request.avoid.find((w) => hasTerm(meta, w));
  if (avoid) return `matches the avoid list ("${avoid}")`;
  if (request.finance) {
    const foreign = meta.match(FOREIGN);
    if (foreign) return `foreign context on an Indian finance cover ("${foreign[0]}")`;
    if (!INDIAN.test(meta)) return 'no Indian context in its description';
    const event = meta.match(PEOPLE_EVENTS);
    if (event) return `a news photo of people or an event, not a finance scene ("${event[0]}")`;
  }
  if (request.mustHave.length && !request.mustHave.some((w) => hasTerm(meta, w))) return `none of the must-have terms (${request.mustHave.join(', ')})`;
  if (!request.mustHave.length && !request.queries.some((q) => relevance(meta, q) > 0)) return 'shares no subject word with the search';
  if (candidate.licence && !candidate.licenceOk) return `licence "${candidate.licence}" is not CC0, public domain or CC BY`;
  return null;
}

/** Best first: must-have hits, Indian marker (finance), relevance to its query, then source order. */
export function rankCandidates(candidates, request) {
  return candidates
    .map((c, i) => {
      const meta = clean(c.meta);
      const score = request.mustHave.filter((w) => hasTerm(meta, w)).length
        + (request.finance && INDIAN.test(meta) ? 1 : 0)
        + Math.max(0, ...request.queries.map((q) => relevance(meta, q)))
        + ((c.height || 0) >= (c.width || 0) ? 0.2 : 0);
      return { c, i, score, reason: rejectReason(c, request) };
    })
    .sort((a, b) => (a.reason ? 1 : 0) - (b.reason ? 1 : 0) || b.score - a.score || a.i - b.i);
}

/**
 * Visible text in an image, from tesseract's TSV: confident words of 3+
 * letters and numbers of 3+ digits. null when tesseract is not installed.
 */
export function textFromTsv(tsv) {
  const words = []; const numbers = [];
  for (const line of String(tsv || '').split('\n').slice(1)) {
    const cols = line.split('\t');
    if (cols.length < 12) continue;
    const conf = Number(cols[10]); const word = cols[11].trim();
    if (!(conf >= 70) || !word) continue;
    if (/^[A-Za-z]{3,}$/.test(word)) words.push(word);
    else if (/^[₹$]?\d[\d,.]{2,}$/.test(word)) numbers.push(word);
  }
  return { words, numbers };
}

export function visibleTextReason(found) {
  if (!found) return null;
  if (found.numbers.length) return `numbers printed in the photo (${found.numbers.slice(0, 3).join(', ')})`;
  if (found.words.length >= 3) return `text in the photo (${found.words.slice(0, 4).join(' ')})`;
  return null;
}

export async function ocr(file) {
  try {
    const { stdout } = await run('tesseract', [file, 'stdout', '--psm', '11', 'tsv'], { timeout: 30000, maxBuffer: 8 << 20 });
    return textFromTsv(stdout);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
}

async function getJson(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

export async function searchPexelsPhotos(query, key) {
  const url = new URL('https://api.pexels.com/v1/search');
  url.searchParams.set('query', query); url.searchParams.set('per_page', '15'); url.searchParams.set('orientation', 'portrait');
  const { photos = [] } = await getJson(url, { headers: { Authorization: key } });
  return photos.map((p) => ({
    source: 'Pexels', id: `pexels:${p.id}`, query,
    meta: [p.alt, String(p.url || '').split('/photo/')[1]?.replace(/-\d+\/?$/, '').replace(/-/g, ' ')].filter(Boolean).join(' · '),
    alt: p.alt || '', width: p.width, height: p.height,
    image: p.src?.large2x || p.src?.portrait || p.src?.original, page: p.url,
    credit: p.photographer ? `${p.photographer} / Pexels` : 'Pexels', ...PEXELS_LICENCE, licenceOk: true,
  }));
}

export async function searchCommons(query) {
  const url = new URL('https://commons.wikimedia.org/w/api.php');
  for (const [k, v] of Object.entries({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${query} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '12',
    prop: 'imageinfo', iiprop: 'url|size|extmetadata', iiurlwidth: '1280', origin: '*',
  })) url.searchParams.set(k, v);
  const body = await getJson(url, { headers: { 'Api-User-Agent': 'RajeshTechnicalTrader-carousel/1.0 (cover photo)' } });
  return Object.values(body?.query?.pages || {}).map((p) => {
    const ii = p.imageinfo?.[0] || {}; const m = ii.extmetadata || {};
    const licence = clean(m.LicenseShortName?.value);
    return {
      source: 'Wikimedia Commons', id: `commons:${p.pageid}`, query,
      meta: [p.title?.replace(/^File:/, '').replace(/\.\w+$/, ''), clean(m.ImageDescription?.value), clean(m.Categories?.value).replace(/\|/g, ' ')].filter(Boolean).join(' · '),
      alt: clean(m.ImageDescription?.value).slice(0, 160) || p.title, width: ii.width, height: ii.height,
      image: ii.thumburl || ii.url, page: ii.descriptionurl,
      credit: `${clean(m.Artist?.value) || 'Unknown'} / Wikimedia Commons`,
      licence: licence || 'unknown', licenceUrl: clean(m.LicenseUrl?.value) || null,
      // CC0 / public domain / CC BY only: no NonCommercial, NoDerivatives or
      // ShareAlike (text over the photo is an adaptation).
      licenceOk: FREE_COMMONS.test(licence) && !/\bnc\b|non-?commercial|\bnd\b|-sa\b|sharealike/i.test(licence),
    };
  });
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'RajeshTechnicalTrader-carousel/1.0' } });
  if (!res.ok) throw new Error(`photo download ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * { spec, photo } — spec.slides[0].photo is set when a photo passed every
 * check; photo is the report record (used or not, with the reason).
 * Never throws.
 */
export async function attachCoverPhoto(spec, {
  outDir, key = process.env.PEXELS_API_KEY, onNote, search = { pexels: searchPexelsPhotos, commons: searchCommons },
  fetchFile = download, readText = ocr,
} = {}) {
  const note = (m) => onNote?.(m);
  const request = photoRequest(spec);
  const record = { used: false, queries: request.queries, mustHave: request.mustHave, avoid: request.avoid, rejected: [] };
  const done = (reason) => { record.reason = reason; note(`cover photo: ${reason} — chart cover kept`); return { spec, photo: record }; };
  try {
    if (!spec?.slides?.length) return done('no slides');
    if (!request.queries.length) return done('no photo search terms');
    const seen = new Set(); const candidates = [];
    for (const q of request.queries) {
      if (key) {
        try { candidates.push(...(await search.pexels(q, key))); } catch (err) { note(`cover photo: Pexels "${q}" failed (${String(err.message).slice(0, 60)})`); }
      }
    }
    for (const q of request.queries.slice(0, 2)) {
      try { candidates.push(...(await search.commons(q))); } catch (err) { note(`cover photo: Commons "${q}" failed (${String(err.message).slice(0, 60)})`); }
    }
    const unique = candidates.filter((c) => c?.id && !seen.has(c.id) && seen.add(c.id));
    record.searched = { pexels: Boolean(key), candidates: unique.length };
    const ranked = rankCandidates(unique, request);
    for (const r of ranked.filter((x) => x.reason).slice(0, 8)) record.rejected.push({ id: r.c.id, alt: String(r.c.alt || '').slice(0, 80), reason: r.reason });
    const passing = ranked.filter((x) => !x.reason);
    if (!passing.length) return done(unique.length ? `none of ${unique.length} candidates passed the relevance checks` : 'no candidates found');

    await fs.mkdir(outDir, { recursive: true });
    let textCheck = 'tesseract';
    for (const { c } of passing.slice(0, MAX_DOWNLOADS)) {
      const dest = path.join(outDir, `cover-photo-${String(c.id).replace(/[^\w-]/g, '_')}.jpg`);
      try {
        await fetchFile(c.image, dest);
      } catch (err) {
        record.rejected.push({ id: c.id, alt: String(c.alt || '').slice(0, 80), reason: `download failed (${String(err.message).slice(0, 40)})` });
        continue;
      }
      const found = await readText(dest);
      if (found === null) textCheck = 'unavailable (no tesseract) — metadata check only';
      const textReason = visibleTextReason(found);
      if (textReason) {
        record.rejected.push({ id: c.id, alt: String(c.alt || '').slice(0, 80), reason: textReason });
        continue;
      }
      Object.assign(record, {
        used: true, reason: null, source: c.source, page: c.page, image: c.image, licence: c.licence, licenceUrl: c.licenceUrl,
        credit: c.credit, alt: c.alt, query: c.query, file: dest, textCheck,
      });
      note(`cover photo: ${c.source} — "${String(c.alt || '').slice(0, 70)}" (${c.licence}) ${c.page}`);
      const slides = spec.slides.map((s, i) => (i === 0 ? { ...s, photo: { file: dest, credit: `Photo: ${c.credit}${/pexels/i.test(c.source) ? '' : ` · ${c.licence}`}` } } : s));
      return { spec: { ...spec, slides }, photo: record };
    }
    return done('every downloadable candidate showed text or failed to download');
  } catch (err) {
    return done(`photo step failed (${String(err.message).slice(0, 80)})`);
  }
}
