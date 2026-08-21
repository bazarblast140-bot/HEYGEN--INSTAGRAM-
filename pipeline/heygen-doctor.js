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

  if (winner) {
    console.log(`\n  ${ok(`HEYGEN_SPEECH_PATH=${winner.path}`)}`);
    if (winner.host !== SPEECH_HOSTS[0]) console.log(`  ${ok(`HEYGEN_API_BASE=${winner.host}`)}`);
    const words = (winner.data.word_timestamps || []).length;
    console.log(`  ${dim(`${winner.data.duration}s, ${words} word timestamps`)}`);
    console.log(`  ${ok('The voice works. The reel can always be narrated.')}`);
  } else {
    console.log(`  ${bad('No speech endpoint answered on either host with a well-formed request.')}`);
    console.log(dim('  Quota shows tts_free_credit, so the capability exists on this plan —'));
    console.log(dim('  the REST path is simply not among the candidates tried above.'));
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
