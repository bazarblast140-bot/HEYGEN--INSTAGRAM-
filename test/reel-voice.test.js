import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { resolveProvider } from '../pipeline/src/script/providers.js';
import * as voiceProviders from '../pipeline/src/presenter/voice-providers.js';
import { ELEVEN, REEL_VOICE_ID } from '../src/config.js';
import { SYSTEM, buildUserPrompt } from '../pipeline/src/script/prompt.js';
import { brollNormalise } from '../pipeline/src/assemble/timeline.js';

const {
  assertReelVoice, effectiveSpeed, elevenSettings, elevenVoiceSettings, reelVoice,
  resolveVoiceProvider, synthesise, VOICE_PROVIDERS,
} = voiceProviders;

const TOUCHED = [
  'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'MOONSHOT_API_KEY', 'GROQ_API_KEY',
  'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'SCRIPT_API_KEY', 'SCRIPT_BASE_URL',
  'SCRIPT_PROVIDER', 'SCRIPT_MODEL', 'ELEVENLABS_API_KEY', 'HEYGEN_API_KEY',
  'VOICE_PROVIDER', 'ELEVENLABS_VOICE_ID', 'ELEVENLABS_MODEL', 'ELEVENLABS_STABILITY',
  'ELEVENLABS_STYLE', 'ELEVENLABS_SPEED', 'REEL_VOICE_ID', 'LOCAL_TTS',
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

test('a blank ElevenLabs voice or model var keeps the built-in default', () => {
  const blank = withEnv({
    ELEVENLABS_VOICE_ID: '',
    ELEVENLABS_MODEL: '   ',
  }, () => elevenSettings());
  assert.equal(blank.voiceId, 'ypnkIsDASPgHZuanrF0q');
  assert.equal(blank.model, 'eleven_multilingual_v2');

  const override = withEnv({
    ELEVENLABS_VOICE_ID: 'voice-from-the-repo-var',
    ELEVENLABS_MODEL: 'eleven_turbo_v2_5',
  }, () => elevenSettings());
  assert.equal(override.voiceId, 'voice-from-the-repo-var');
  assert.equal(override.model, 'eleven_turbo_v2_5');
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

// ---- Reel voice: ElevenLabs library voice "Rudra" (owner's request, 3 Oct 2026) ----

const RUDRA = 'ypnkIsDASPgHZuanrF0q';
const RAJESH_CLONE = 'dqdRKSzyiQodrYo9UFzG';

async function withEnvAsync(patch, fn) {
  const saved = Object.fromEntries(TOUCHED.map((key) => [key, process.env[key]]));
  try {
    for (const key of TOUCHED) delete process.env[key];
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Replace fetch for one call; record what would have gone to ElevenLabs. */
async function withFakeFetch(fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({
      audio_base64: Buffer.from('fake-mp3').toString('base64'),
      alignment: {
        characters: ['h', 'i'],
        character_start_times_seconds: [0, 0.1],
        character_end_times_seconds: [0.1, 0.2],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
  return calls;
}

test('the reel voice defaults to Rudra with the Paise Ki Pathshala settings', () => {
  assert.equal(REEL_VOICE_ID, RUDRA);
  assert.equal(ELEVEN.voiceId, RUDRA);
  assert.notEqual(ELEVEN.voiceId, RAJESH_CLONE);
  const s = withEnv({}, () => elevenSettings());
  assert.equal(s.voiceId, RUDRA);
  assert.equal(s.expectedVoiceId, RUDRA);
  assert.equal(s.model, 'eleven_multilingual_v2');
  assert.equal(s.stability, 0.5);
  assert.equal(s.style, 0.25);
  assert.equal(s.speed, 0.9);
  assert.equal(s.similarityBoost, 0.85);
  assert.equal(s.useSpeakerBoost, true);
  assert.deepEqual(elevenVoiceSettings(s), {
    stability: 0.5, similarity_boost: 0.85, style: 0.25, use_speaker_boost: true, speed: 0.9,
  });
});

test('stability, style and speed can be overridden by repository variables', () => {
  const s = withEnv({
    ELEVENLABS_STABILITY: ' 0.4 ', ELEVENLABS_STYLE: '0.3', ELEVENLABS_SPEED: '1.0',
  }, () => elevenSettings());
  assert.equal(s.stability, 0.4);
  assert.equal(s.style, 0.3);
  assert.equal(s.speed, 1);
  const blank = withEnv({ ELEVENLABS_STABILITY: '', ELEVENLABS_STYLE: ' ', ELEVENLABS_SPEED: '' }, () => elevenSettings());
  assert.equal(blank.stability, 0.5);
  assert.equal(blank.style, 0.25);
  assert.equal(blank.speed, 0.9);
});

test('a malformed or out-of-range voice setting stops the run instead of drifting', () => {
  assert.throws(() => withEnv({ ELEVENLABS_STABILITY: 'high' }, () => elevenSettings()), /ELEVENLABS_STABILITY/);
  assert.throws(() => withEnv({ ELEVENLABS_STYLE: '1.5' }, () => elevenSettings()), /ELEVENLABS_STYLE/);
  assert.throws(() => withEnv({ ELEVENLABS_SPEED: '2' }, () => elevenSettings()), /ELEVENLABS_SPEED/);
  assert.throws(() => withEnv({ ELEVENLABS_SPEED: '0.5' }, () => elevenSettings()), /ELEVENLABS_SPEED/);
});

test('the caller speed is a factor on the 0.9 base, clamped to 0.7-1.2', () => {
  assert.equal(effectiveSpeed(0.9), 0.9);
  assert.equal(effectiveSpeed(0.9, 1), 0.9);
  assert.equal(effectiveSpeed(0.9, 1.2), 1.08);
  assert.equal(effectiveSpeed(0.9, 0.9), 0.81);
  assert.equal(effectiveSpeed(0.9, 2), 1.2);
  assert.equal(effectiveSpeed(0.9, 0.5), 0.7);
  assert.equal(effectiveSpeed(0.9, undefined), 0.9);
  assert.equal(effectiveSpeed(0.9, 'fast'), 0.9);
  assert.equal(effectiveSpeed(0.9, 0), 0.9);
  assert.equal(effectiveSpeed(1.2, 1.5), 1.2);
});

test('any voice other than Rudra is refused', () => {
  assert.equal(withEnv({}, () => assertReelVoice(RUDRA)), RUDRA);
  assert.throws(() => withEnv({}, () => assertReelVoice(RAJESH_CLONE)), /Refusing to synthesise.*ypnkIsDASPgHZuanrF0q/);
  assert.throws(() => withEnv({}, () => assertReelVoice('')), /Refusing to synthesise/);
  assert.throws(() => withEnv({ ELEVENLABS_VOICE_ID: RAJESH_CLONE }, () => reelVoice()), /ELEVENLABS_VOICE_ID/);
  assert.deepEqual(withEnv({}, () => reelVoice()), { id: RUDRA, name: 'Rudra', category: 'configured' });
  // The expected voice moves only when REEL_VOICE_ID is set deliberately.
  assert.equal(withEnv({ REEL_VOICE_ID: 'other', ELEVENLABS_VOICE_ID: 'other' }, () => reelVoice()).id, 'other');
  assert.throws(() => withEnv({ REEL_VOICE_ID: 'other' }, () => reelVoice()), /must be other/);
});

test('a drifted voice variable fails before any ElevenLabs request is made', async () => {
  const calls = await withFakeFetch(async () => {
    await withEnvAsync({ ELEVENLABS_API_KEY: 'test-eleven', ELEVENLABS_VOICE_ID: RAJESH_CLONE }, async () => {
      await assert.rejects(() => synthesise({ text: 'nifty flat' }), /Refusing to synthesise/);
    });
    await withEnvAsync({ ELEVENLABS_API_KEY: 'test-eleven' }, async () => {
      await assert.rejects(() => synthesise({ text: 'nifty flat', voiceId: RAJESH_CLONE }), /Refusing to synthesise/);
    });
  });
  assert.equal(calls.length, 0);
});

test('synthesis sends Rudra and the voice settings to ElevenLabs', async () => {
  const calls = await withFakeFetch(async () => {
    await withEnvAsync({ ELEVENLABS_API_KEY: 'test-eleven' }, async () => {
      const spoken = await synthesise({ text: 'hi', speed: 1 });
      assert.equal(spoken.provider, 'elevenlabs');
      assert.equal(spoken.words.length, 1);
      await synthesise({ text: 'hi', speed: 1.2 });
      await synthesise({ text: 'hi' });
    });
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, `https://api.elevenlabs.io/v1/text-to-speech/${RUDRA}/with-timestamps`);
    assert.equal(call.body.model_id, 'eleven_multilingual_v2');
    assert.equal(call.body.voice_settings.stability, 0.5);
    assert.equal(call.body.voice_settings.style, 0.25);
    assert.equal(call.body.voice_settings.similarity_boost, 0.85);
    assert.equal(call.body.voice_settings.use_speaker_boost, true);
  }
  assert.deepEqual(calls.map((c) => c.body.voice_settings.speed), [0.9, 1.08, 0.9]);
});

test('the reel never auto-discovers a cloned voice on the account', async () => {
  assert.equal('discoverElevenVoice' in voiceProviders, false);
  const source = await readFile('pipeline/src/presenter/voice-providers.js', 'utf8');
  assert.equal(/\$\{ELEVEN\}\/voices[`'"]/.test(source), false);
  assert.equal(/byCategory|'cloned'|'professional'/.test(source), false);
  const doctor = await readFile('pipeline/heygen-doctor.js', 'utf8');
  assert.equal(doctor.includes('discoverElevenVoice'), false);
});

test('Build reel checks the Rudra voice after the same-day guard and before the build', async () => {
  const reel = await readFile('.github/workflows/build-reel.yml', 'utf8');
  const day = reel.indexOf('Already published today?');
  const check = reel.indexOf('Check the reel voice (Rudra)');
  const install = reel.indexOf('name: Install dependencies');
  const build = reel.indexOf('name: Build the reel');
  assert.ok(day > 0 && check > day && check < install && check < build);
  const step = reel.slice(check, reel.indexOf('- name:', check + 10));
  assert.match(step, /steps\.day\.outputs\.pending == 'true'/);
  assert.match(step, /https:\/\/api\.elevenlabs\.io\/v1\/voices\/\$REEL_VOICE_ID/);
  assert.match(step, /ypnkIsDASPgHZuanrF0q/);
  assert.match(step, /'Rudra'/);
  assert.match(step, /::error::/);
  assert.match(step, /secrets\.ELEVENLABS_API_KEY/);
  assert.equal(/-X\s*(POST|PUT|PATCH|DELETE)|--data|--json|-F /.test(step), false, 'the preflight is read-only');
  const buildStep = reel.slice(build, reel.indexOf('- name:', build + 10));
  for (const name of ['ELEVENLABS_VOICE_ID', 'ELEVENLABS_STABILITY', 'ELEVENLABS_STYLE', 'ELEVENLABS_SPEED', 'REEL_VOICE_ID']) {
    assert.match(buildStep, new RegExp(`${name}: \\$\\{\\{ vars\\.${name} \\}\\}`));
  }
  assert.equal(reel.includes(RAJESH_CLONE), false);
});

test('Reel voice check is manual and never builds or publishes', async () => {
  const wf = await readFile('.github/workflows/voice-check.yml', 'utf8');
  assert.match(wf, /name: Reel voice check/);
  assert.match(wf, /workflow_dispatch/);
  assert.equal(/schedule:|pull_request:|push:/.test(wf), false);
  assert.match(wf, /\/v1\/voices\/\$VOICE_ID/);
  assert.match(wf, /\/v1\/shared-voices\?/);
  assert.match(wf, /\/v1\/voices\/add\/\$OWNER\/\$VOICE_ID/);
  assert.match(wf, /new_name/);
  assert.equal(/text-to-speech|build-reel|publish-reel/.test(wf), false);
});
