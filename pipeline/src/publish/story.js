// Publish one image to Instagram as a Story.
//
// Two steps, not three. A story container is created with media_type=STORIES
// and then published — there is no parent, no children, and no caption: a
// story carries no text of its own through the API. Stickers, links, polls and
// mentions are not offered on this edge at all, so what goes up is the image
// and nothing else.
//
// Why bother: a carousel reaches whoever the feed decides to show it to. A
// story reaches the people who already follow the account, at the top of their
// screen, for 24 hours. With 506 followers and eleven likes a fortnight, the
// followers are the audience worth reaching.
//
// A failed story must never take a published carousel down with it. The post is
// the thing that lasts; the story is a nudge toward it. So the caller is
// expected to run this after publishing and treat a failure as a warning.
//
// UNVERIFIED, like the rest of this directory: the docs are unreachable from
// here. The stories edge answered a read (`.../stories` returned an empty list
// rather than a permission error), which says the token may see stories — it
// does not prove it may create one. The first real attempt will say.

import { call, waitForContainer } from './instagram.js';
import { env } from '../../../src/config.js';

/** Reasons to stop before the first API call. */
export function checkStory({ imageUrl }) {
  const problems = [];
  if (!imageUrl) problems.push('no image');
  else {
    if (!/^https:\/\//.test(String(imageUrl))) problems.push(`image is not a public https URL: "${String(imageUrl).slice(0, 60)}"`);
    if (/\.(png|webp|gif)(\?|$)/i.test(String(imageUrl))) problems.push('image is not JPEG — Instagram\'s image container takes JPEG only');
  }
  return problems;
}

export async function publishStory({
  igUserId = env('IG_USER_ID'),
  token = env('IG_ACCESS_TOKEN'),
  imageUrl,
  surface = env('IG_SURFACE') || undefined,
  onStatus,
}) {
  if (!igUserId) throw new Error('No IG_USER_ID. Set it in .env or pass igUserId.');
  if (!token) throw new Error('No IG_ACCESS_TOKEN. Set it in .env or pass token.');

  const problems = checkStory({ imageUrl });
  if (problems.length) throw new Error(`Refusing to publish story:\n  ${problems.join('\n  ')}`);

  const { id: containerId } = await call(`${igUserId}/media`, {
    method: 'POST', token, surface,
    params: { image_url: imageUrl, media_type: 'STORIES' },
  });
  onStatus?.('container', containerId);

  await waitForContainer({
    containerId, token, surface, pollMs: 3000, maxPolls: 20,
    onStatus: (code) => onStatus?.('processing', code),
  });

  const { id: mediaId } = await call(`${igUserId}/media_publish`, {
    method: 'POST', token, surface, params: { creation_id: containerId },
  });
  onStatus?.('published', mediaId);

  return { mediaId, containerId };
}
