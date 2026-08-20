#!/usr/bin/env node
// Build one hybrid frame: chart panel on top, presenter below.
//
//   node pipeline/compose-hybrid.js --chart out/chart-panel.mp4 --presenter out/x.mp4
//   node pipeline/compose-hybrid.js --chart out/chart-panel.mp4 --script "Aaj Nifty..."
//
// With --script and no --presenter, the presenter clip is generated from the
// HeyGen avatar and voice in .env first.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeHybrid, FRAME } from './src/assemble/compose.js';
import { probe } from './src/assemble/encode.js';
import { renderPresenter } from './src/presenter/segment.js';

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chart = path.resolve(args.chart || path.join(HERE, 'out', 'chart-panel.mp4'));
  const out = path.resolve(args.out || path.join(HERE, 'out', 'hybrid.mp4'));

  let presenter = args.presenter && path.resolve(args.presenter);
  if (!presenter) {
    if (!args.script) {
      console.error('Pass --presenter <file>, or --script "..." to generate one from HeyGen.');
      process.exit(1);
    }
    console.log('Generating presenter clip from HeyGen...');
    const result = await renderPresenter({
      script: args.script,
      avatarId: args.avatar,
      voiceId: args.voice,
      out: path.join(HERE, 'out', 'presenter.mp4'),
      onStatus: (s) => process.stdout.write(`\r  ${s.status}      `),
    });
    process.stdout.write('\n');
    presenter = result.file;
  }

  const { duration, chartDuration } = await composeHybrid({ chart, presenter, out });

  const info = await probe(out);
  console.log(
    `${path.relative(process.cwd(), out)}  ${info.width}x${info.height}  ${info.fps}fps  ` +
    `${info.duration.toFixed(2)}s  audio:${info.hasAudio ? 'yes' : 'no'}  ` +
    `${(info.sizeBytes / 1024 / 1024).toFixed(2)}MB`,
  );
  if (chartDuration < duration) {
    console.log(`chart held ${(duration - chartDuration).toFixed(2)}s to match the voiceover`);
  }

  const problems = [];
  if (info.width !== FRAME.width || info.height !== FRAME.height) {
    problems.push(`expected ${FRAME.width}x${FRAME.height}, got ${info.width}x${info.height}`);
  }
  if (Math.abs(info.duration - duration) > 0.12) {
    problems.push(`expected ~${duration.toFixed(2)}s, got ${info.duration.toFixed(2)}s`);
  }
  if (problems.length) { console.error('FAILED:\n  ' + problems.join('\n  ')); process.exit(1); }
  console.log('checks passed');
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
