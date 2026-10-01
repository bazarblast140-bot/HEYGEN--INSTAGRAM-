#!/usr/bin/env node
// Upload a built reel and print the public URL Instagram will fetch.
//
//   node pipeline/host-video.js --file pipeline/out/reel-final.mp4

import { hostVideo } from './src/publish/host.js';

const args = process.argv.slice(2);
const file = args[args.indexOf('--file') + 1];
const coverIdx = args.indexOf('--cover');
const cover = coverIdx === -1 ? '' : args[coverIdx + 1];
if (!file || file.startsWith('--')) { console.error('Pass --file <path to mp4>'); process.exit(1); }

const out = await hostVideo({ file, ...(cover && !cover.startsWith('--') ? { cover } : {}) });
console.log(out.url);
if (out.coverUrl) console.log(out.coverUrl);
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs');
  let output = `url=${out.url}\n`;
  if (out.coverUrl) output += `cover_url=${out.coverUrl}\n`;
  appendFileSync(process.env.GITHUB_OUTPUT, output);
}
