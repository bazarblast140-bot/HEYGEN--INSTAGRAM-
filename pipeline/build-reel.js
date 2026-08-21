#!/usr/bin/env node
// Build one complete reel from a spec.
//
//   node pipeline/build-reel.js --spec pipeline/specs/default.json
//   node pipeline/build-reel.js --spec ... --fixture      # synthetic market data
//   node pipeline/build-reel.js --spec ... --no-avatar    # skip HeyGen entirely
//
// Degrading rather than failing is the point of this file. HeyGen quota runs out,
// stock providers rate-limit, and a market holiday leaves no fresh candles — none
// of which should cost the day's post. Every optional stage falls back to something
// publishable and records what it did in the run report.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fetchCandles, summarise } from './src/harvest/yahoo.js';
import { fetchCandles as fetchFromStooq } from './src/harvest/stooq.js';
import { syntheticSeries } from './src/harvest/fixture.js';
import { captureScene } from './src/render/capture.js';
import { encodeFrames, probe } from './src/assemble/encode.js';
import { composeHybrid } from './src/assemble/compose.js';
import { buildReel } from './src/assemble/timeline.js';
import { burnCaptions } from './src/assemble/captions.js';
import { renderPresenter } from './src/presenter/segment.js';
import { renderVoice } from './src/presenter/voice.js';
import { fetchStock } from './src/stock/index.js';
import { run } from './src/assemble/encode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENES = path.join(HERE, 'src', 'render', 'scenes');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}

const notes = [];
const note = (msg) => { notes.push(msg); console.log(`  · ${msg}`); };

/** Silence of a known length, so a missing voice leaves a gap of the right size
 *  rather than collapsing the timeline or crashing the run. */
async function silence(seconds, out) {
  await run('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-t', seconds.toFixed(3), '-c:a', 'pcm_s16le', out,
  ]);
  return out;
}

/** TTS, or silence of the same length when HeyGen is unavailable. */
async function speakOrSilence({ text, seconds, out, label }) {
  try {
    const voice = await renderVoice({ text, out });
    return { file: voice.file, narrated: true, wordTimestamps: voice.wordTimestamps };
  } catch (err) {
    note(`voiceover unavailable for ${label} (${err.message.slice(0, 80)}) — silent for ${seconds.toFixed(1)}s`);
    return { file: await silence(seconds, out), narrated: false, wordTimestamps: [] };
  }
}

async function renderSceneClip({ scene, data, seconds, layout, out, workDir, tag }) {
  const frameDir = path.join(workDir, `frames-${tag}`);
  await captureScene({
    scenePath: path.join(SCENES, scene),
    data: { ...data, layout, totalFrames: Math.round(seconds * 30) },
    outDir: frameDir,
    height: layout === 'panel' ? 760 : 1280,
  });
  await encodeFrames({ frameDir, out });
  await fs.rm(frameDir, { recursive: true, force: true });
  return out;
}

/**
 * Avatar panel, with a fallback. When HeyGen refuses — monthly limit reached,
 * insufficient credit, plan restriction — the beat is rebuilt as a full-frame
 * card and the line is spoken by TTS instead. The reel loses the face, not the day.
 */
async function buildPresenterBeat({ segment, workDir, tag, useAvatar }) {
  const cardPanel = await renderSceneClip({
    scene: 'card.html', data: segment.card, seconds: segment.seconds,
    layout: 'panel', out: path.join(workDir, `${tag}-card.mp4`), workDir, tag: `${tag}-card`,
  });

  if (useAvatar) {
    try {
      const avatar = await renderPresenter({
        script: segment.say,
        out: path.join(workDir, `${tag}-avatar.mp4`),
        width: 1280, height: 720,
      });
      const out = path.join(workDir, `${tag}.mp4`);
      await composeHybrid({ chart: cardPanel, presenter: avatar.file, out });
      const info = await probe(out);
      return { file: out, duration: info.duration, voice: out, avatarSeconds: info.duration };
    } catch (err) {
      note(`avatar unavailable for "${tag}" (${err.message.slice(0, 90)}) — using a full-frame card instead`);
    }
  }

  const full = await renderSceneClip({
    scene: 'card.html', data: segment.card, seconds: segment.seconds,
    layout: 'full', out: path.join(workDir, `${tag}-full.mp4`), workDir, tag: `${tag}-full`,
  });
  const voice = await speakOrSilence({
    text: segment.say, seconds: segment.seconds,
    out: path.join(workDir, `${tag}-voice.wav`), label: tag,
  });
  return { file: full, duration: segment.seconds, voice: voice.file, avatarSeconds: 0, narrated: voice.narrated };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(await fs.readFile(args.spec || path.join(HERE, 'specs', 'default.json'), 'utf8'));

  const workDir = path.join(HERE, 'out', 'build');
  const out = path.resolve(args.out || path.join(HERE, 'out', 'reel-final.mp4'));
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  console.log('Market data');
  let series;
  if (args.fixture) {
    series = syntheticSeries();
    note('synthetic sample data — this reel must not be published');
  } else {
    // Two independent sources before giving up. Yahoo has the richer payload but
    // refuses CI address ranges outright; Stooq is plainer and answers.
    const sources = [
      ['Yahoo', () => fetchCandles(spec.chartSymbol || 'nifty', { range: spec.chartRange || '3mo' })],
      ['Stooq', () => fetchFromStooq(spec.chartSymbol || 'nifty')],
    ];

    const failures = [];
    for (const [name, fetchFrom] of sources) {
      try {
        series = await fetchFrom();
        if (failures.length) note(`${name} supplied the data after ${failures.join('; ')}`);
        break;
      } catch (err) {
        failures.push(`${name} failed (${err.message.slice(0, 70)})`);
      }
    }

    if (!series) {
      series = syntheticSeries();
      note(`no live market data — ${failures.join('; ')} — fell back to sample data`);
    }
  }
  const chartData = { ...series, summary: summarise(series), verdict: spec.verdict || '' };
  console.log(`  ${chartData.name}  ${chartData.summary.last.toFixed(2)}  ${chartData.summary.changePct >= 0 ? '+' : ''}${chartData.summary.changePct.toFixed(2)}%`);

  const useAvatar = !args['no-avatar'];
  const segments = [];
  const voiceParts = [];
  const captionBeats = [];
  let cursor = 0;
  let avatarSeconds = 0;
  let narrated = true;

  console.log('Segments');
  for (const [i, segment] of spec.segments.entries()) {
    const tag = `${String(i).padStart(2, '0')}-${segment.type}`;
    process.stdout.write(`  ${tag} … `);

    // Caption timings are laid against the cut, not the source clips, so the
    // running cursor has to advance for every beat that survives.
    const captionFor = (duration) => {
      if (segment.caption) {
        captionBeats.push({ start: cursor, duration, text: segment.caption, power: segment.power });
      }
      cursor += duration;
    };

    if (segment.type === 'hook' || segment.type === 'cutin') {
      const beat = await buildPresenterBeat({ segment, workDir, tag, useAvatar });
      segments.push({ kind: 'hybrid', file: beat.file, duration: beat.duration });
      voiceParts.push({ file: beat.voice, start: cursor });
      captionFor(beat.duration);
      avatarSeconds += beat.avatarSeconds;
      if (beat.narrated === false) narrated = false;

    } else if (segment.type === 'chart') {
      const file = await renderSceneClip({
        scene: 'candles.html', data: chartData, seconds: segment.seconds,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });
      segments.push({ kind: 'scene', file, duration: segment.seconds });
      captionFor(segment.seconds);

    } else if (segment.type === 'card') {
      const file = await renderSceneClip({
        scene: 'card.html', data: segment.card, seconds: segment.seconds,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });
      segments.push({ kind: 'scene', file, duration: segment.seconds });
      captionFor(segment.seconds);

    } else if (segment.type === 'stock') {
      try {
        const clip = await fetchStock(segment.query, { outDir: path.join(workDir, 'stock') });
        segments.push({ kind: 'stock', file: clip.file, duration: segment.seconds });
        captionFor(segment.seconds);
      } catch (err) {
        note(`no stock footage for "${segment.query}" (${err.message.slice(0, 70)}) — beat dropped`);
        process.stdout.write('skipped\n');
        continue;
      }

    } else {
      throw new Error(`Unknown segment type "${segment.type}" at index ${i}`);
    }
    process.stdout.write('ok\n');
  }

  if (spec.body) {
    console.log('Voiceover');
    // The body narration spans the beats between the hook and the cut-in, so its
    // silent fallback must be that long too.
    const cutinIndex = spec.segments.findIndex((seg) => seg.type === 'cutin');
    const spanEnd = cutinIndex > 0 ? cutinIndex : segments.length;
    const bodySeconds = segments.slice(1, spanEnd).reduce((n, seg) => n + seg.duration, 0) || 10;
    const bodyVoice = await speakOrSilence({
      text: spec.body, seconds: bodySeconds,
      out: path.join(workDir, 'body-voice.wav'), label: 'body narration',
    });
    if (!bodyVoice.narrated) narrated = false;
    // The body narration starts where the hook's picture ends.
    voiceParts.push({ file: bodyVoice.file, start: segments[0]?.duration || 0 });
    if (bodyVoice.wordTimestamps.length) {
      await fs.writeFile(path.join(workDir, 'word-timestamps.json'), JSON.stringify(bodyVoice.wordTimestamps, null, 2));
      console.log(`  ${bodyVoice.wordTimestamps.length} word timings saved for the caption pass`);
    }
  }

  console.log('Assembling');
  const music = spec.music ? path.resolve(HERE, spec.music) : undefined;
  const silentCut = path.join(workDir, 'cut.mp4');
  await buildReel({ segments, voiceParts, music, out: silentCut, workDir: path.join(workDir, 'assemble') });

  let info;
  if (captionBeats.length) {
    console.log(`Captions (${captionBeats.length} beats)`);
    await burnCaptions({
      video: silentCut,
      beats: captionBeats,
      out,
      fontsDir: path.join(HERE, 'assets', 'fonts-ttf'),
    });
    info = await probe(out);
  } else {
    await fs.copyFile(silentCut, out);
    info = await probe(out);
    note('no caption text in the spec — nothing burned in');
  }

  const report = {
    out,
    width: info.width, height: info.height, fps: info.fps,
    duration: Number(info.duration.toFixed(2)),
    sizeMB: Number((info.sizeBytes / 1024 / 1024).toFixed(2)),
    hasAudio: info.hasAudio,
    avatarSeconds: Number(avatarSeconds.toFixed(2)),
    narrated,
    synthetic: Boolean(series.synthetic),
    publishable: narrated && !series.synthetic,
    notes,
  };
  await fs.writeFile(path.join(path.dirname(out), 'run-report.json'), JSON.stringify(report, null, 2));

  // The caption is written next to the video so the publish step never has to
  // reconstruct it, and so a bad caption is visible in the artifact before it ships.
  const caption = [
    spec.caption?.trim(),
    spec.hashtags?.length ? spec.hashtags.join(' ') : null,
    spec.disclaimer?.trim(),
  ].filter(Boolean).join('\n\n');
  await fs.writeFile(path.join(path.dirname(out), 'caption.txt'), caption);

  console.log(
    `\n${path.relative(process.cwd(), out)}  ${info.width}x${info.height}  ${info.fps}fps  ` +
    `${report.duration}s  ${report.sizeMB}MB  avatar ${report.avatarSeconds}s`,
  );

  const problems = [];
  if (info.width !== 1080 || info.height !== 1920) problems.push(`expected 1080x1920, got ${info.width}x${info.height}`);
  if (!info.hasAudio) problems.push('no audio track');
  if (info.duration > 90) problems.push(`${report.duration}s exceeds Instagram's 90s reel limit`);
  if (info.duration < 3) problems.push(`${report.duration}s is too short to publish`);
  if (problems.length) { console.error('FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }

  const blockers = [
    series.synthetic && 'sample market data',
    !narrated && 'no voiceover',
  ].filter(Boolean);

  if (blockers.length) console.log(`checks passed — NOT PUBLISHABLE: ${blockers.join(', ')}`);
  else console.log('checks passed — publishable');
}

main().catch((err) => { console.error(`\n${err.stack || err.message}`); process.exit(1); });
