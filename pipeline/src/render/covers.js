// Hand-made cover art, used ahead of anything a stock library can find.
//
// The reference account's pictures are generated for each fact, which is why
// they always fit; a search over Pexels cannot do that and never will. But a
// picture drawn once, by hand, for "space" or "animals" fits every space post
// forever -- so the cover slide reads from a folder of them before it reads
// from any API.
//
// Drop a file in pipeline/covers/ named after the category and it is used:
//
//   pipeline/covers/space.jpg      every space cover
//   pipeline/covers/midday.jpg     every news cover
//   pipeline/covers/default.jpg    everything with no file of its own
//
// No key, no credits, no network. A missing folder means the old behaviour,
// unchanged -- this can only ever add a picture, never remove one.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const COVERS_DIR = path.resolve(HERE, '..', '..', 'covers');

// Whatever the drawing tool exported. The renderer takes any of these and the
// slides are re-encoded to JPEG on the way out regardless.
export const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

async function firstThatExists(dir, names) {
  for (const name of names) {
    for (const ext of EXTENSIONS) {
      const file = path.join(dir, `${name}.${ext}`);
      try {
        const stat = await fs.stat(file);
        if (stat.isFile() && stat.size > 0) return file;
      } catch { /* next candidate */ }
    }
  }
  return null;
}

/**
 * The cover to use for this post, most specific first, or null for none.
 * `category` may be absent -- the news slot has a slot but no category.
 */
export async function coverFor({ category, slot, dir = COVERS_DIR } = {}) {
  const names = [category, slot, 'default'].filter(Boolean);
  if (!names.length) return null;
  return firstThatExists(dir, names);
}

/**
 * Put that cover on slide 1, if there is one and slide 1 has no picture yet.
 *
 * Deliberately only slide 1. Hand-drawn art for six slides a day, three times a
 * day, is a job nobody will keep doing; one cover per category is a job that
 * finishes. The rest of the slides go on searching as before.
 */
export async function attachCover(spec, { category, slot, dir = COVERS_DIR, onNote } = {}) {
  const slides = spec.slides || [];
  if (!slides.length || slides[0].background) return { spec, cover: null };

  const cover = await coverFor({ category, slot, dir });
  if (!cover) return { spec, cover: null };

  onNote?.(`cover: ${path.basename(cover)} (hand-made, not searched)`);
  return {
    spec: { ...spec, slides: [{ ...slides[0], background: cover }, ...slides.slice(1)] },
    cover,
  };
}
