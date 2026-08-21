// The reel's voice, and — when the account can still afford it — the reel's face.
//
// These used to be one thing: a single avatar render supplied both the picture
// and the sound. That was elegant while it worked, and it failed badly the day
// it stopped. HeyGen meters avatar video, the monthly allowance ran out, and
// because the voice was a by-product of the face, losing the face lost the
// voice too. The reel went out silent.
//
// So they are two things now, with a deliberate order:
//
//   1. FACE FIRST. If an avatar render succeeds, its audio narrates the reel and
//      its video supplies the presenter beats. Mouth and words come from the same
//      render, so lip-sync matches by construction — there is no alignment step
//      left to get wrong.
//
//   2. VOICE ALWAYS. If the render is refused — out of credit, monthly limit
//      reached, plan restriction — speech synthesis carries the narration on its
//      own. It is metered far more generously and it is the same cloned voice,
//      so the reel keeps sounding like Rajesh. It loses the face, not the day.
//
// What it must never do again is fall through to silence.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run, probe } from '../assemble/encode.js';
import { createSpeech, isQuotaRefusal } from '../../../src/heygen.js';
import { config, env } from '../../../src/config.js';
import { renderPresenter } from './segment.js';

/** Normalise any source audio to the one shape the mixer expects. */
async function toNarrationWav(input, out) {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', input,
    '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetching narration audio failed (${res.status})`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

/**
 * Speech only, in the cloned voice. No avatar credits are spent here.
 */
async function recordVoiceOnly({ script, workDir, speed, voiceId }) {
  const speech = await createSpeech({
    text: script,
    voiceId: voiceId || env('HEYGEN_VOICE_ID') || config.defaultVoiceId,
    speed,
    // Hinglish reads as Hindi to the synthesiser; saying so keeps English words
    // from being pronounced as though they were Hindi spellings.
    language: env('HEYGEN_TTS_LANGUAGE') || 'hi',
  });

  const raw = path.join(workDir, 'speech-raw');
  await download(speech.audioUrl, raw);

  const audio = path.join(workDir, 'narration.wav');
  await toNarrationWav(raw, audio);

  const info = await probe(audio);
  return {
    audio,
    video: null,
    duration: speech.duration || info.duration,
    words: speech.wordTimestamps || [],
    source: 'speech',
  };
}

/**
 * Full avatar render: picture and sound from one pass.
 */
async function recordWithFace({ script, workDir, onStatus, ...presenterOptions }) {
  const video = path.join(workDir, 'narration.mp4');

  // Portrait, because the clone is portrait. Asking a portrait source for a
  // landscape frame is what produced a small figure marooned in a wide dark
  // rectangle in an earlier cut.
  await renderPresenter({
    script,
    out: video,
    width: 720,
    height: 1280,
    onStatus,
    ...presenterOptions,
  });

  const audio = path.join(workDir, 'narration.wav');
  await toNarrationWav(video, audio);

  const info = await probe(video);
  return {
    audio,
    video,
    duration: info.duration,
    width: info.width,
    height: info.height,
    words: [],
    source: 'avatar',
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.script     every spoken word in the reel, in order
 * @param {boolean}  opts.wantFace   attempt the avatar render at all
 * @param {function} opts.onNote     called with a human sentence when the face is lost
 */
export async function renderNarration({
  script, workDir, onStatus, onNote, wantFace = true, speed = 1, ...presenterOptions
}) {
  await fs.mkdir(workDir, { recursive: true });

  if (wantFace) {
    try {
      return await recordWithFace({ script, workDir, onStatus, speed, ...presenterOptions });
    } catch (err) {
      const outOfAllowance = err.quota || isQuotaRefusal(err);
      onNote?.(
        outOfAllowance
          ? `HeyGen has no avatar allowance left (${err.errorCode || 'quota'}) — keeping the voice, dropping the face`
          : `avatar render failed (${err.message.slice(0, 90)}) — keeping the voice, dropping the face`,
      );
    }
  }

  return recordVoiceOnly({ script, workDir, speed, voiceId: presenterOptions.voiceId });
}

/**
 * Cut one presenter beat out of the single narration render.
 *
 * The window is taken at the beat's own position on the finished timeline, so the
 * frames shown are the frames that belong to the words being heard at that moment.
 */
export async function cutPresenterWindow({ narration, start, duration, out }) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-ss', start.toFixed(3),
    '-i', narration.video,
    '-t', duration.toFixed(3),
    // Re-encode rather than copy: a stream copy would snap to the nearest
    // keyframe and slide the window by up to a second.
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
    '-an', '-pix_fmt', 'yuv420p',
    out,
  ]);
  return out;
}

/**
 * Beat boundaries from the narration's own word timings.
 *
 * Proportional estimation — give each beat a share of the runtime matching its
 * share of the words — is only ever approximately right, and the error compounds
 * along the reel so the last card lands after its line has finished. When the
 * synthesiser tells us when each word was actually spoken, use that instead: beat
 * i ends when its last word ends.
 *
 * Returns null when there are no usable timings, so the caller can fall back.
 */
export function alignBeats({ words, spokenPerBeat, totalDuration }) {
  if (!words?.length) return null;

  const counts = spokenPerBeat.map(
    (line) => String(line || '').trim().split(/\s+/).filter(Boolean).length,
  );
  const spokenTotal = counts.reduce((a, b) => a + b, 0);
  // The synthesiser may split or join tokens; if it disagrees wildly with the
  // script, its indices cannot be trusted to mark beat boundaries.
  if (!spokenTotal || Math.abs(words.length - spokenTotal) > spokenTotal * 0.25) return null;

  const scale = words.length / spokenTotal;
  const durations = [];
  let consumed = 0;
  let cursor = 0;

  for (const [i, count] of counts.entries()) {
    consumed += count;
    const last = i === counts.length - 1;
    const boundary = last
      ? totalDuration
      : (words[Math.min(words.length - 1, Math.round(consumed * scale))]?.start ?? null);

    if (boundary === null) return null;
    durations.push(Math.max(0.6, boundary - cursor));
    cursor = boundary;
  }

  return durations;
}
