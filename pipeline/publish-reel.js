#!/usr/bin/env node
// Publish a built reel to Instagram.
//
//   node pipeline/publish-reel.js --whoami
//   node pipeline/publish-reel.js --url https://.../reel.mp4 --caption-file caption.txt
//   node pipeline/publish-reel.js --url ... --report pipeline/out/run-report.json
//
// The video must already be at a public https URL — Instagram fetches it itself
// and never accepts an upload.

import fs from 'node:fs/promises';
import { publishReel, whoami } from './src/publish/instagram.js';

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

  if (args.whoami) {
    const me = await whoami();
    console.log(JSON.stringify(me, null, 2));
    return;
  }

  if (!args.url) { console.error('Pass --url <public https url to the mp4>'); process.exit(1); }

  // A run report from build-reel.js knows whether the reel is fit to publish.
  // Refuse sample-data or silent reels here rather than discovering it on the feed.
  if (args.report) {
    const report = JSON.parse(await fs.readFile(args.report, 'utf8'));
    if (!report.publishable) {
      console.error(`Refusing to publish: ${report.notes?.join('; ') || 'run report says not publishable'}`);
      process.exit(1);
    }
  }

  const caption = args['caption-file']
    ? await fs.readFile(args['caption-file'], 'utf8')
    : args.caption || '';

  const { mediaId } = await publishReel({
    videoUrl: args.url,
    caption,
    onStatus: (stage, value) => console.log(`  ${stage}: ${value}`),
  });

  console.log(`published: ${mediaId}`);
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
