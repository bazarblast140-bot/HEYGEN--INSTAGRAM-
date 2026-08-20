#!/usr/bin/env node
// CLI: generate one Instagram reel from a script file or inline text.
//
//   npm run generate -- --script "Aaj ka topic..." --avatar <id> --voice <id>
//   npm run generate -- --file script.txt --preset feed --out downloads/

import fs from 'node:fs/promises';
import path from 'node:path';
import { generateVideo, getVideoStatus } from '../src/heygen.js';
import { config, PRESETS, MAX_SCRIPT_WORDS } from '../src/config.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const script = args.file ? (await fs.readFile(args.file, 'utf8')).trim() : String(args.script || '').trim();
  if (!script) {
    console.error('Usage: npm run generate -- --script "your text" [--file script.txt] [--avatar ID] [--voice ID] [--preset reel|feed|landscape] [--out DIR]');
    process.exit(1);
  }

  const wordCount = script.split(/\s+/).length;
  if (wordCount > MAX_SCRIPT_WORDS) {
    console.error(`Script is ${wordCount} words — trim it under ${MAX_SCRIPT_WORDS} to stay inside Instagram's 90s reel limit.`);
    process.exit(1);
  }

  const avatarId = args.avatar || config.defaultAvatarId;
  const voiceId = args.voice || config.defaultVoiceId;
  if (!avatarId || !voiceId) {
    console.error('Missing avatar/voice. Pass --avatar and --voice, or set DEFAULT_AVATAR_ID / DEFAULT_VOICE_ID in .env');
    process.exit(1);
  }

  const preset = PRESETS[args.preset || 'reel'];
  if (!preset) {
    console.error(`Unknown preset. Available: ${Object.keys(PRESETS).join(', ')}`);
    process.exit(1);
  }

  console.log(`Generating ${preset.label} · ${wordCount} words · avatar ${avatarId}`);
  const { videoId } = await generateVideo({
    script,
    avatarId,
    voiceId,
    characterKind: args.talkingPhoto ? 'talking_photo' : 'avatar',
    width: preset.width,
    height: preset.height,
    title: args.title || undefined,
    captionsBurnedIn: Boolean(args.captions),
  });
  console.log(`video_id: ${videoId}`);

  // HeyGen renders asynchronously; poll until it leaves the processing state.
  let status;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await sleep(5000);
    status = await getVideoStatus(videoId);
    process.stdout.write(`\rstatus: ${status.status}   `);
    if (status.status === 'completed' || status.status === 'failed') break;
  }
  process.stdout.write('\n');

  if (status?.status !== 'completed') {
    console.error('Render did not complete:', status?.error || status?.status);
    process.exit(1);
  }

  console.log(`done in ~${status.duration ?? '?'}s`);
  console.log(`url: ${status.videoUrl}`);

  if (args.out) {
    const dir = typeof args.out === 'string' ? args.out : 'downloads';
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${videoId}.mp4`);
    const res = await fetch(status.videoUrl);
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    console.log(`saved: ${file}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
