#!/usr/bin/env node
// Render a statement / stat card scene from a JSON spec.
//
//   node pipeline/render-card.js --spec card.json --out out/card.mp4
//   node pipeline/render-card.js --demo hook --layout panel

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { captureScene } from './src/render/capture.js';
import { encodeFrames, probe } from './src/assemble/encode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DEMOS = {
  hook: {
    chips: ['PRE-MARKET', 'NSE'],
    headline: 'Market kholne se pehle',
    power: 'TEEN BAATEIN',
    footnote: 'Rajesh Technical Traders',
  },
  fii: {
    chips: ['FII FLOW', 'CASH MARKET'],
    headline: 'Lagataar teesre din',
    power: 'KHAREEDARI',
    stat: { value: '+2,847 Cr', label: 'Net buy · 3 din', direction: 'up' },
    footnote: 'Source: NSE provisional',
  },
};

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

  const spec = args.spec
    ? JSON.parse(await fs.readFile(args.spec, 'utf8'))
    : DEMOS[args.demo || 'hook'];
  if (!spec) { console.error(`Unknown demo "${args.demo}". Try: ${Object.keys(DEMOS).join(', ')}`); process.exit(1); }

  const layout = args.layout || 'full';
  const seconds = Number(args.seconds) || 5;
  const data = { ...spec, layout, totalFrames: Math.round(seconds * 30) };

  const frameDir = path.join(HERE, 'out', 'frames-card');
  const out = path.resolve(args.out || path.join(HERE, 'out', 'card.mp4'));

  const { totalFrames } = await captureScene({
    scenePath: path.join(HERE, 'src', 'render', 'scenes', 'card.html'),
    data,
    outDir: frameDir,
    height: layout === 'panel' ? 760 : 1280,
    onProgress: (f, total) => process.stdout.write(`\rcapturing ${f}/${total}`),
  });
  process.stdout.write(`\rcaptured ${totalFrames}/${totalFrames} frames\n`);

  await encodeFrames({ frameDir, out });
  const info = await probe(out);
  console.log(`${path.relative(process.cwd(), out)}  ${info.width}x${info.height}  ${info.fps}fps  ${info.duration.toFixed(2)}s`);
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
