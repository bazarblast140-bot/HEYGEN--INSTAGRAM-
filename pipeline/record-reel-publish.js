#!/usr/bin/env node
// Record a Reel only after Instagram has accepted it.
//
//   node pipeline/record-reel-publish.js --log publish.log
//   node pipeline/record-reel-publish.js --media-id 1784140000123
//
// Writes the media id into reel-publish-history.json (the same-day guard)
// and appends the topic to topic-history.json. Both happen here, not during
// script generation and not before hosting. Refuses to write when the log
// has no published media id.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordTopic, LEDGER } from './src/script/topics.js';
import {
  REEL_PUBLISH_LEDGER, clock, istDate, readReelPublishes,
} from './src/publish/same-day.js';

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

export function mediaIdFromLog(log) {
  const match = String(log || '').replace(/\x1b\[[0-9;]*m/g, '').match(/^published:\s*(\d{6,})\s*$/m);
  return match ? match[1] : '';
}

export async function recordPublishedReel({
  mediaId,
  topic = '',
  angle = '',
  now = new Date(),
  topicFile = LEDGER,
  publishFile = REEL_PUBLISH_LEDGER,
} = {}) {
  const id = String(mediaId || '').trim();
  if (!/^\d{6,}$/.test(id)) {
    throw new Error('refusing to record a reel without a published media id');
  }

  const date = istDate(now);
  const entries = await readReelPublishes(publishFile);
  if (!entries.some((entry) => String(entry.mediaId) === id)) {
    entries.push({
      date,
      mediaId: id,
      topic: String(topic || '').trim(),
      at: (now instanceof Date ? now : new Date(now)).toISOString(),
    });
    await fs.writeFile(
      publishFile,
      `${JSON.stringify({ entries: entries.slice(-120) }, null, 2)}\n`,
    );
  }

  const writtenTopic = String(topic || '').trim();
  if (writtenTopic) {
    await recordTopic({ topic: writtenTopic, angle, date, file: topicFile });
  }
  return { date, mediaId: id };
}

async function readTopic(specPath) {
  try {
    const spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
    return { topic: spec.topic || '', angle: spec.verdict || spec.category || '' };
  } catch {
    return { topic: '', angle: '' };
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const args = parseArgs(process.argv.slice(2));
  const log = args.log ? await fs.readFile(args.log, 'utf8') : '';
  const mediaId = args['media-id'] || mediaIdFromLog(log);
  const fromSpec = await readTopic(args.spec || path.join(HERE, 'out', 'spec-generated.json'));
  try {
    const saved = await recordPublishedReel({
      mediaId,
      topic: args.topic || fromSpec.topic,
      angle: args.angle || fromSpec.angle,
      now: clock(),
      publishFile: process.env.REEL_PUBLISH_FILE || REEL_PUBLISH_LEDGER,
      topicFile: process.env.TOPIC_LEDGER_FILE || LEDGER,
    });
    console.log(`recorded reel ${saved.mediaId} for ${saved.date}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
