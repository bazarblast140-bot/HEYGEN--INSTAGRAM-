#!/usr/bin/env node
// Phase 1 CLI: market series -> animated 9:16 chart clip.
//
//   node pipeline/render-chart.js --fixture              # synthetic data, works offline
//   node pipeline/render-chart.js --symbol nifty         # live Yahoo data
//   node pipeline/render-chart.js --symbol RELIANCE.NS --range 6mo --out out/reliance.mp4

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchCandles, summarise } from './src/harvest/yahoo.js';
import { syntheticSeries } from './src/harvest/fixture.js';
import { captureScene } from './src/render/capture.js';
import { encodeFrames, probe } from './src/assemble/encode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

/** The serif power-word the reel lands on. Reads the move, never advises on it. */
function verdictFor(summary) {
  const pct = summary.changePct;
  if (pct >= 1.5) return 'ZORDAAR RALLY';
  if (pct >= 0.5) return 'MAZBOOT BAND';
  if (pct > 0) return 'HALKI TEZI';
  if (pct > -0.5) return 'FLAT BAND';
  if (pct > -1.5) return 'DABAAV MEIN';
  return 'BADI GIRAAVAT';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const series = args.fixture
    ? syntheticSeries()
    : await fetchCandles(args.symbol || 'nifty', { range: args.range || '3mo' });

  const summary = summarise(series);
  const layout = args.layout || 'full';
  if (!['full', 'panel'].includes(layout)) { console.error(`--layout must be full or panel`); process.exit(1); }
  const data = { ...series, summary, layout, verdict: args.verdict || verdictFor(summary) };

  console.log(`${data.name}  ${data.candles.length} bars  ${summary.last.toFixed(2)}  ${summary.changePct >= 0 ? '+' : ''}${summary.changePct.toFixed(2)}%${data.synthetic ? '   [SAMPLE DATA]' : ''}`);

  const frameDir = path.join(HERE, 'out', 'frames');
  const out = path.resolve(args.out || path.join(HERE, 'out', 'chart.mp4'));

  const { totalFrames } = await captureScene({
    scenePath: path.join(HERE, 'src', 'render', 'scenes', 'candles.html'),
    data,
    outDir: frameDir,
    height: layout === 'panel' ? 760 : 1280,
    onProgress: (f, total) => process.stdout.write(`\rcapturing ${f}/${total}`),
  });
  process.stdout.write(`\rcaptured ${totalFrames}/${totalFrames} frames\n`);

  await encodeFrames({ frameDir, out });

  const info = await probe(out);
  console.log(
    `${path.relative(process.cwd(), out)}  ${info.width}x${info.height}  ${info.fps}fps  ` +
    `${info.duration.toFixed(2)}s  ${(info.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
  );

  const problems = [];
  const expect = layout === 'panel' ? { w: 1080, h: 1140 } : { w: 1080, h: 1920 };
  if (info.width !== expect.w || info.height !== expect.h) problems.push(`expected ${expect.w}x${expect.h}, got ${info.width}x${info.height}`);
  if (Math.abs(info.fps - 30) > 0.01) problems.push(`expected 30fps, got ${info.fps}`);
  if (info.frames !== null && info.frames !== totalFrames) problems.push(`expected ${totalFrames} frames, got ${info.frames}`);
  if (problems.length) { console.error('FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('checks passed');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
