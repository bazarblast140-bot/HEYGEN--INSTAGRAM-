// Hybrid frame: chart panel on top, presenter below — the split-screen layout the
// talking-head reference reels use, in the trading palette.
//
//   0    ┌──────────────────┐
//        │  chart / graphics│  1080 x 1000
//   1000 ├──────────────────┤  <- 2px divider
//        │  presenter       │  1080 x 920
//   1920 └──────────────────┘
//
// Voiceover lives in the presenter clip, so the presenter drives the duration:
// the chart panel holds on its final frame if it is shorter, and is trimmed if
// it is longer. That way a longer script never truncates the speech.

import { spawn } from 'node:child_process';
import { run, probe } from './encode.js';

export const FRAME = { width: 1080, height: 1920 };
// The presenter panel was 780 tall and the head did not fit in it.
//
// Measured from a finished reel: the portrait source is 720x1280 and scales 1.5x
// to cover the panel's width, so a 780-tall panel captures only 520 rows of the
// source. Rajesh's head runs about 500 rows crown to chin. That is no margin at
// all — the crop landed on his eyes and cut the mouth off entirely.
//
// 920 captures 613 rows, which fits the head with about 110 rows spare for neck
// and shoulders. The card above loses 140px and still has room.
export const TOP = { width: 1080, height: 1000 };
export const BOTTOM = { width: 1080, height: 920 };
export const DIVIDER = { height: 2, colour: '0x1E2A3A' };

/**
 * Find the top of the subject's head, as a fraction of the source's height.
 *
 * A fixed anchor was tried twice and was wrong twice — 0.5 put the crop on the
 * chest, 0.22 put it on the eyes. The number depends on how HeyGen happens to
 * frame this avatar, which is not something this file can know in advance and
 * not something worth guessing a third time.
 *
 * So it is measured. The avatar renders against a plain wall, so reading down
 * the frame the rows are near-uniform until the head interrupts them: the first
 * row that is meaningfully darker than the wall above it is the crown.
 *
 * Returns null when the picture has no clear background to read — a busy or
 * dark backdrop — and the caller falls back to a fixed anchor.
 */
export async function detectCrown(file, { seconds = 0.5, width = 120 } = {}) {
  const height = 213; // 120 x (1280/720), the source's own proportions

  const frame = await new Promise((resolve) => {
    const child = spawn('ffmpeg', [
      '-v', 'error', '-ss', String(seconds), '-i', file,
      '-frames:v', '1', '-vf', `scale=${width}:${height}`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ], { stdio: ['ignore', 'pipe', 'ignore'] });

    const chunks = [];
    child.stdout.on('data', (c) => chunks.push(c));
    child.on('close', () => resolve(Buffer.concat(chunks)));
    child.on('error', () => resolve(Buffer.alloc(0)));
  });

  if (frame.length < width * height) return null;

  const rowMean = (y) => {
    let sum = 0;
    for (let x = 0; x < width; x += 1) sum += frame[y * width + x];
    return sum / width;
  };

  // The wall, sampled from the top eighth where the head never reaches.
  const top = Math.max(1, Math.floor(height / 8));
  let wall = 0;
  for (let y = 0; y < top; y += 1) wall += rowMean(y);
  wall /= top;

  // A head against a wall darkens a row by far more than the wall's own
  // gradient does; 18 grey levels separates the two without tripping on shading.
  for (let y = top; y < height; y += 1) {
    if (wall - rowMean(y) > 18) return y / height;
  }
  return null;
}

/**
 * Where to take the crop from vertically, as a fraction of the overflow.
 *
 * Given the crown, put it a little below the panel's top edge so the head has
 * headroom rather than being flush against the cut.
 */
export function anchorForCrown({ crown, sourceWidth, sourceHeight, headroom = 0.08 }) {
  if (crown == null) return sourceHeight > sourceWidth ? 0.45 : 0.5;

  const scale = Math.max(BOTTOM.width / sourceWidth, BOTTOM.height / sourceHeight);
  const scaledHeight = sourceHeight * scale;
  const overflow = scaledHeight - BOTTOM.height;
  if (overflow <= 0) return 0;

  const cropTop = crown * scaledHeight - headroom * BOTTOM.height;
  return Math.min(1, Math.max(0, cropTop / overflow));
}

export async function composeHybrid({ chart, presenter, out, dividerColour = DIVIDER.colour, anchor }) {
  const [chartInfo, presenterInfo] = await Promise.all([probe(chart), probe(presenter)]);
  const target = presenterInfo.duration;
  const crown = anchor == null ? await detectCrown(presenter) : null;
  const cropAnchor = anchor ?? anchorForCrown({
    crown,
    sourceWidth: presenterInfo.width,
    sourceHeight: presenterInfo.height,
  });

  const filter = [
    // Chart: fit the top panel, pad rather than crop so no data leaves the frame,
    // then hold the last frame out to the presenter's length.
    `[0:v]scale=${TOP.width}:${TOP.height}:force_original_aspect_ratio=decrease,` +
      `pad=${TOP.width}:${TOP.height}:(ow-iw)/2:(oh-ih)/2:color=0x020617,` +
      `tpad=stop_mode=clone:stop_duration=${Math.max(0, target - chartInfo.duration).toFixed(3)},` +
      `trim=duration=${target.toFixed(3)},setpts=PTS-STARTPTS,fps=30[top]`,

    // Presenter: cover the bottom panel, then crop at an anchor chosen from the
    // source's own shape rather than always from the middle.
    `[1:v]scale=${BOTTOM.width}:${BOTTOM.height}:force_original_aspect_ratio=increase,` +
      `crop=${BOTTOM.width}:${BOTTOM.height}:(iw-ow)/2:(ih-oh)*${cropAnchor.toFixed(3)},` +
      `setpts=PTS-STARTPTS,fps=30[bottom]`,

    `color=c=${dividerColour}:s=${FRAME.width}x${DIVIDER.height}:d=${target.toFixed(3)},fps=30[rule]`,

    `[top][bottom]vstack=inputs=2[stacked]`,
    `[stacked][rule]overlay=0:${TOP.height - DIVIDER.height}:format=auto[v]`,
  ].join(';');

  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', chart,
    '-i', presenter,
    '-filter_complex', filter,
    '-map', '[v]',
    // Presenter audio is the voiceover; music is mixed in later.
    ...(presenterInfo.hasAudio ? ['-map', '1:a', '-c:a', 'aac', '-b:a', '192k'] : []),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', target.toFixed(3),
    out,
  ]);

  return { out, duration: target, chartDuration: chartInfo.duration };
}
