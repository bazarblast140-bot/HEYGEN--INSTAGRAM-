// The scheduler exists because GitHub's cron delivered the morning post seven
// hours late, by which point it was not the morning post. Three things have to
// line up for it to work, and none of them fails loudly on its own.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker, { SLOTS, dispatch } from '../scheduler/src/worker.js';

const read = (p) => readFile(new URL(p, import.meta.url), 'utf8');
const crons = (text) => [...text.matchAll(/["'](\d[^"']*\*[^"']*)["']/g)].map((m) => m[1]);

test('the Worker fires one cron per slot', () => {
  assert.deepEqual([...new Set(Object.values(SLOTS))].sort(), ['evening', 'midday', 'morning']);
  assert.equal(Object.keys(SLOTS).length, 3);
});

// A cron in wrangler.toml with no entry in SLOTS fires nothing.
test('wrangler.toml and the Worker schedule the same times', async () => {
  const configured = crons(await read('../scheduler/wrangler.toml'));
  assert.deepEqual(configured.sort(), Object.keys(SLOTS).sort());
});

// The Worker says "carousel"; if the workflow listens for anything else the
// dispatch is accepted by GitHub and simply starts nothing.
test('the workflow listens for the event the Worker sends', async () => {
  const wf = await read('../.github/workflows/carousel.yml');
  assert.match(wf, /repository_dispatch:\s*\n\s*types:\s*\[carousel\]/);
});

test('the dispatch names its slot in the payload', async () => {
  let seen = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen = { url, init };
    return { ok: true, status: 204, text: async () => '' };
  };

  try {
    const status = await dispatch({ repo: 'owner/repo', token: 'tok', slot: 'morning' });
    assert.equal(status, 204);
    assert.equal(seen.url, 'https://api.github.com/repos/owner/repo/dispatches');
    assert.equal(seen.init.method, 'POST');
    assert.equal(JSON.parse(seen.init.body).event_type, 'carousel');
    assert.equal(JSON.parse(seen.init.body).client_payload.slot, 'morning');
    // GitHub rejects a call with no User-Agent, and the error reads like auth.
    assert.ok(seen.init.headers['User-Agent']);
    assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a refused dispatch is an error, not a silent no-op', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Bad credentials' });
  try {
    await assert.rejects(
      () => dispatch({ repo: 'owner/repo', token: 'bad', slot: 'morning' }),
      /401.*Bad credentials/s,
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an unmapped cron throws rather than firing nothing', async () => {
  await assert.rejects(
    () => worker.scheduled({ cron: '0 3 * * *' }, { REPO: 'o/r', GITHUB_TOKEN: 't' }),
    /No slot mapped/,
  );
});
