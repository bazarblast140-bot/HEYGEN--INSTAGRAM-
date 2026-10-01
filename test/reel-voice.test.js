import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveProvider } from '../pipeline/src/script/providers.js';
import { resolveVoiceProvider, synthesise, VOICE_PROVIDERS } from '../pipeline/src/presenter/voice-providers.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/script/prompt.js';
import { brollNormalise } from '../pipeline/src/assemble/timeline.js';

const TOUCHED = [
  'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'MOONSHOT_API_KEY', 'GROQ_API_KEY',
  'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'SCRIPT_API_KEY', 'SCRIPT_BASE_URL',
  'SCRIPT_PROVIDER', 'SCRIPT_MODEL', 'ELEVENLABS_API_KEY', 'HEYGEN_API_KEY',
  'VOICE_PROVIDER',
];

function withEnv(patch, fn) {
  const saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  try {
    for (const key of TOUCHED) delete process.env[key];
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('DeepSeek writes the script when its key is set, even if other keys exist', () => {
  const provider = withEnv({
    DEEPSEEK_API_KEY: 'test-deepseek',
    ANTHROPIC_API_KEY: 'test-anthropic',
    MOONSHOT_API_KEY: 'test-moonshot',
  }, () => resolveProvider());
  assert.equal(provider.name, 'deepseek');
  assert.equal(provider.baseUrl, 'https://api.deepseek.com/v1');
});

test('another script provider is optional when DeepSeek is not configured', () => {
  const provider = withEnv({ MOONSHOT_API_KEY: 'test-moonshot' }, () => resolveProvider());
  assert.equal(provider.name, 'moonshot');
});

test('the reel voice is ElevenLabs and does not require a HeyGen key', async () => {
  assert.deepEqual(VOICE_PROVIDERS.map((p) => p.name), ['elevenlabs']);
  const chosen = withEnv({
    ELEVENLABS_API_KEY: 'test-eleven',
    HEYGEN_API_KEY: 'test-heygen',
  }, () => resolveVoiceProvider());
  assert.equal(chosen.name, 'elevenlabs');

  await assert.rejects(
    () => withEnv({ HEYGEN_API_KEY: 'test-heygen' }, () => synthesise({ text: 'nifty flat' })),
    /ELEVENLABS_API_KEY/,
  );
  await assert.rejects(
    () => withEnv({
      ELEVENLABS_API_KEY: 'test-eleven',
      VOICE_PROVIDER: 'heygen',
    }, () => synthesise({ text: 'nifty flat' })),
    /not used for reels/,
  );
});

test('the reel build does not call HeyGen, and a voice failure stops the run', async () => {
  const build = await readFile('pipeline/build-reel.js', 'utf8');
  const narration = await readFile('pipeline/src/presenter/narration.js', 'utf8');
  assert.equal(/from ['"][^'"]*heygen/.test(build), false);
  assert.equal(build.includes('HEYGEN_API_KEY'), false);
  assert.equal(build.includes('renderPresenter'), false);
  assert.equal(build.includes('wantFace'), false);
  assert.match(build, /ElevenLabs narration failed/);
  assert.match(build, /This run will not publish/);
  assert.match(build, /instant: true/);
  assert.equal(/from ['"][^'"]*heygen/.test(narration), false);
  assert.match(narration, /renderNarration/);
});

test('Build reel preview uploads the film and cannot publish', async () => {
  const reel = await readFile('.github/workflows/build-reel.yml', 'utf8');
  assert.match(reel, /cron: '30 1 \* \* \*'/);
  assert.match(reel, /preview:/);
  assert.match(reel, /build-reel-preview/);
  assert.match(reel, /pipeline\/out\/reel-final\.mp4/);
  assert.match(reel, /pipeline\/out\/reel-cover\.jpg/);
  assert.match(reel, /pipeline\/out\/caption\.txt/);
  assert.match(reel, /--require-generated/);
  assert.match(reel, /Preview never publishes/);
  assert.equal(reel.includes('HEYGEN_'), false);
  assert.equal(reel.includes('heygen-doctor'), false);
  assert.equal(reel.includes('no_avatar'), false);
  const publish = reel.slice(reel.indexOf('Publish to Instagram'));
  assert.match(publish, /preview != 'true'/);
  const whoami = reel.slice(reel.indexOf('Check the Instagram token'), reel.indexOf('Build the reel'));
  assert.match(whoami, /preview != 'true'/);
});

test('the script brief asks for graphics, not an avatar', () => {
  assert.match(SYSTEM, /no avatar/);
  const text = buildUserPrompt({ market: { name: 'Nifty' }, news: [], date: '2026-10-01' });
  assert.match(text, /no person on camera/);
  assert.match(text, /#stockmarket/);
  assert.equal(/Rajesh on camera/.test(text), false);
});

test('b-roll gets a slow push-in instead of a locked frame', () => {
  const filters = brollNormalise(4);
  assert.match(filters[0], /scale=1166:2074/);
  assert.match(filters[1], /min\(1\\,t\/4\.000\)/);
});
