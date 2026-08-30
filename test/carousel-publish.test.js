// The carousel publish flow, checked without touching Instagram.
//
// What is worth testing here is not "does fetch work" but the three things that
// are silently wrong rather than loudly broken: a caption attached to the child
// instead of the parent (post goes out with no text), children sent in the wrong
// order (slides shuffled on the feed), and a PNG hosted as if it were postable.
// None of those throw; they just produce a bad post that has to be deleted by
// hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkCarousel, publishCarousel } from '../pipeline/src/publish/carousel.js';
import { contentTypeFor } from '../pipeline/src/publish/host.js';

/** Records every Graph call and answers with the minimum each step needs. */
function fakeGraph() {
  const calls = [];
  let n = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const params = init.body
      ? Object.fromEntries(new URLSearchParams(String(init.body)))
      : Object.fromEntries(url.searchParams);
    calls.push({ path: url.pathname, method: init.method || 'GET', params });

    const body = url.pathname.endsWith('/media_publish')
      ? { id: 'media_published' }
      : (params.fields ? { status_code: 'FINISHED' } : { id: `c${(n += 1)}` });

    return { ok: true, json: async () => body };
  };

  return calls;
}

const urls = [1, 2, 3].map((i) => `https://example.com/0${i}.jpg`);

test('the caption goes on the parent container, never on a child', async () => {
  const original = globalThis.fetch;
  const calls = fakeGraph();
  try {
    await publishCarousel({ igUserId: '178', token: 't', imageUrls: urls, caption: 'नमस्ते' });
  } finally { globalThis.fetch = original; }

  const items = calls.filter((c) => c.params.is_carousel_item === 'true');
  assert.equal(items.length, 3);
  for (const item of items) assert.equal(item.params.caption, undefined);

  const parent = calls.find((c) => c.params.media_type === 'CAROUSEL');
  assert.equal(parent.params.caption, 'नमस्ते');
});

test('children are sent in slide order, and only the parent is published', async () => {
  const original = globalThis.fetch;
  const calls = fakeGraph();
  let result;
  try {
    result = await publishCarousel({ igUserId: '178', token: 't', imageUrls: urls, caption: '' });
  } finally { globalThis.fetch = original; }

  const parent = calls.find((c) => c.params.media_type === 'CAROUSEL');
  assert.equal(parent.params.children, 'c1,c2,c3');

  const published = calls.filter((c) => c.path.endsWith('/media_publish'));
  assert.equal(published.length, 1);
  assert.equal(published[0].params.creation_id, result.containerId);
  assert.equal(result.mediaId, 'media_published');
});

test('it waits for the container before publishing', async () => {
  const original = globalThis.fetch;
  const calls = fakeGraph();
  try {
    await publishCarousel({ igUserId: '178', token: 't', imageUrls: urls });
  } finally { globalThis.fetch = original; }

  const statusAt = calls.findIndex((c) => c.params.fields?.includes('status_code'));
  const publishAt = calls.findIndex((c) => c.path.endsWith('/media_publish'));
  assert.ok(statusAt !== -1 && statusAt < publishAt, 'status was never checked before publishing');
});

test('a bad set of images is refused before any container exists', () => {
  assert.match(checkCarousel({ imageUrls: ['https://a/1.jpg'] }).join(), /at least 2/);
  assert.match(checkCarousel({ imageUrls: Array(11).fill('https://a/1.jpg') }).join(), /allows 10/);
  assert.match(checkCarousel({ imageUrls: ['http://a/1.jpg', 'https://a/2.jpg'] }).join(), /public https/);
  assert.match(checkCarousel({ imageUrls: ['https://a/1.png', 'https://a/2.png'] }).join(), /JPEG/);
  assert.match(checkCarousel({ imageUrls: urls, caption: 'क'.repeat(2201) }).join(), /2200/);
  assert.deepEqual(checkCarousel({ imageUrls: urls, caption: 'fine' }), []);
});

test('no container is created when the check fails', async () => {
  const original = globalThis.fetch;
  const calls = fakeGraph();
  try {
    await assert.rejects(
      publishCarousel({ igUserId: '178', token: 't', imageUrls: ['https://a/1.png', 'https://a/2.png'] }),
      /JPEG/,
    );
  } finally { globalThis.fetch = original; }
  assert.deepEqual(calls, []);
});

// The bug this exists for: host.js uploaded everything as video/mp4, and GitHub
// serves an asset back under the type it was uploaded with. Instagram reads the
// header, not the extension, so a JPEG announced as a video is rejected with an
// error about unsupported media.
test('each file is hosted under its own content type', () => {
  assert.equal(contentTypeFor('out/slides/01.jpg'), 'image/jpeg');
  assert.equal(contentTypeFor('out/reel.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('OUT/01.JPEG'), 'image/jpeg');
  assert.throws(() => contentTypeFor('out/slides/01.svg'), /No Content-Type known/);
});
