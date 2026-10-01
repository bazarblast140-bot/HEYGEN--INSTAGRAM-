// The setup workflow used to upload the Page token as an Actions artifact.
// This repository is public, so any logged-in user could download that file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const WORKFLOW = new URL('../.github/workflows/setup-token.yml', import.meta.url);

test('the token setup workflow does not publish the access token', async () => {
  const text = await readFile(WORKFLOW, 'utf8');

  assert.equal(text.includes('upload-artifact'), false);
  assert.equal(text.includes('IG_ACCESS_TOKEN.txt'), false);
  assert.equal(text.includes('.slice('), false);
  assert.equal(text.includes('github.token'), false);
  assert.match(text, /add-mask/);
  assert.match(text, /SECRETS_ADMIN_TOKEN/);
  assert.match(text, /cannot create repository secrets/);
  assert.match(text, /"gh", \["secret", "set", "IG_ACCESS_TOKEN"/);
  assert.ok(
    text.indexOf('SECRETS_ADMIN_TOKEN is not set') < text.indexOf('exchangeForLongLived'),
    'the run must stop before exchanging the token when the admin PAT is missing',
  );
});
