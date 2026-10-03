// The reel's voice is ElevenLabs speech. There is no avatar render on this path.
// A failure here must surface to the build, which skips publishing.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run, probe } from '../assemble/encode.js';
import { synthesise } from './voice-providers.js';

/** Normalise any source audio to the one shape the mixer expects. */
async function toNarrationWav(input, out) {
  await run('ffmpeg', [
    '-y', '-v', 'error', '-i', input,
    '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

/**
 * Speech only, in the reel voice (Rudra, ElevenLabs). No avatar credits are spent here.
 */
async function recordVoiceOnly({ script, workDir, speed, voiceId, onNote, local }) {
  const speech = await synthesise({
    text: script,
    voiceId,
    speed,
    local,
  });

  onNote?.(`voice by ${speech.provider}`);

  const raw = path.join(workDir, `speech-raw.${speech.format}`);
  await fs.writeFile(raw, speech.audio);

  const audio = path.join(workDir, 'narration.wav');
  await toNarrationWav(raw, audio);

  const info = await probe(audio);
  return {
    audio,
    video: null,
    // Trust the file over the provider: ElevenLabs reports no duration of its
    // own, and a provider's figure can disagree with the audio it sent.
    duration: info.duration || speech.duration,
    words: speech.words || [],
    source: 'speech',
    provider: speech.provider,
  };
}

/**
 * @param {object}   opts
 * @param {string}   opts.script     every spoken word in the reel, in order
 * @param {function} opts.onNote     called with the provider name
 */
export async function renderNarration({ script, workDir, onNote, speed = 1, voiceId, local = false } = {}) {
  await fs.mkdir(workDir, { recursive: true });
  return recordVoiceOnly({ script, workDir, speed, voiceId, onNote, local });
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
