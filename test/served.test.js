// A URL that exists is not yet a URL that serves.
//
// GitHub accepting an upload and GitHub serving the download are seconds apart,
// and Instagram is handed the URL in between. It fetches, gets whatever stands
// in for the file until it is ready, and replies "Only photo or video can be
// accepted as media type" — a verdict on the image, for a problem with timing.
// Measured 2026-09-10 on a brand-new release: slide 1 refused once then taken,
// slide 2 refused three times and the post lost.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { waitUntilServed } from '../pipeline/src/publish/host.js';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]).buffer;
const HTML = new TextEncoder().encode('<!doctype html><title>Not Found').buffer;

/** Answers `before` times as the asset is not ready, then serves the image. */
function serving(before, { body = JPEG, notReady = { status: 404 } } = {}) {
  let seen = 0;
  globalThis.fetch = async () => {
    seen += 1;
    const ready = seen > before;
    return {
      ok: ready,
      status: ready ? 200 : notReady.status,
      arrayBuffer: async () => body,
    };
  };
  return () => seen;
}

const fast = { waitMs: 1 };

test('it waits for the asset instead of handing Instagram a 404', async () => {
  const calls = serving(3);
  const { attempts } = await waitUntilServed('https://example.com/03.jpg', fast);
  assert.equal(attempts, 4);
  assert.equal(calls(), 4);
});

test('an asset already serving is not waited on', async () => {
  const calls = serving(0);
  await waitUntilServed('https://example.com/01.jpg', fast);
  assert.equal(calls(), 1);
});

test('a 200 carrying a web page instead of a JPEG does not count as served', async () => {
  serving(0, { body: HTML });
  await assert.rejects(
    () => waitUntilServed('https://example.com/03.jpg', { ...fast, attempts: 2 }),
    (err) => /still not being served/.test(err.message) && /not a JPEG/.test(err.message),
  );
});

test('octet-stream is accepted, because GitHub serves every asset that way', async () => {
  // The releases behind the posts of 8 and 9 September answer
  // application/octet-stream, and both published. Requiring image/* here
  // rejected a good file eight times and cost a run.
  const calls = serving(0);
  await waitUntilServed('https://example.com/01.jpg', fast);
  assert.equal(calls(), 1);
});

test('it gives up with the last thing the URL said', async () => {
  serving(99, { notReady: { status: 502 } });
  await assert.rejects(
    () => waitUntilServed('https://example.com/03.jpg', { ...fast, attempts: 3 }),
    (err) => /502/.test(err.message) && /after 3 tries/.test(err.message),
  );
});

test('a network error is survived, not thrown', async () => {
  let seen = 0;
  globalThis.fetch = async () => {
    seen += 1;
    if (seen === 1) throw new Error('ECONNRESET');
    return { ok: true, status: 200, arrayBuffer: async () => JPEG };
  };
  const { attempts } = await waitUntilServed('https://example.com/01.jpg', fast);
  assert.equal(attempts, 2);
});
