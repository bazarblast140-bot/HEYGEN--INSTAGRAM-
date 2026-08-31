// Pictures supplied by hand, for the slides the search could not fill.
//
// Pexels and NASA fill most slides. What they cannot do is the awkward tail --
// "quantum error correction", "UPI transaction volume" -- where the honest
// answer from a stock library is nothing, and the slide falls back to a
// gradient. That is the gap this fills, and only that gap: a slide that already
// found a photo keeps it.
//
// Drop a file in pipeline/pictures/ named after the topic and it is used
// whenever a slide's search comes up empty on that topic:
//
//   pipeline/pictures/venus.jpg              matches "venus planet globe"
//   pipeline/pictures/quantum-computer.jpg   matches "quantum computer chip"
//   pipeline/pictures/default.jpg            last resort, any empty slide
//
// No key, no credits, no network. An empty folder means today's behaviour,
// unchanged -- this can only ever add a picture where there was a gradient.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PICTURES_DIR = path.resolve(HERE, '..', '..', 'pictures');

// Whatever the drawing tool exported. Slides are re-encoded to JPEG on the way
// out regardless, so the input format does not matter.
export const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

const words = (s) => String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The topic words a filename claims: "quantum-computer.jpg" -> [quantum, computer]. */
export function topicOf(filename) {
  return words(path.basename(filename, path.extname(filename)));
}

export async function listPictures(dir = PICTURES_DIR) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];                                   // no folder is not an error
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const file = path.join(dir, entry.name);
    // An empty file is a half-finished upload, not a picture.
    const { size } = await fs.stat(file);
    if (size > 0) files.push(file);
  }
  return files.sort();                           // deterministic ties
}

/**
 * The best-matching picture for one query, or null.
 *
 * Every word in the filename must appear in the query -- "venus.jpg" matches
 * "venus surface radar", "venus-surface.jpg" matches it better, and
 * "mars.jpg" does not match it at all. Requiring all of them is what stops
 * "solar-flare.jpg" landing on a slide about solar panels.
 */
export function pictureFor(query, files, { skip = new Set() } = {}) {
  const asked = new Set(words(query));
  if (!asked.size) return null;

  let best = null;
  for (const file of files) {
    if (skip.has(file)) continue;
    const topic = topicOf(file);
    if (!topic.length || topic.includes('default')) continue;
    if (!topic.every((w) => asked.has(w))) continue;
    // More words matched is a more specific picture, so it wins.
    if (!best || topic.length > best.score) best = { file, score: topic.length };
  }
  return best ? best.file : null;
}

/**
 * Put hand-supplied pictures on the slides that came back empty.
 *
 * Runs after the search, never before it: the search is still the first
 * answer, and this only reaches slides it left as a gradient. No file is used
 * twice in one carousel -- the same picture on two slides looks like a bug, and
 * a gradient is the better of the two.
 */
export async function fillGaps(spec, { dir = PICTURES_DIR, onNote } = {}) {
  const slides = spec.slides || [];
  const gaps = slides.filter((s) => !s.background);
  if (!gaps.length) return { spec, filled: 0 };

  const files = await listPictures(dir);
  if (!files.length) return { spec, filled: 0 };

  const fallback = files.filter((f) => topicOf(f).includes('default'));
  const used = new Set();
  let filled = 0;

  const out = slides.map((slide, i) => {
    if (slide.background) return slide;

    const picked = pictureFor(slide.query, files, { skip: used })
      ?? fallback.find((f) => !used.has(f))
      ?? null;
    if (!picked) return slide;

    used.add(picked);
    filled += 1;
    onNote?.(`slide ${i + 1}: ${path.basename(picked)} (given by hand — search found nothing)`);
    return { ...slide, background: picked };
  });

  return { spec: { ...spec, slides: out }, filled };
}
