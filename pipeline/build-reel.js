#!/usr/bin/env node
// Build one complete reel from a spec. No avatar and no HeyGen.
//
//   node pipeline/build-reel.js --spec pipeline/specs/default.json
//   node pipeline/build-reel.js --spec ... --fixture      # synthetic market data
//   node pipeline/build-reel.js --spec ... --no-voice     # offline picture only
//
// The script is DeepSeek (or an optional fallback provider). The voice is
// ElevenLabs. The picture is kinetic text, the chart, and stock b-roll.
// If the script or the voice fails, the run stops and does not publish.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { fetchCandles, summarise } from './src/harvest/yahoo.js';
import { fetchCandles as fetchFromStooq } from './src/harvest/stooq.js';
import { fetchCandles as fetchFromApi, configuredProviders } from './src/harvest/apis.js';
import { motifFor } from './src/script/families.js';
import { syntheticSeries } from './src/harvest/fixture.js';
import { captureScene } from './src/render/capture.js';
import { encodeFrames, probe } from './src/assemble/encode.js';
import { buildReel } from './src/assemble/timeline.js';
import { burnCaptions } from './src/assemble/captions.js';
import { renderNarration, alignBeats } from './src/presenter/narration.js';
import { fetchStock } from './src/stock/index.js';
import { generateSpec, durationNote } from './src/script/generate.js';
import { shapeCaption } from './src/publish/caption.js';
import { coverTimestamp } from './src/render/reveal.js';
import { fitPlan, REEL_MIN_SECONDS, REEL_MAX_SECONDS } from './src/assemble/fit.js';
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
 * A card that prints the same figure twice.
 *
 * The generator is free to set `power` and `stat.value` to the same string, and
 * it does: one reel had "+25%" set in display serif and "+25%" again as the big
 * green figure, on the same card, six inches apart. The stat keeps its label, so
 * the power line is the one that goes.
 */
function dedupeCard(card) {
  if (!card) return card;
  const power = String(card.power || '').trim().toLowerCase();
  const stat = String(card.stat?.value || '').trim().toLowerCase();
  return power && power === stat ? { ...card, power: '' } : card;
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
    // A keyed provider first, then the keyless ones.
    //
    // The order is the wrong way round from how this started, and deliberately
    // so: swept from inside Actions, Yahoo answers 429 and Stooq answers HTML,
    // every time. They stay in the chain because they cost nothing to try and
    // they do work from a laptop, but a scheduled 7am job cannot depend on them.
    const symbol = spec.chartSymbol || 'nifty';
    const sources = [
      ...(configuredProviders().length
        ? [['Data API', () => fetchFromApi(symbol, { onAttempt: (n) => process.stdout.write(`  trying ${n}\n`) })]]
        : []),
      ['Yahoo', () => fetchCandles(symbol, { range: spec.chartRange || '3mo' })],
      ['Stooq', () => fetchFromStooq(symbol)],
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
      if (!configuredProviders().length) {
        note('set TWELVEDATA_API_KEY or ALPHAVANTAGE_API_KEY — no keyless source reaches a CI runner');
      }
    }
  }
  if (series.tracks) {
    note(`${series.name} stood in for ${series.tracks} — the percentage is the index's, the level is the E T F's`);
  }

  const summary = summarise(series);

  // Without this the pipeline posts the same reel every morning: the checked-in
  // spec is a fixture, not a brief. Generating it from the day's numbers is the
  // difference between a scheduled job and a daily show.
  let freshScript = false;
  if (args.generate || args.preview) {
    freshScript = false;
    console.log(args.preview ? 'Preview — writing today\'s script without posting' : 'Writing today\'s script');
    try {
      const written = await generateSpec({
        market: {
          name: series.name, tracks: series.tracks || null, source: series.source,
          summary, recent: series.candles.slice(-10),
        },
        news: spec.news,
        record: !args.preview,
        onAttempt: (n, model) => console.log(`  ${model}, attempt ${n}`),
      });
      // Keep the parts of the checked-in spec that are staging, not content.
      spec = { ...spec, ...written.spec, disclaimer: spec.disclaimer, music: spec.music };
      freshScript = true;
      note(`script written by ${written.model} in ${written.attempts} attempt(s)`);
      await fs.writeFile(path.join(HERE, 'out', 'spec-generated.json'), JSON.stringify(spec, null, 2));
    } catch (err) {
      console.log(`script generation failed: ${err.message}`);
      if (args['require-generated'] || args.preview) {
        console.error('Generation failed. This run will not publish the checked-in spec.');
        process.exit(1);
      }
      note('script generation failed — checked-in spec is not publishable');
    }
  }

  const chartData = { ...series, summary, verdict: spec.verdict || '' };
  console.log(`  ${chartData.name}  ${chartData.summary.last.toFixed(2)}  ${chartData.summary.changePct >= 0 ? '+' : ''}${chartData.summary.changePct.toFixed(2)}%`);

  // --no-voice is only for an offline picture check. A real build speaks, and
  // it stops if ElevenLabs does not.
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
        workDir: path.join(workDir, 'narration'),
        onNote: note,
      });
      console.log(`  ${narration.duration.toFixed(1)}s via ElevenLabs (${narration.provider})`);
    } catch (err) {
      const status = err.status ? `HTTP ${err.status}` : 'HTTP n/a';
      console.error(`ElevenLabs narration failed (${status}): ${err.message}`);
      console.error('This run will not publish.');
      process.exit(1);
    }
  } else if ((args['require-generated'] || args.preview) && !args['no-voice']) {
    console.error('ElevenLabs narration failed (HTTP n/a): the script has no spoken lines.');
    console.error('This run will not publish.');
    process.exit(1);
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

  // The family the script chose decides the texture behind every card in this
  // reel. Chosen once here rather than per beat, so one reel is one look.
  const motif = motifFor(spec.family);
  if (spec.family) note(`${spec.family} topic — "${motif}" motif`);

  const segments = [];
  const captionBeats = [];
  let cursor = 0;
  let cardIndex = -1;

  console.log('Segments');
  for (const [i, segment] of spec.segments.entries()) {
    const tag = `${String(i).padStart(2, '0')}-${segment.type}`;
    const duration = durations[i];
    process.stdout.write(`  ${tag} ${duration.toFixed(1)}s … `);

    let file = null;
    let beatTheme = 'dark';
    let captionSuppressed = false;
    // An article beat is already dense with type. A burned-in caption on top of
    // a scrolling document is two things asking to be read at once.
    if (segment.type === 'article') captionSuppressed = true;

    if (i === 0 && segment.type === 'hook') {
      // Frame 0 is the hook, fully drawn. There is no presenter.
      beatTheme = 'dark';
      const hookCard = segment.card || {
        chips: [],
        headline: segment.caption || segment.power || '',
        power: segment.power || '',
        footnote: '',
      };
      file = await renderSceneClip({
        scene: 'card.html',
        data: { ...dedupeCard(hookCard), theme: beatTheme, motif, instant: true },
        seconds: duration,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });

    } else if (segment.type === 'hook' || segment.type === 'cutin') {
      // A cut-in is a kinetic text card, not a face. When it repeats the next
      // card's headline, build the card from this beat's own words instead.
      const next = spec.segments[i + 1]?.card;
      const repeatsNeighbour = segment.card && next
        && String(segment.card.headline || '').trim().toLowerCase()
           === String(next.headline || '').trim().toLowerCase();

      // On a normal card the power word is a phrase the headline does not contain.
      // The substitute card is built from the caption, so its power word is often
      // a slice of its own headline — "is number ko dhyan se" over "DHYAN SE".
      // Emphasis on a word already on screen is repetition, so it is dropped.
      const substituteHead = String(segment.caption || '').trim();
      const substitutePower = String(segment.power || '').trim();
      const powerInHeadline = substitutePower
        && substituteHead.toLowerCase().includes(substitutePower.toLowerCase());

      const fallbackCard = repeatsNeighbour
        ? {
            chips: [],
            headline: substituteHead,
            power: powerInHeadline ? '' : substitutePower,
            stat: null,
            footnote: '',
          }
        : dedupeCard(segment.card);

      // The substitute card is built out of this beat's caption and power word.
      // Burning the caption on top of it then prints the same phrase twice on the
      // card and twice again below it — "DHYAN SE" appeared four times in one
      // frame. The card is now carrying those words, so the caption stands down.
      if (repeatsNeighbour) captionSuppressed = true;

      file = await renderSceneClip({
        scene: 'card.html',
        data: { ...(fallbackCard || { chips: [], headline: segment.caption || '', power: segment.power || '', footnote: '' }), theme: 'ink', motif },
        seconds: duration,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });

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
        data: { ...dedupeCard(segment.card), theme: beatTheme, motif },
        seconds: duration,
        layout: 'full', out: path.join(workDir, `${tag}.mp4`), workDir, tag,
      });

    } else if (segment.type === 'article') {
      // The document beat: it scrolls to the sentence the narration is about and
      // marks it. Its own attribution strip is part of the scene, not an overlay.
      file = await renderSceneClip({
        scene: 'article.html',
        data: { ...segment.article, theme: beatTheme },
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

    if (captionText && !captionEchoes && !captionSuppressed) {
      captionBeats.push({
        start: cursor, duration, text: captionText,
        power: powerEchoes ? null : segment.power,
        theme: beatTheme,
        region: 'lower',
      });
    }

    cursor += duration;
    process.stdout.write('ok\n');
  }

  const narrated = Boolean(narration) && narration.provider === 'elevenlabs';

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

  const plan = fitPlan(info.duration);
  if (plan.action === 'speed' || plan.action === 'slow') {
    const fitted = out.replace(/\.mp4$/, '.fit.mp4');
    try {
      await run('ffmpeg', [
        '-y', '-v', 'error', '-i', out,
        '-filter_complex', `[0:v]setpts=PTS/${plan.factor}[v];[0:a]atempo=${plan.factor}[a]`,
        '-map', '[v]', '-map', '[a]',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-movflags', '+faststart',
        fitted,
      ]);
      await fs.rename(fitted, out);
      info = await probe(out);
      note(`length fitted to ${info.duration.toFixed(2)}s`);
    } catch (err) {
      note(`could not fit the reel into 20–30s (${String(err.message).slice(0, 80)})`);
    }
  }

  const coverPath = path.join(path.dirname(out), 'reel-cover.jpg');
  let cover = null;
  try {
    const seek = coverTimestamp({ instant: true });
    await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(seek), '-i', out, '-frames:v', '1', '-q:v', '2', coverPath]);
    cover = coverPath;
  } catch (err) {
    note(`cover frame not extracted (${String(err.message).slice(0, 80)})`);
  }

  const lengthOk = info.duration >= REEL_MIN_SECONDS && info.duration <= REEL_MAX_SECONDS;
  const lengthNote = durationNote(info.duration);
  if (lengthNote) note(lengthNote);
  if (!lengthOk && (args['require-generated'] || args.preview)) {
    console.error(`Reel is ${info.duration.toFixed(2)}s, outside 20–30s, so this run will not publish.`);
    process.exit(1);
  }

  const report = {
    out,
    cover,
    width: info.width, height: info.height, fps: info.fps,
    duration: Number(info.duration.toFixed(2)),
    sizeMB: Number((info.sizeBytes / 1024 / 1024).toFixed(2)),
    hasAudio: info.hasAudio,
    avatarSeconds: 0,
    narrated,
    voiceSource: narration?.provider || null,
    synthetic: Boolean(series.synthetic),
    fresh: freshScript,
    publishable: freshScript && narrated && !series.synthetic && lengthOk,
    notes,
  };
  await fs.writeFile(path.join(path.dirname(out), 'run-report.json'), JSON.stringify(report, null, 2));

  // The caption is written next to the video so the publish step never has to
  // reconstruct it, and so a bad caption is visible in the artifact before it ships.
  const caption = shapeCaption({
    caption: [spec.caption?.trim(), spec.disclaimer?.trim()].filter(Boolean).join('\n\n'),
    hashtags: spec.hashtags || [],
  });
  await fs.writeFile(path.join(path.dirname(out), 'caption.txt'), caption);

  console.log(
    `\n${path.relative(process.cwd(), out)}  ${info.width}x${info.height}  ${info.fps}fps  ` +
    `${report.duration}s  ${report.sizeMB}MB  voice ${report.voiceSource || 'none'}`,
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
    !freshScript && 'script was not freshly generated',
    !lengthOk && 'outside 20–30 seconds',
  ].filter(Boolean);

  if (blockers.length) console.log(`checks passed — NOT PUBLISHABLE: ${blockers.join(', ')}`);
  else console.log('checks passed — publishable');
}

main().catch((err) => { console.error(`\n${err.stack || err.message}`); process.exit(1); });
