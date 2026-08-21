// One avatar render carries the whole reel.
//
// Two complaints had the same root. The free Edge voice was ruining the middle of
// the reel, and the avatar's lip-sync was off — and both came from treating voice
// and picture as separate things to fetch and then line up.
//
// So: render the ENTIRE script once as an avatar video, in Rajesh's own cloned
// voice. Use that render's AUDIO as the narration for every second of the reel,
// and cut its VIDEO into the beats where the presenter is on screen. Because the
// picture and the sound come out of the same render, the mouth matches the words
// exactly — there is no alignment step left to get wrong.
//
// It also costs one HeyGen render instead of two, and removes the free-voice
// fallback entirely.

import fs from 'node:fs/promises';
import path from 'node:path';
import { run, probe } from '../assemble/encode.js';
import { renderPresenter } from './segment.js';

/**
 * @param {object}   opts
 * @param {string}   opts.script    every spoken word in the reel, in order
 * @param {string}   opts.workDir
 * @param {function} opts.onStatus
 */
export async function renderNarration({ script, workDir, onStatus, ...presenterOptions }) {
  await fs.mkdir(workDir, { recursive: true });
  const video = path.join(workDir, 'narration.mp4');

  // Portrait, because the clone is portrait. Asking a portrait source for a
  // landscape frame is what produced a small figure marooned in a wide dark
  // rectangle in the previous cut.
  const result = await renderPresenter({
    script,
    out: video,
    width: 720,
    height: 1280,
    onStatus,
    ...presenterOptions,
  });

  const audio = path.join(workDir, 'narration.wav');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', video, '-vn', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', audio]);

  const info = await probe(video);
  return { video, audio, duration: info.duration, width: info.width, height: info.height };
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
