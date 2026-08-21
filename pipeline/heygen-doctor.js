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

import { heygenRequest, findAvatarLook, listAvatars, getQuota, createSpeech } from '../src/heygen.js';
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

const SPEECH_CANDIDATES = [
  '/v3/speech', '/v2/speech', '/v1/speech',
  '/v3/text_to_speech', '/v2/text_to_speech',
  '/v3/tts', '/v2/audio/generate', '/v1/audio/generate',
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

  // Which speech path exists? A 404 means "no such endpoint"; anything else —
  // including a 400 about a malformed body — means the endpoint is real.
  console.log('\nText to speech');
  const survivors = [];
  for (const path of SPEECH_CANDIDATES) {
    try {
      await heygenRequest(path, { method: 'POST', body: {} });
      survivors.push(path);
      console.log(`  ${ok('ok')}    ${path} ${dim('— accepted an empty body')}`);
    } catch (err) {
      if (err.status === 404) console.log(`  ${dim(`404   ${path}`)}`);
      else {
        survivors.push(path);
        console.log(`  ${ok('ok')}    ${path} ${dim(`— exists (${err.status}: ${String(err.message).slice(0, 60)})`)}`);
      }
    }
  }

  if (!survivors.length) {
    console.log(`  ${bad('None of the candidates exist. The reel will be silent.')}`);
  } else {
    console.log(`\n  Pin the winner: ${ok(`HEYGEN_SPEECH_PATH=${survivors[0]}`)}`);
    const speech = await attempt(`synthesise two words in voice ${dim(voiceId)}`, () =>
      createSpeech({ text: 'Namaste doston.', voiceId, language: 'hi' }));
    if (speech) {
      console.log(`        ${dim(`${speech.duration?.toFixed?.(2)}s, ${speech.wordTimestamps.length} word timestamps`)}`);
      console.log(`  ${ok('The voice works. The reel can always be narrated.')}`);
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
