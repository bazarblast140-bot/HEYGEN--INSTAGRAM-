// Pick a background photo per slide from Pexels.
//
// A carousel with no photo reads like a quote card; the reference accounts are
// photo-first and the text is a band over it. So each slide gets its own image,
// chosen from a query the spec supplies.
//
// Three things this deliberately does NOT do:
//
//   * search on the Hindi headline. Pexels indexes English, and a Devanagari
//     query returns whatever the fallback ranking coughs up. The spec carries
//     an explicit English `query` per slide instead of the code guessing a
//     translation.
//   * reuse one photo across slides. Ten identical backgrounds looks like a
//     broken render, so a photo already used in this carousel is skipped.
//   * fail the build. No key, no result, rate limit — all of it falls back to
//     the generated gradient, because a plainer carousel beats no carousel.

import fs from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../../src/config.js';

const API = 'https://api.pexels.com/v1/search';

/** Portrait crops sit better under a 4:5 slide than the landscape default. */
async function search({ query, key, perPage = 15 }) {
  const url = new URL(API);
  url.searchParams.set('query', query);
  url.searchParams.set('orientation', 'portrait');
  url.searchParams.set('per_page', String(perPage));

  const res = await fetch(url, { headers: { Authorization: key } });
  if (!res.ok) throw new Error(`Pexels ${res.status} for "${query}"`);

  const { photos = [] } = await res.json();
  return photos;
}

async function download({ url, dest }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photo download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return dest;
}

/**
 * Pick the first result this carousel has not already used.
 *
 * Ranking is Pexels' own; taking the top hit every time would be fine if the
 * queries were all different, but two slides about the same subject share a
 * query often enough that a "first unused" rule is what actually keeps the
 * carousel from repeating itself.
 */
function firstUnused(photos, used) {
  return photos.find((p) => !used.has(String(p.id)));
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

  if (!key) {
    note('no PEXELS_API_KEY — every slide falls back to the generated gradient');
    return { spec, attached: 0 };
  }

  await fs.mkdir(outDir, { recursive: true });

  const used = new Set();
  const out = [];
  let attached = 0;

  for (const [i, slide] of slides.entries()) {
    if (slide.background || !slide.query) { out.push(slide); continue; }

    try {
      const photos = await search({ query: slide.query, key });
      const photo = firstUnused(photos, used);
      if (!photo) {
        note(`no unused Pexels result for "${slide.query}" — gradient on slide ${i + 1}`);
        out.push(slide);
        continue;
      }

      used.add(String(photo.id));
      // portrait.large2x is the widest crop Pexels pre-renders tall; the slide
      // is 1080x1350, so anything smaller would upscale visibly.
      const src = photo.src?.portrait || photo.src?.large2x || photo.src?.original;
      const dest = path.join(outDir, `${String(i + 1).padStart(2, '0')}.jpg`);
      await download({ url: src, dest });

      out.push({ ...slide, background: dest, credit: photo.photographer });
      attached += 1;
    } catch (err) {
      // One slide's failure is one gradient, not a dead build.
      note(`slide ${i + 1} photo failed (${String(err.message).slice(0, 90)}) — gradient instead`);
      out.push(slide);
    }
  }

  return { spec: { ...spec, slides: out }, attached };
}
