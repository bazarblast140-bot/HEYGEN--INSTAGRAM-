// Free stock footage for the b-roll beats, so HeyGen credits are spent only on
// the few seconds where the avatar actually appears.
//
// Two providers, both free and both usable commercially:
//   Pexels  — https://www.pexels.com/api/  (free key, Pexels License)
//   Pixabay — https://pixabay.com/api/docs/ (free key, Pixabay Content License)
//
// Both licenses permit commercial use without attribution. Neither permits
// redistributing the clip as a standalone product, which a reel is not, and
// neither permits implying that a person shown endorses anything — so the script
// generator must never pair a stock face with a claim about a real person.
//
// Blocked by the network policy inside Claude Code sessions; works on Actions.

import fs from 'node:fs/promises';
import path from 'node:path';

const PEXELS = 'https://api.pexels.com/videos/search';
const PIXABAY = 'https://pixabay.com/api/videos/';

/** 9:16 is what the reel wants; anything wider gets centre-cropped downstream. */
const PREFERRED_ORIENTATION = 'portrait';

async function searchPexels(query, { limit, minDuration, apiKey }) {
  const url = `${PEXELS}?query=${encodeURIComponent(query)}&orientation=${PREFERRED_ORIENTATION}&per_page=${limit}`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(`Pexels returned ${res.status}`);

  const body = await res.json();
  return (body.videos || [])
    .filter((v) => v.duration >= minDuration)
    .map((v) => {
      // Pick the largest file that is still sane to download.
      const file = [...(v.video_files || [])]
        .filter((f) => f.file_type === 'video/mp4' && f.width && f.height)
        .sort((a, b) => b.height - a.height)
        .find((f) => f.height <= 2160);
      return file && {
        provider: 'pexels',
        id: String(v.id),
        url: file.link,
        width: file.width,
        height: file.height,
        duration: v.duration,
        credit: v.user?.name,
        pageUrl: v.url,
      };
    })
    .filter(Boolean);
}

async function searchPixabay(query, { limit, minDuration, apiKey }) {
  const url = `${PIXABAY}?key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(query)}&per_page=${Math.max(3, limit)}&video_type=film`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pixabay returned ${res.status}`);

  const body = await res.json();
  return (body.hits || [])
    .filter((h) => h.duration >= minDuration)
    .map((h) => {
      const v = h.videos?.large || h.videos?.medium;
      return v?.url && {
        provider: 'pixabay',
        id: String(h.id),
        url: v.url,
        width: v.width,
        height: v.height,
        duration: h.duration,
        credit: h.user,
        pageUrl: h.pageURL,
      };
    })
    .filter(Boolean);
}

/**
 * Search Pexels first, fall back to Pixabay. A provider that is unconfigured or
 * erroring is skipped rather than failing the run — losing one b-roll source
 * should never cost the day's post.
 */
export async function searchStock(query, {
  limit = 5,
  minDuration = 4,
  pexelsKey = process.env.PEXELS_API_KEY,
  pixabayKey = process.env.PIXABAY_API_KEY,
} = {}) {
  const attempts = [
    pexelsKey && (() => searchPexels(query, { limit, minDuration, apiKey: pexelsKey })),
    pixabayKey && (() => searchPixabay(query, { limit, minDuration, apiKey: pixabayKey })),
  ].filter(Boolean);

  if (!attempts.length) {
    throw new Error('No stock provider configured. Set PEXELS_API_KEY and/or PIXABAY_API_KEY.');
  }

  const problems = [];
  for (const attempt of attempts) {
    try {
      const results = await attempt();
      if (results.length) return results;
      problems.push('no results');
    } catch (err) {
      problems.push(err.message);
    }
  }

  throw new Error(`No stock footage for "${query}" (${problems.join('; ')})`);
}

export async function downloadClip(clip, outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, `${clip.provider}-${clip.id}.mp4`);

  const res = await fetch(clip.url);
  if (!res.ok) throw new Error(`Downloading ${clip.provider} clip ${clip.id} failed (${res.status})`);
  await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));

  return { ...clip, file };
}

/** Search, take the best match, and put it on disk. */
export async function fetchStock(query, { outDir, ...options } = {}) {
  const [best] = await searchStock(query, options);
  return downloadClip(best, outDir);
}
