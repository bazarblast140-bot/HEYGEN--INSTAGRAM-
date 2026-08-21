#!/usr/bin/env node
// One run that answers "why did the reel come out wrong today?".
//
// This container cannot reach api.heygen.com, and neither can a laptop behind a
// corporate proxy, so questions like "which text-to-speech path actually exists"
// were being answered by pushing a guess and reading a failed build twenty
// minutes later. This script answers them all in one place, from inside CI where
// the network works.
//
//   node pipeline/heygen-doctor.js
//
// It never prints the API key, and it spends no avatar credits: the only write it
// makes is a two-word speech synthesis, which is metered far more generously.

import { heygenRequest, findAvatarLook, listAvatars, getQuota } from '../src/heygen.js';
import { config, env, PRESENTER } from '../src/config.js';
import { discoverElevenVoice, synthesise } from './src/presenter/voice-providers.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

async function attempt(label, fn) {
  try {
    const value = await fn();
    console.log(`  ${ok('ok')}    ${label}`);
    return value;
  } catch (err) {
    console.log(`  ${bad('fail')}  ${label} ${dim(`— ${err.message.slice(0, 120)}`)}`);
    return null;
  }
}

// Probing with an empty body proved worthless: POST /v2/voices came back 404
// even though that endpoint certainly exists, so on this API a 404 does not mean
// "no such path" — it is also what you get for the wrong method or a body that
// fails to parse. So the probe sends the REAL request instead, and reports the
// exact status. Only a 404 to a well-formed request is evidence of absence.
const SPEECH_HOSTS = ['https://api.heygen.com', 'https://api2.heygen.com'];

const SPEECH_CANDIDATES = [
  '/v1/tts.generate', '/v1/speech.generate', '/v1/voice.generate',
  '/v1/audio.generate', '/v1/text_to_speech.generate',
  '/v3/speech', '/v2/speech', '/v1/speech',
  '/v3/speech/generate', '/v2/speech/generate',
  '/v3/text_to_speech', '/v2/text_to_speech', '/v1/text_to_speech',
  '/v3/text_to_speech/generate', '/v2/text_to_speech/generate',
  '/v3/tts', '/v2/tts', '/v1/tts',
  '/v3/tts/generate', '/v2/tts/generate',
  '/v3/audio/generate', '/v2/audio/generate', '/v1/audio/generate',
  '/v3/audio', '/v2/audio',
  '/v2/voice/generate', '/v1/voice/generate',
];

async function main() {
  if (!config.apiKey) {
    console.error(bad('HEYGEN_API_KEY is not set — nothing to check.'));
    process.exit(1);
  }
  console.log(`HeyGen key ${dim(`…${config.apiKey.slice(-4)}`)}\n`);

  console.log('Account');
  const quota = await attempt('remaining quota', getQuota);
  if (quota) console.log(`        ${dim(JSON.stringify(quota))}`);

  const avatarId = env('HEYGEN_AVATAR_ID') || PRESENTER.avatarId;
  const voiceId = env('HEYGEN_VOICE_ID') || PRESENTER.voiceId;

  console.log(`\nPresenter ${dim(avatarId)}`);
  await attempt('flat /v2/avatars listing', async () => {
    const { avatars, talkingPhotos } = await listAvatars();
    const hit = [...avatars, ...talkingPhotos].find((a) => a.id === avatarId);
    console.log(`        ${dim(hit ? `listed as ${hit.kind}` : 'not in the flat listing (normal for a grouped look)')}`);
    return hit;
  });

  const look = await attempt('avatar-group lookup', async () => {
    const found = await findAvatarLook(avatarId);
    if (!found) throw new Error('not found in any avatar group');
    console.log(`        ${dim(`type=${found.type} engines=${(found.engines || []).join(',') || 'unlisted'}`)}`);
    return found;
  });

  if (look?.type) {
    const kind = look.type === 'photo_avatar' ? 'talking_photo' : 'avatar';
    const configured = env('HEYGEN_AVATAR_KIND') || PRESENTER.avatarKind;
    console.log(
      kind === configured
        ? `  ${ok('ok')}    character kind ${configured} matches the look`
        : `  ${bad('fail')}  character kind is ${configured} but the look is ${look.type} — set HEYGEN_AVATAR_KIND=${kind}`,
    );
  }

  // A real body, so the answer means something.
  console.log('\nText to speech');
  const body = { text: 'Namaste doston.', voice_id: voiceId, speed: 1, input_type: 'text', language: 'hi' };
  let winner = null;

  for (const host of SPEECH_HOSTS) {
    for (const candidate of SPEECH_CANDIDATES) {
      if (winner) break;
      try {
        const payload = await heygenRequest(candidate, { method: 'POST', body, baseUrl: host });
        const data = payload?.data || payload;
        if (data?.audio_url) {
          winner = { host, path: candidate, data };
          console.log(`  ${ok('FOUND')} ${host}${candidate}`);
          break;
        }
        console.log(`  ${dim(`200 but no audio_url  ${candidate}`)}`);
      } catch (err) {
        const status = err.status || '?';
        // 404 to a well-formed request is the only real "not here". Anything
        // else — 401, 403, 422, 429 — means the path is live and worth reporting.
        if (status === 404) continue;
        console.log(`  ${ok(String(status))}   ${host}${candidate} ${dim(String(err.message).slice(0, 80))}`);
      }
    }
  }

  // A 403 on /v1/tts.generate was read as "this plan is not entitled". That is the
  // likeliest reading, but it is not the only one: some HeyGen routes take a
  // Bearer token rather than the X-Api-Key header this client sends everywhere
  // else, and a route that wants Bearer will refuse an X-Api-Key with 403 too.
  // Worth ruling out before telling anyone to spend money.
  if (!winner) {
    console.log(`\n  ${dim('Same path, the other auth header')}`);
    for (const header of ['Authorization: Bearer', 'Authorization: raw', 'X-Api-Key']) {
      const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      if (header === 'Authorization: Bearer') headers.Authorization = `Bearer ${config.apiKey}`;
      else if (header === 'Authorization: raw') headers.Authorization = config.apiKey;
      else headers['X-Api-Key'] = config.apiKey;

      try {
        const res = await fetch('https://api.heygen.com/v1/tts.generate', {
          method: 'POST', headers, body: JSON.stringify(body),
        });
        const text = (await res.text()).slice(0, 180);
        const mark = res.ok ? ok(String(res.status)) : (res.status === 403 ? bad('403') : ok(String(res.status)));
        console.log(`  ${mark}   ${header} ${dim(text)}`);
        if (res.ok) {
          const parsed = JSON.parse(text);
          const data = parsed?.data || parsed;
          if (data?.audio_url) winner = { host: SPEECH_HOSTS[0], path: '/v1/tts.generate', data, auth: header };
        }
      } catch (err) {
        console.log(`  ${dim(`err   ${header} ${String(err.message).slice(0, 60)}`)}`);
      }
    }
  }

  // 405 on /v2/voice/generate says that path is real and POST is not its verb.
  // Worth settling, because a live route is a far better lead than another guess.
  if (!winner) {
    console.log(`\n  ${dim('Method sweep on paths that answered 405')}`);
    for (const method of ['GET', 'PUT', 'PATCH']) {
      try {
        const payload = await heygenRequest('/v2/voice/generate', { method, body: method === 'GET' ? undefined : body });
        const data = payload?.data || payload;
        console.log(`  ${ok(method)}   /v2/voice/generate ${dim(JSON.stringify(data).slice(0, 160))}`);
        if (data?.audio_url) winner = { host: SPEECH_HOSTS[0], path: '/v2/voice/generate', data, method };
      } catch (err) {
        console.log(`  ${dim(`${err.status || '?'}   ${method} /v2/voice/generate`)}`);
      }
    }
  }

  if (winner) {
    console.log(`\n  ${ok(`HEYGEN_SPEECH_PATH=${winner.path}`)}`);
    if (winner.host !== SPEECH_HOSTS[0]) console.log(`  ${ok(`HEYGEN_API_BASE=${winner.host}`)}`);
    const words = (winner.data.word_timestamps || []).length;
    console.log(`  ${dim(`${winner.data.duration}s, ${words} word timestamps`)}`);
    console.log(`  ${ok('The voice works. The reel can always be narrated.')}`);
  } else {
    console.log(`  ${bad('No speech endpoint returned audio.')}`);
    console.log(dim('  A 403 above means the path is right and the key is not entitled:'));
    console.log(dim('  /v1/tts.generate is the real endpoint, and synthesising speech over'));
    console.log(dim('  the REST API needs a paid HeyGen plan. tts_free_credit in the quota'));
    console.log(dim('  block is spendable from the HeyGen web app, not from an API key.'));
  }

  // ElevenLabs is the way the voice stops depending on HeyGen's plan, so it gets
  // the same treatment: does the key work, is there a CLONED voice on the
  // account, and does synthesis actually return audio and timings.
  console.log('\nElevenLabs');
  if (!env('ELEVENLABS_API_KEY')) {
    console.log(dim('  No ELEVENLABS_API_KEY — skipped.'));
  } else {
    const voice = await attempt('find a cloned voice', discoverElevenVoice);
    if (voice) {
      console.log(`        ${dim(`${voice.name || voice.id} (${voice.category})`)}`);
      if (voice.category === 'premade') {
        console.log(`  ${bad('That is a stock ElevenLabs voice, not Rajesh.')}`);
      }
      const spoken = await attempt('synthesise a line with word timings', () =>
        synthesise({ text: 'Namaste doston, aaj ka market update.', speed: 1 }));
      if (spoken) {
        console.log(`        ${dim(`${spoken.provider}, ${spoken.audio.length} bytes ${spoken.format}, ${spoken.words.length} words`)}`);
        if (spoken.words.length) {
          const last = spoken.words[spoken.words.length - 1];
          console.log(`        ${dim(`last word "${last.word}" ends at ${last.end?.toFixed?.(2)}s`)}`);
        }
        console.log(`  ${ok('The reel can be narrated in Rajesh\'s voice, without HeyGen.')}`);
      }
    }
  }

  console.log('\nAvatar allowance');
  console.log(dim('  Not probed — a test render costs credits. If the daily build reports'));
  console.log(dim('  "no avatar allowance left", the plan is out of avatar minutes for the'));
  console.log(dim('  month; the voice still works and the reel still posts, without the face.'));
}

main().catch((err) => {
  console.error(bad(`\ndoctor failed: ${err.message}`));
  process.exit(1);
});
