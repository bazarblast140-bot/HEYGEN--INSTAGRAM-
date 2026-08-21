#!/usr/bin/env node
// Upload a built reel and print the public URL Instagram will fetch.
//
//   node pipeline/host-video.js --file pipeline/out/reel-final.mp4

import { hostVideo } from './src/publish/host.js';

const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
if (!file || file.startsWith('--')) { console.error('Pass --file <path to mp4>'); process.exit(1); }

const out = await hostVideo({ file });
console.log(out.url);
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_OUTPUT, `url=${out.url}\n`);
}
