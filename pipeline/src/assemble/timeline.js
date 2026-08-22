// Assemble a finished reel from a segment manifest.
//
// The cost model drives the shape. HeyGen bills avatar video by the minute, so the
// avatar appears only in the hook — a few seconds of face to establish who is
// talking — and everything after that is rendered graphics or free stock footage
// with a voiceover laid over it. A 45s reel therefore buys ~5s of avatar instead
// of 45s, while still opening on a real presenter.
//
// Video and audio are built separately and muxed at the end: concat behaves badly
// when some inputs carry audio and others do not, and the voice track needs its
// own treatment anyway.

import path from 'node:path';
import fs from 'node:fs/promises';
import { run, probe } from './encode.js';

export const FRAME = { width: 1080, height: 1920, fps: 30 };

// Instagram normalises to roughly this; mastering here means the platform does
// not have to, which is what the reference reels all measured at.
export const LOUDNESS = { I: -14, TP: -1.5, LRA: 11 };

/**
 * One filter chain that makes any source match the reel frame: fill it by
 * scaling up, centre-crop the overflow, lock the frame rate and pixel aspect.
 * Stock footage arrives in every shape imaginable, so this is not optional.
 */
function normaliseVideo(index, duration, { grade = false } = {}) {
  const chain = [
    `scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=increase`,
    `crop=${FRAME.width}:${FRAME.height}`,
    `fps=${FRAME.fps}`,
    'setsar=1',
    // Stock clips are shot in every colour temperature going. A slight darken and
    // desaturate settles them into the dark trading palette instead of jumping.
    ...(grade ? [
      // Footage carries its own detail, and the caption has to survive it. The
      // "stock market screen" clip is a wall of small numbers; at the previous
      // grade the burned-in caption sat inside that wall and could not be read.
      'eq=brightness=-0.14:saturation=0.72:contrast=1.05',
      // A bottom scrim where the captions live, so type has a ground of its own.
      `drawbox=x=0:y=ih*0.62:w=iw:h=ih*0.38:color=black@0.42:t=fill`,
    ] : []),
    `trim=duration=${duration.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
    // A clip shorter than its slot holds its last frame rather than cutting to black.
    `tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)}`,
    `trim=duration=${duration.toFixed(3)}`,
    'setpts=PTS-STARTPTS',
  ];
  return `[${index}:v]${chain.join(',')}[v${index}]`;
}

export async function buildVideo({ segments, out }) {
  if (!segments.length) throw new Error('buildVideo needs at least one segment');

  const filters = segments.map((s, i) => normaliseVideo(i, s.duration, { grade: s.kind === 'stock' }));
  const concatInputs = segments.map((_, i) => `[v${i}]`).join('');
  filters.push(`${concatInputs}concat=n=${segments.length}:v=1:a=0[v]`);

  await run('ffmpeg', [
    '-y', '-v', 'error',
    ...segments.flatMap((s) => ['-i', s.file]),
    '-filter_complex', filters.join(';'),
    '-map', '[v]',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
    '-pix_fmt', 'yuv420p',
    out,
  ]);

  return out;
}

/**
 * Voice track, with every part pinned to the timestamp its picture appears at.
 *
 * Concatenating the parts end to end was wrong, and wrong in a way that only
 * showed up on screen: the hook's audio lined up because it starts at zero, but
 * everything after it slid by however much the preceding audio's length differed
 * from its shot's length. The cut-in avatar ended up speaking over the wrong
 * frames — read as broken lip-sync, caused by arithmetic.
 *
 * Each part now carries the offset it belongs at and is delayed into place, so a
 * part that is shorter than its shot leaves quiet rather than dragging everything
 * after it out of position.
 *
 * @param {Array} parts [{ file, start }] — start in seconds on the finished cut
 */
export async function buildVoice({ parts, out, duration }) {
  const placed = parts.filter((p) => p?.file);
  if (!placed.length) throw new Error('buildVoice needs at least one audio part');

  const chains = placed.map((p, i) =>
    `[${i}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo,` +
    `adelay=${Math.round(p.start * 1000)}|${Math.round(p.start * 1000)}[a${i}]`,
  );

  // amix would scale each input down by the number of inputs; the parts never
  // overlap, so summing them keeps every line at its recorded level.
  const filter = [
    ...chains,
    `${placed.map((_, i) => `[a${i}]`).join('')}amix=inputs=${placed.length}:duration=longest:normalize=0,` +
      `apad=whole_dur=${duration.toFixed(3)},atrim=duration=${duration.toFixed(3)}[a]`,
  ].join(';');

  await run('ffmpeg', [
    '-y', '-v', 'error',
    ...placed.flatMap((p) => ['-i', p.file]),
    '-filter_complex', filter,
    '-map', '[a]', '-c:a', 'pcm_s16le',
    out,
  ]);

  return out;
}

/**
 * Mix the voice over a music bed and master to the platform target.
 *
 * The bed is ducked by the voice rather than simply set quiet, so it stays present
 * in the gaps — the reference reels never drop to silence, not once in five files.
 */
export async function mixAudio({ voice, music, out, duration, bedLevel = 0.32 }) {
  if (!music) {
    await run('ffmpeg', [
      '-y', '-v', 'error', '-i', voice,
      '-af', `loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA},aresample=48000`,
      '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', out,
    ]);
    return out;
  }

  const filter = [
    `[1:a]aloop=loop=-1:size=2147483647,atrim=duration=${duration.toFixed(3)},` +
      `aresample=48000,volume=${bedLevel}[bed]`,
    `[0:a]aresample=48000,apad=whole_dur=${duration.toFixed(3)}[voice]`,
    `[voice]asplit=2[voiceMix][voiceKey]`,
    `[bed][voiceKey]sidechaincompress=threshold=0.045:ratio=6:attack=12:release=320[ducked]`,
    `[ducked][voiceMix]amix=inputs=2:duration=first:normalize=0[mixed]`,
    // loudnorm runs at 192 kHz internally and hands that rate on; without the
    // resample the finished reel shipped at 96 kHz.
    `[mixed]loudnorm=I=${LOUDNESS.I}:TP=${LOUDNESS.TP}:LRA=${LOUDNESS.LRA},aresample=48000[a]`,
  ].join(';');

  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', voice, '-i', music,
    '-filter_complex', filter,
    '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-t', duration.toFixed(3),
    out,
  ]);

  return out;
}

export async function mux({ video, audio, out }) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-i', video, '-i', audio,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    out,
  ]);
  return out;
}

/** Full assembly: segments + voice parts + optional music -> one reel. */
export async function buildReel({ segments, voiceParts, music, out, workDir }) {
  await fs.mkdir(workDir, { recursive: true });

  const silent = path.join(workDir, 'video.mp4');
  const voice = path.join(workDir, 'voice.wav');
  const audio = path.join(workDir, 'audio.m4a');

  await buildVideo({ segments, out: silent });
  const videoInfo = await probe(silent);

  // No narration is a degraded run, not a failed one — the bed still carries it.
  if (voiceParts.some((p) => p?.file)) {
    await buildVoice({ parts: voiceParts, out: voice, duration: videoInfo.duration });
    await mixAudio({ voice, music, out: audio, duration: videoInfo.duration });
  } else {
    await run('ffmpeg', [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
      '-t', videoInfo.duration.toFixed(3), '-c:a', 'pcm_s16le', voice,
    ]);
    await mixAudio({ voice, music, out: audio, duration: videoInfo.duration });
  }

  await mux({ video: silent, audio, out });

  return probe(out);
}
