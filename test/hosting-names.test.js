// Two files hosted under one name is a post that cannot be published.
//
// The story is rendered by the same renderer as the slides, which names its
// output by index — so the story came out as 01.jpg, exactly like slide 1.
// hostFiles uploads by basename and deletes any asset already using that name,
// so the story replaced the first slide. The morning post died in the release
// with "DELETE .../assets/554151411 -> 404", before Instagram was ever asked.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hostFiles } from '../pipeline/src/publish/host.js';

/** Real files on disk, because upload() reads them. Contents do not matter. */
function files(...names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-'));
  return names.map((n) => {
    const f = path.join(dir, n);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    return f;
  });
}

/** A release that remembers what it holds, and answers DELETE however told. */
function fakeGitHub({ deleteStatus = 204 } = {}) {
  const uploaded = [];
  const assets = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';

    // The public URL check that upload() now makes before returning. Covered by
    // its own tests in served.test.js; here it just has to answer.
    if (url.hostname === 'example.com') {
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer };
    }

    if (method === 'DELETE') {
      if (deleteStatus === 404) return { ok: false, status: 404, json: async () => ({ message: 'Not Found' }) };
      return { ok: true, status: 204, json: async () => ({}) };
    }
    if (url.pathname.includes('/assets')) {
      const name = url.searchParams.get('name');
      uploaded.push(name);
      assets.push({ id: assets.length + 1, name });
      return { ok: true, status: 201, json: async () => ({ browser_download_url: `https://example.com/${name}` }) };
    }
    // release lookup / creation
    return { ok: true, status: 200, json: async () => ({ id: 7, assets: [...assets] }) };
  };

  return uploaded;
}

const env = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_TOKEN: 't' };

test('a slide and the story do not share an asset name', async () => {
  Object.assign(process.env, env);
  const uploaded = fakeGitHub();
  const { assets } = await hostFiles({
    files: files('slides/01.jpg', 'slides/02.jpg', 'story/story.jpg'),
    tag: 'carousel-test',
  });
  assert.equal(new Set(uploaded).size, uploaded.length, `names collided: ${uploaded.join(', ')}`);
  assert.equal(assets.length, 3);
  assert.deepEqual(uploaded, ['01.jpg', '02.jpg', 'story.jpg']);
});

test('an asset that is already gone does not end the post', async () => {
  Object.assign(process.env, env);
  fakeGitHub({ deleteStatus: 404 });
  // The release reports an asset named 01.jpg, so upload tries to clear it and
  // is told 404. That is the state it wanted.
  const [a, b] = files('a/01.jpg', 'b/01.jpg');
  const { assets } = await hostFiles({ files: [a, b], tag: 't' });
  assert.equal(assets.length, 2);
});
