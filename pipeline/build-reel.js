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
import { renderNarration, cutPresenterWindow, alignBeats } from './src/presenter/narration.js';
import { fetchStock } from './src/stock/index.js';
import { generateSpec } from './src/script/generate.js';
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

/**
 * Beat lengths follow the speech, not the other way round.
 *
 * A beat's share of the reel is its share of the spoken words. That is what makes
 * the picture land on the words: a beat with twice the words gets twice the time,
 * and the totals match the narration exactly rather than approximately.
 */
function allocateDurations(beats, totalSeconds) {
  const words = beats.map((b) => Math.max(1, String(b.say || b.caption || '').trim().split(/\s+/).filter(Boolean).length));
  const totalWords = words.reduce((a, b) => a + b, 0);

  // A minimum stops a three-word beat from flashing past unreadably; the surplus
  // it takes is reclaimed from the longer beats in proportion.
  const MIN = 1.9;
  let raw = words.map((w) => (w / totalWords) * totalSeconds);
  const shortfall = raw.reduce((acc, d) => acc + Math.max(0, MIN - d), 0);
  const spare = raw.reduce((acc, d) => acc + Math.max(0, d - MIN), 0);

  return raw.map((d) => (d < MIN ? MIN : d - (spare ? (shortfall * (d - MIN)) / spare : 0)));
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
async function buildPresenterBeat({ segment, workDir, tag, narration, start, duration }) {
  const cardPanel = await renderSceneClip({
    scene: 'card.html', data: segment.card, seconds: duration,
    layout: 'panel', out: path.join(workDir, `${tag}-card.mp4`), workDir, tag: `${tag}-card`,
  });

  if (!narration?.video) {
    // No presenter footage — either no narration at all, or narration that came
    // from speech synthesis rather than an avatar render. Either way there is no
    // face to stack, so show the card full frame instead of a blank panel.
    const full = await renderSceneClip({
      scene: 'card.html', data: segment.card, seconds: duration,
      layout: 'full', out: path.join(workDir, `${tag}-full.mp4`), workDir, tag: `${tag}-full`,
    });
    return { file: full, avatarSeconds: 0 };
  }

  const window = await cutPresenterWindow({
    narration, start, duration, out: path.join(workDir, `${tag}-presenter.mp4`),
  });

  const out = path.join(workDir, `${tag}.mp4`);
  await composeHybrid({ chart: cardPanel, presenter: window, out });
  return { file: out, avatarSeconds: duration };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args.spec || path.join(HERE, 'specs', 'default.json');
  let spec = JSON.parse(await fs.readFile(specPath, 'utf8'));

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
  const summary = summarise(series);

  // Without this the pipeline posts the same reel every morning: the checked-in
  // spec is a fixture, not a brief. Generating it from the day's numbers is the
  // difference between a scheduled job and a daily show.
  if (args.generate) {
    console.log('Writing today\'s script');
    try {
      const written = await generateSpec({
        market: { name: series.name, source: series.source, summary, recent: series.candles.slice(-10) },
        news: spec.news,
        onAttempt: (n, model) => console.log(`  ${model}, attempt ${n}`),
      });
      // Keep the parts of the checked-in spec that are staging, not content.
      spec = { ...spec, ...written.spec, disclaimer: spec.disclaimer, music: spec.music };
      note(`script written by ${written.model} in ${written.attempts} attempt(s)`);
      await fs.writeFile(path.join(HERE, 'out', 'spec-generated.json'), JSON.stringify(spec, null, 2));
    } catch (err) {
      note(`script generation failed (${err.message.slice(0, 110)}) — using the checked-in spec`);
    }
  }

  const chartData = { ...series, summary, verdict: spec.verdict || '' };
  console.log(`  ${chartData.name}  ${chartData.summary.last.toFixed(2)}  ${chartData.summary.changePct >= 0 ? '+' : ''}${chartData.summary.changePct.toFixed(2)}%`);

  // Two separate switches. --no-avatar drops the face and keeps the voice, which
  // is what an exhausted HeyGen allowance does anyway; --no-voice is for offline
  // builds where nothing can reach the API at all.
  const wantFace = !args['no-avatar'];
  const wantVoice = !args['no-voice'];

  // Every spoken word in the reel, in the order it is heard. One voice throughout.
  const spokenPerBeat = spec.segments.map((seg) => String(seg.say || seg.caption || '').trim());
  const fullScript = spokenPerBeat.filter(Boolean).join(' ');

  let narration = null;
  if (wantVoice && fullScript) {
    console.log('Recording the narration');
    try {
      narration = await renderNarration({
        script: fullScript,
        wantFace,
        workDir: path.join(workDir, 'narration'),
        onStatus: (st) => process.stdout.write(`\r  ${st.status}      `),
        onNote: note,
      });
      process.stdout.write('\n');
      const how = narration.source === 'avatar' ? 'avatar render' : 'speech synthesis';
      console.log(`  ${narration.duration.toFixed(1)}s in Rajesh's voice via ${how}`);
    } catch (err) {
      note(`narration unavailable (${err.message.slice(0, 110)}) — the reel will be silent`);
    }
  }

  // Beat lengths follow the narration, so the picture lands on the words. Prefer
  // the synthesiser's own word timings; fall back to word-share estimation when
  // it did not give any.
  const durations = narration
    ? (alignBeats({
        words: narration.words,
        spokenPerBeat,
        totalDuration: narration.duration,
      }) || allocateDurations(spec.segments, narration.duration))
    : spec.segments.map((seg) => seg.seconds || 3);

  const segments = [];
  const captionBeats = [];
  let avatarSeconds = 0;
  let cursor = 0;
  let cardIndex = -1;

  console.log('Segments');
  for (const [i, segment] of spec.segments.entries()) {
    const tag = `${String(i).padStart(2, '0')}-${segment.type}`;
    const duration = durations[i];
    process.stdout.write(`  ${tag} ${duration.toFixed(1)}s … `);

    let file = null;
    let beatTheme = 'dark';

    if (segment.type === 'hook' || segment.type === 'cutin') {
      const beat = await buildPresenterBeat({ segment, workDir, tag, narration, start: cursor, duration });
      file = beat.file;
      avatarSeconds += beat.avatarSeconds;

    } else if (segment.type === 'chart') {
      file = await renderSceneClip({
        scene: 'candles.html', data: chartData, seconds: duration,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });

    } else if (segment.type === 'card') {
      // Rotate the ground so no two full-frame cards in a row look alike. Assigned
      // here rather than asked for, because a model choosing themes freely produces
      // runs of the same one, which is the failure this exists to prevent.
      const THEMES = ['dark', 'light', 'ink'];
      cardIndex += 1;
      beatTheme = segment.card?.theme || THEMES[cardIndex % THEMES.length];
      file = await renderSceneClip({
        scene: 'card.html',
        data: { ...segment.card, theme: beatTheme },
        seconds: duration,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });

    } else if (segment.type === 'stock') {
      try {
        const clip = await fetchStock(segment.query, { outDir: path.join(workDir, 'stock') });
        file = clip.file;
      } catch (err) {
        note(`no stock footage for "${segment.query}" (${err.message.slice(0, 70)}) — card instead`);
        file = await renderSceneClip({
          scene: 'card.html', data: segment.card || { chips: [], headline: segment.caption || '', power: segment.power || '', footnote: '' },
          seconds: duration, layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
        });
      }

    } else {
      throw new Error(`Unknown segment type "${segment.type}" at index ${i}`);
    }

    segments.push({ kind: segment.type === 'stock' ? 'stock' : 'scene', file, duration });

    // A caption that repeats the card word for word is clutter, not emphasis —
    // the previous cut showed the same phrase twice on screen. Presenter beats and
    // chart beats have no card text of their own, so those are the ones captioned.
    // The card already prints its headline and its power word. Repeating either in
    // the caption puts the same phrase on screen twice, which is what made the
    // previous cut look cluttered — so the caption keeps only what the card omits.
    const cardText = `${segment.card?.headline || ''} ${segment.card?.power || ''}`.toLowerCase();
    const captionText = String(segment.caption || '').trim();
    const captionEchoes = captionText && cardText.includes(captionText.toLowerCase().slice(0, 14));

    const power = String(segment.power || '').trim();
    const powerEchoes = power && cardText.includes(power.toLowerCase());

    if (captionText && !captionEchoes) {
      captionBeats.push({
        start: cursor, duration, text: captionText,
        power: powerEchoes ? null : segment.power,
        theme: beatTheme,
      });
    }

    cursor += duration;
    process.stdout.write('ok\n');
  }

  const narrated = Boolean(narration);
  // Losing the face is a downgrade worth posting; losing the voice is not.
  if (narrated && narration.source === 'speech') {
    note("no avatar allowance left — Rajesh's voice over cards, no face this time");
  }

  console.log('Assembling');
  const music = spec.music ? path.resolve(HERE, spec.music) : undefined;
  const silentCut = path.join(workDir, 'cut.mp4');
  await buildReel({
    segments,
    voiceParts: narration ? [{ file: narration.audio, start: 0 }] : [],
    music,
    out: silentCut,
    workDir: path.join(workDir, 'assemble'),
  });

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
    voiceSource: narration?.source || null,
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
    `${report.duration}s  ${report.sizeMB}MB  avatar ${report.avatarSeconds}s  voice ${report.voiceSource || 'none'}`,
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
