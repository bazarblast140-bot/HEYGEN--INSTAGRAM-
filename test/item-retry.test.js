// One flaky slide must not cost the day's post.
//
// 2026-09-10, the morning carousel: slides 1 and 2 were accepted, and slide 3
// came back "Only photo or video can be accepted as media type" in 650ms. Same
// renderer, same format, same size, same release as the two Instagram had just
// taken — a freshly uploaded asset that was not being served yet, not a verdict
// on the image. The post was abandoned and the day was gone.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createItemContainer } from '../pipeline/src/publish/carousel.js';

/** Fails the first `failures` calls with Instagram's own wording, then succeeds. */
function flaky(failures) {
  let seen = 0;
  globalThis.fetch = async () => {
    seen += 1;
    const body = seen <= failures
      ? { error: { message: 'Only photo or video can be accepted as media type.', code: 9004 } }
      : { id: 'container_ok' };
    return { ok: seen > failures, status: seen > failures ? 200 : 400, json: async () => body };
  };
  return () => seen;
}

const args = { igUserId: '1', imageUrl: 'https://example.com/03.jpg', token: 't', waitMs: 1 };

test('a slide rejected once is asked again and goes through', async () => {
  const calls = flaky(1);
  const id = await createItemContainer(args);
  assert.equal(id, 'container_ok');
  assert.equal(calls(), 2);
});

test('two rejections still resolve inside three attempts', async () => {
  const calls = flaky(2);
  assert.equal(await createItemContainer(args), 'container_ok');
  assert.equal(calls(), 3);
});

test('it gives up rather than retrying forever, and reports Instagram\'s reason', async () => {
  const calls = flaky(99);
  await assert.rejects(
    () => createItemContainer(args),
    (err) => /Only photo or video/.test(err.message),
  );
  assert.equal(calls(), 3);
});

test('each retry is reported, so a log shows a slide needed asking twice', async () => {
  flaky(1);
  const notes = [];
  await createItemContainer({ ...args, onRetry: (n, why) => notes.push(`${n}:${why}`) });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /^1:/);
  assert.match(notes[0], /Only photo or video/);
});

test('a slide taken first time is not retried', async () => {
  const calls = flaky(0);
  await createItemContainer(args);
  assert.equal(calls(), 1);
});
