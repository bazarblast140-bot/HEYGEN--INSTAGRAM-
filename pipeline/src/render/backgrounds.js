// Pick a background photo per slide.
//
// A carousel with no photo reads like a quote card; the reference accounts are
// photo-first and the text is a band over it. So each slide gets its own image,
// chosen from a query the spec supplies.
//
// Two sources, in order:
//
//   NASA's image library, for anything about space. It needs no key, it is
//   public domain, and for "venus" it returns Venus — where a stock library
//   returns a purple blur that a photographer tagged "venus". The first live
//   carousel made that difference obvious: the Venus slide was an empty
//   gradient-looking smear and the Jupiter slide was a solar-system diagram
//   with Jupiter three pixels wide at the edge.
//
//   Pexels for everything else, which is most categories.
//
// Three things this deliberately does NOT do:
//
//   * search on the Hindi headline. Neither library indexes Devanagari, and a
//     Hindi query returns whatever the fallback ranking coughs up. The spec
//     carries an explicit English `query` per slide.
//   * reuse one photo across slides. Ten identical backgrounds looks like a
//     broken render, so a photo already used in this carousel is skipped.
//   * fail the build. No key, no result, rate limit, a source that is down —
//     all of it falls back to the generated gradient, because a plainer
//     carousel beats no carousel.

import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../../src/config.js';

const PEXELS = 'https://api.pexels.com/v1/search';
const NASA = 'https://images-api.nasa.gov';

/**
 * Queries NASA can answer better than a stock library can.
 *
 * Deliberately narrow: NASA has photographs of these things, and for anything
 * else its library is press conferences, logos and mission patches — worse than
 * Pexels, not better.
 */
const SPACE = /\b(planet|mercury|venus|earth|mars|jupiter|saturn|uranus|neptune|pluto|moon|lunar|sun|solar|star|galaxy|nebula|milky\s?way|comet|asteroid|meteor|space|orbit|spacecraft|satellite|rocket|launch|astronaut|telescope|hubble|webb|apollo|iss|eclipse|aurora)\b/i;

/**
 * Words a filler photo uses about itself.
 *
 * A PENALTY, not a rule -- and that distinction cost two slides. As a hard
 * filter this dropped every hummingbird photo Pexels had, because a stock
 * photographer describes a perfectly good bird as "hummingbird hovering near a
 * flower, blurred background". Blurred background is what a good photograph of
 * a small animal looks like. The post went out with two empty gradients.
 *
 * So these words push a candidate down and no further. A photo that is ONLY
 * these words still loses, because it has nothing else to score with.
 */
const FILLER = /\b(abstract|blur|blurred|bokeh|wallpaper|backdrop|background|texture|pattern|gradient|copy\s?space|mockup)\b/i;

/**
 * Titles where the subject is in the picture by accident.
 *
 * NASA's library is a working archive, so a search for "venus" returns the
 * planet and also a shuttle sunset with Venus as a dot near the horizon. Both
 * are about Venus. Only one is a picture of it.
 *
 * The second half of this list is the stock-library version of the same trap,
 * and it also reached the feed: a slide about butterflies got "feet in
 * butterfly socks next to sneakers". The word matched; the picture was socks.
 * On an account whose slides name an animal, a photograph of a person wearing
 * one, or a drawing of one, is not the animal.
 */
const INCIDENTAL = /\b(sunset|sunrise|crew|astronauts?|briefing|conference|patch|logo|signage|artist|concept|illustration|diagram|technicians?|ceremony|anniversary|award|interview|visitors?|employees?|person|people|woman|women|man|men|girl|boy|couple|hands?|feet|foot|socks|shoes|sneakers|shirt|clothing|fashion|costume|toy|plush|tattoo|drawing|painting|sculpture|statue|cartoon)\b/i;

const words = (s) => String(s || '').toLowerCase().match(/[a-z]{3,}/g) || [];

/**
 * How much is this photo ABOUT what was asked?
 *
 * Counting shared words is not enough, and the first live run showed why: for
 * "venus planet" it chose "STS-30 sunset with Venus near the center of the
 * frame" over an actual photograph of the planet. Both contain "venus" once.
 *
 * So two things are measured instead. Density -- how much of the title is the
 * subject rather than surrounding circumstance -- and position, because a title
 * that OPENS with the subject ("Venus - Global View") is almost always a picture
 * of it, while one that mentions it in passing puts it late.
 */
export function relevance(alt, query) {
  const asked = new Set(words(query));
  const said = words(alt);
  if (!asked.size || !said.length) return 0;

  const matches = said.filter((w) => asked.has(w)).length;
  if (!matches) return 0;

  const density = matches / said.length;
  const leads = said.slice(0, 3).some((w) => asked.has(w)) ? 1 : 0;
  const incidental = INCIDENTAL.test(alt) ? 0.5 : 0;
  const filler = FILLER.test(alt) ? 0.4 : 0;

  return leads + density - incidental - filler;
}

/**
 * Rank candidates: junk out, on-topic first, source order breaking ties.
 *
 * `used` is per-carousel, so the same photo cannot appear on two slides even
 * when two slides share a query.
 */
export function bestPhoto(candidates, { query, used }) {
  const fresh = candidates.filter((c) => !used.has(String(c.id)));
  const scored = fresh.map((c, i) => ({ c, i, score: relevance(c.alt, query) }));

  // First choice: something that actually names the subject.
  const onTopic = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  if (onTopic.length) return onTopic[0].c;

  // Second choice: a photo the library did not describe at all. Pexels often
  // gives no useful alt text, and a silent photo is not a bad one -- the
  // library ranked it first for this query for some reason.
  const neutral = scored.find((s) => !FILLER.test(s.c.alt || ''));
  return neutral ? neutral.c : null;
}

async function json(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json();
}

/** Portrait crops sit better under a 4:5 slide than the landscape default. */
async function searchPexels({ query, key, perPage = 20 }) {
  const url = new URL(PEXELS);
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('per_page', String(perPage));

  const { photos = [] } = await json(url, { headers: { Authorization: key } });
  return photos.map((p) => ({
    id: p.id,
    alt: p.alt,
    credit: p.photographer,
    src: p.src?.portrait || p.src?.large2x || p.src?.original,
  }));
}

/**
 * NASA search returns metadata; the picture itself lives in a second call.
 *
 * The asset list holds the same image at several sizes. ~orig is often 20MB of
 * a raw instrument frame, so it is the last choice, not the first.
 */
async function searchNasa({ query, limit = 24 }) {
  const url = new URL(`${NASA}/search`);
  url.searchParams.set('q', query);
  url.searchParams.set('media_type', 'image');

  const { collection } = await json(url);
  return (collection?.items || []).slice(0, limit).map((item) => {
    const meta = item.data?.[0] || {};
    return {
      id: meta.nasa_id,
      alt: [meta.title, meta.keywords?.join(' ')].filter(Boolean).join(' '),
      credit: meta.center ? `NASA/${meta.center}` : 'NASA',
      nasaId: meta.nasa_id,
    };
  }).filter((c) => c.id);
}

async function nasaAsset(nasaId) {
  const { collection } = await json(`${NASA}/asset/${encodeURIComponent(nasaId)}`);
  const hrefs = (collection?.items || []).map((i) => i.href).filter((h) => /\.jpe?g$/i.test(h));
  const pick = (suffix) => hrefs.find((h) => h.includes(suffix));
  const chosen = pick('~large') || pick('~medium') || pick('~orig') || hrefs[0];
  if (!chosen) throw new Error(`no jpeg asset for ${nasaId}`);
  return chosen.replace(/^http:/, 'https:');
}

async function download({ url, dest }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo download ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Fills in `background` on any slide that has a `query` and no background yet.
 *
 * Mutates a copy — the spec on disk is left alone, so a re-run starts from the
 * same input rather than from the last run's downloaded paths. Returns the new
 * spec plus a count, and reports every skip through `onNote` rather than
 * throwing: a carousel with three photos and three gradients still posts.
 */
export async function attachBackgrounds(spec, { outDir, key = env('PEXELS_API_KEY'), onNote } = {}) {
  const slides = spec.slides || [];
  const note = (msg) => onNote?.(msg);

  await fs.mkdir(outDir, { recursive: true });

  const used = new Set();
  const out = [];
  let attached = 0;

  for (const [i, slide] of slides.entries()) {
    if (slide.background || !slide.query) { out.push(slide); continue; }
    const n = i + 1;

    try {
      let chosen = null;
      let source = null;

      if (SPACE.test(slide.query)) {
        try {
          chosen = bestPhoto(await searchNasa({ query: slide.query }), { query: slide.query, used });
          if (chosen) {
            chosen = { ...chosen, src: await nasaAsset(chosen.nasaId) };
            source = 'NASA';
          }
        } catch (err) {
          note(`NASA had nothing for "${slide.query}" (${String(err.message).slice(0, 60)})`);
        }
      }

      if (!chosen && key) {
        chosen = bestPhoto(await searchPexels({ query: slide.query, key }), { query: slide.query, used });
        source = 'Pexels';
      }

      if (!chosen) {
        note(key
          ? `nothing usable for "${slide.query}" — gradient on slide ${n}`
          : 'no PEXELS_API_KEY — gradient behind every non-space slide');
        out.push(slide);
        continue;
      }

      used.add(String(chosen.id));
      const dest = path.join(outDir, `${String(n).padStart(2, '0')}.jpg`);
      await download({ url: chosen.src, dest });

      note(`slide ${n}: ${source} — ${String(chosen.alt || '').slice(0, 60)}`);
      out.push({ ...slide, background: dest, credit: chosen.credit });
      attached += 1;
    } catch (err) {
      // One slide's failure is one gradient, not a dead build.
      note(`slide ${n} photo failed (${String(err.message).slice(0, 90)}) — gradient instead`);
      out.push(slide);
    }
  }

  return { spec: { ...spec, slides: out }, attached };
}
