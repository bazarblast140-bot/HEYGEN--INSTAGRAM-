import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { openAiChatBody, describeProviderFailure, shouldRetryProviderError } from '../pipeline/src/script/providers.js';
import { JSON_RESPONSE_LINE } from '../pipeline/src/script/json-mode.js';
import { SYSTEM as reelSystem, buildUserPrompt as reelPrompt } from '../pipeline/src/script/prompt.js';
import { SYSTEM as financeSystem, buildUserPrompt as financePrompt } from '../pipeline/src/carousel/prompt.js';
import { SYSTEM as newsSystem, buildUserPrompt as newsPrompt } from '../pipeline/src/carousel/news-prompt.js';
import { SYSTEM as sourcedSystem, buildSourcedPrompt } from '../pipeline/src/carousel/sourced-prompt.js';
import {
  classifyFailure, isPreviewRun, alreadyPublished, rerunDecision,
} from '../pipeline/classify-failure.js';

const deepseek = { name: 'deepseek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };

test('every json_object request contains the word json', () => {
  const prompts = [
    { system: reelSystem, user: reelPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' }) },
    { system: financeSystem, user: financePrompt({ category: 'fundamentals', date: '2026-10-01' }) },
    { system: newsSystem, user: newsPrompt({ stories: [{ title: 'Chip', site: 'Reuters', date: '2026-10-01' }], date: '2026-10-01' }) },
    { system: sourcedSystem, user: buildSourcedPrompt({ kind: 'ai', stories: [{ title: 'Model', site: 'OpenAI', date: '2026-10-01' }], date: '2026-10-01' }) },
    { system: 'Write a carousel.', user: 'No format word here.' },
  ];
  for (const prompt of prompts) {
    const body = openAiChatBody({ provider: deepseek, ...prompt });
    assert.equal(body.response_format.type, 'json_object');
    const blob = body.messages.map((message) => message.content).join('\n');
    assert.match(blob, /json/);
    assert.match(blob, /Respond only in valid JSON/);
  }
  assert.match(JSON_RESPONSE_LINE, /json/);
  assert.equal(openAiChatBody({ provider: deepseek, system: 'x', user: 'y' }).thinking.type, 'disabled');
});

test('a DeepSeek HTTP 400 request problem is not retried', () => {
  const failure = describeProviderFailure({
    name: 'deepseek',
    status: 400,
    detail: "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'",
  });
  assert.equal(failure.kind, 'request');
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /HTTP 400/);
  assert.match(failure.message, /request problem/);
  assert.equal(shouldRetryProviderError({
    retryable: failure.retryable,
    httpStatus: 400,
    message: failure.message,
  }), false);
  assert.equal(shouldRetryProviderError({
    httpStatus: 400,
    message: failure.message,
  }), false);
  assert.equal(shouldRetryProviderError({
    retryable: true,
    httpStatus: 200,
    message: 'deepseek HTTP 200: parsing problem — segments missing',
  }), true);
});

test('the generator loops stop on a non-retryable provider error', async () => {
  for (const file of [
    'pipeline/src/script/generate.js',
    'pipeline/src/carousel/generate.js',
    'pipeline/src/carousel/sourced.js',
  ]) {
    const text = await readFile(file, 'utf8');
    assert.match(text, /shouldRetryProviderError\(err\)/, file);
  }
});

const deepseek400 = "deepseek HTTP 400: request problem — Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'";

test('a permanent HTTP 400 is code_or_request, not a network blip', () => {
  assert.equal(classifyFailure(deepseek400), 'code_or_request');
  assert.equal(classifyFailure('social network report 15021\nfetch something later'), 'unknown');
  assert.equal(classifyFailure('socket hang up while calling the API'), 'transient_network');
  assert.equal(classifyFailure('upstream HTTP 503'), 'transient_network');
  assert.equal(classifyFailure('upstream HTTP 429'), 'transient_network');
  assert.equal(classifyFailure(`${deepseek400}\nfetch failed`), 'code_or_request');
});

test('preview runs and already-published runs are not rerun', () => {
  assert.equal(isPreviewRun({ inputs: { preview: 'true' } }), true);
  assert.equal(isPreviewRun({ title: 'Build carousel', log: 'preview: true\nslot: ai' }), true);
  assert.equal(isPreviewRun({ event: 'schedule', title: 'Build carousel', log: 'slot: evening' }), false);
  assert.equal(alreadyPublished('published 1784140001'), true);
  assert.equal(alreadyPublished('published: 1784140001'), true);
  assert.equal(alreadyPublished('nothing published — rendering and posting are separate'), false);

  assert.deepEqual(
    rerunDecision({ kind: 'code_or_request', log: deepseek400, attempt: 1 }),
    { rerun: false, reason: 'code_or_request' },
  );
  assert.deepEqual(
    rerunDecision({ kind: 'transient_network', preview: true, attempt: 1 }),
    { rerun: false, reason: 'preview' },
  );
  assert.deepEqual(
    rerunDecision({ kind: 'transient_network', log: 'published: 1784140001', attempt: 1 }),
    { rerun: false, reason: 'already-published' },
  );
  assert.equal(rerunDecision({ kind: 'transient_network', attempt: 1 }).rerun, true);
});

test('the auto-fix workflow does not treat the classification echo as a command', async () => {
  const yml = await readFile('.github/workflows/auto-fix-agent.yml', 'utf8');
  assert.equal(yml.includes('\\`$KIND\\`'), false);
  assert.match(yml, /printf '### Classification: `%s`\\n'/);
  assert.match(yml, /classify-failure\.js/);
  assert.match(yml, /Preview run — not rerunning/);
  assert.equal(/429\|503\|502\|fetch failed\|network/.test(yml), false);
  const reel = await readFile('.github/workflows/build-reel.yml', 'utf8');
  assert.match(reel, /cron: '30 1 \* \* \*'/);
});
