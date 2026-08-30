// Publish a carousel (2–10 images) to Instagram.
//
// A carousel is NOT the reel flow with more files. It is three steps where the
// reel has two:
//
//   1. one container per image, each created with is_carousel_item=true.
//      An item container carries no caption — a caption on it is accepted and
//      then silently dropped, which is how a post ends up with no text.
//   2. one parent container, media_type=CAROUSEL, children=<the ids, comma
//      separated, in order>. The caption belongs here and nowhere else.
//   3. publish the parent. The children are never published themselves; doing
//      so posts six separate images to the feed, and they cannot be un-posted.
//
// Order is the children list's order, not the order the containers were made
// in, so the array is built by index rather than by whatever finishes first.
//
// UNVERIFIED, same as the reel path: the docs are unreachable from here, so
// field names are inferred and every failure prints the URL it called.

import { call, waitForContainer } from './instagram.js';
import { env } from '../../../src/config.js';

/** Instagram's own limits, checked here so a bad spec fails before anything is created. */
export const MIN_ITEMS = 2;
export const MAX_ITEMS = 10;
export const MAX_CAPTION = 2200;

/**
 * Reasons to stop before the first API call.
 *
 * Every one of these is something Instagram would also reject — but it would
 * reject it halfway through, after some containers exist, and a half-built
 * carousel is not obviously distinguishable from a working one until the
 * publish step fails.
 */
export function checkCarousel({ imageUrls, caption }) {
  const problems = [];

  if (imageUrls.length < MIN_ITEMS) problems.push(`${imageUrls.length} image(s) — a carousel needs at least ${MIN_ITEMS}`);
  if (imageUrls.length > MAX_ITEMS) problems.push(`${imageUrls.length} images — Instagram allows ${MAX_ITEMS}`);

  imageUrls.forEach((url, i) => {
    if (!/^https:\/\//.test(url)) problems.push(`image ${i + 1} is not a public https URL: "${String(url).slice(0, 60)}"`);
  });

  // Instagram's image endpoint takes JPEG. A PNG is fetched, refused, and the
  // error names the media rather than the format.
  const notJpeg = imageUrls.filter((u) => /\.(png|webp|gif)(\?|$)/i.test(u));
  if (notJpeg.length) problems.push(`${notJpeg.length} image(s) are not JPEG — Instagram's image container takes JPEG only`);

  if (caption && caption.length > MAX_CAPTION) {
    problems.push(`caption is ${caption.length} characters — the limit is ${MAX_CAPTION}`);
  }

  return problems;
}

/** Step 1 — one container per image. No caption here; it goes on the parent. */
export async function createItemContainer({ igUserId, imageUrl, token, surface }) {
  const { id } = await call(`${igUserId}/media`, {
    method: 'POST', token, surface,
    params: { image_url: imageUrl, is_carousel_item: 'true' },
  });
  return id;
}

/** Step 2 — the parent that ties the children together, in order. */
export async function createCarouselContainer({ igUserId, children, caption, token, surface }) {
  const { id } = await call(`${igUserId}/media`, {
    method: 'POST', token, surface,
    params: {
      media_type: 'CAROUSEL',
      children: children.join(','),
      ...(caption ? { caption } : {}),
    },
  });
  return id;
}

export async function publishCarousel({
  igUserId = env('IG_USER_ID'),
  token = env('IG_ACCESS_TOKEN'),
  imageUrls,
  caption = '',
  surface = env('IG_SURFACE') || undefined,
  onStatus,
}) {
  if (!igUserId) throw new Error('No IG_USER_ID. Set it in .env or pass igUserId.');
  if (!token) throw new Error('No IG_ACCESS_TOKEN. Set it in .env or pass token.');

  const problems = checkCarousel({ imageUrls, caption });
  if (problems.length) throw new Error(`Refusing to publish:\n  ${problems.join('\n  ')}`);

  // Sequential, and indexed. Order on the feed is this array's order.
  const children = [];
  for (const [i, imageUrl] of imageUrls.entries()) {
    children.push(await createItemContainer({ igUserId, imageUrl, token, surface }));
    onStatus?.('item', `${i + 1}/${imageUrls.length} ${children.at(-1)}`);
  }

  const containerId = await createCarouselContainer({ igUserId, children, caption, token, surface });
  onStatus?.('container', containerId);

  // Images finish far faster than video, but "far faster" is not "immediately":
  // Instagram still downloads each file, and publishing a container that is not
  // FINISHED fails. Polling costs a few seconds and removes the race.
  await waitForContainer({
    containerId, token, surface, pollMs: 3000, maxPolls: 20,
    onStatus: (code) => onStatus?.('processing', code),
  });

  const { id: mediaId } = await call(`${igUserId}/media_publish`, {
    method: 'POST', token, surface, params: { creation_id: containerId },
  });
  onStatus?.('published', mediaId);

  return { mediaId, containerId, children };
}
