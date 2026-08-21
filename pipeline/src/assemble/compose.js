// Hybrid frame: chart panel on top, presenter below — the split-screen layout the
// talking-head reference reels use, in the trading palette.
//
//   0    ┌──────────────────┐
//        │  chart / graphics│  1080 x 1140
//   1140 ├──────────────────┤  <- 2px divider
//        │  presenter       │  1080 x 780
//   1920 └──────────────────┘
//
// Voiceover lives in the presenter clip, so the presenter drives the duration:
// the chart panel holds on its final frame if it is shorter, and is trimmed if
// it is longer. That way a longer script never truncates the speech.

import { run, probe } from './encode.js';

export const FRAME = { width: 1080, height: 1920 };
export const TOP = { width: 1080, height: 1140 };
export const BOTTOM = { width: 1080, height: 780 };
export const DIVIDER = { height: 2, colour: '0x1E2A3A' };

/**
 * Where to take the crop from vertically, as a fraction of the overflow.
 *
 * The panel is wider than it is tall; a portrait source scaled to fill it
 * overflows enormously in height, and a centre crop lands on the chest. Portrait
 * framings put the face in the upper third, so the crop is anchored up there
 * instead. Landscape sources are already close to the panel's shape and stay
 * centred.
 */
function verticalAnchor(info) {
  const portrait = info.height > info.width;
  return portrait ? 0.22 : 0.5;
}

export async function composeHybrid({ chart, presenter, out, dividerColour = DIVIDER.colour, anchor }) {
  const [chartInfo, presenterInfo] = await Promise.all([probe(chart), probe(presenter)]);
  const target = presenterInfo.duration;
  const cropAnchor = anchor ?? verticalAnchor(presenterInfo);

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
