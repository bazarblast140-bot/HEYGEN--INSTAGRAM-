// A dry run has one job: let a human read the post before it exists.
//
// For weeks it printed nine filenames, a topic and a caption. Filenames say
// nothing about what the account is about to claim, and the caption is a
// summary of the slides, not the slides. So an evening finance post could be
// reviewed and approved without anyone having read a single line of it.
//
// This spawns the real script against a report on disk. There is no token here,
// so it dies at the account check — after the part that matters has printed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

async function dryRun(report) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dry-'));
  const file = path.join(dir, 'carousel-report.json');
  await fs.writeFile(file, JSON.stringify(report));
  await fs.writeFile(path.join(dir, 'caption.txt'), 'caption');
  const { stdout } = await run('node', ['pipeline/publish-carousel.js', '--report', file], {
    env: { ...process.env, IG_ACCESS_TOKEN: '', IG_USER_ID: '' },
  }).catch((err) => err);   // no token — it exits 1 after printing
  await fs.rm(dir, { recursive: true, force: true });
  return stdout || '';
}

const base = {
  slides: 2, width: 1080, height: 1350, format: 'jpeg',
  files: ['a.jpg', 'b.jpg'], topic: 'भारत का सेवा निर्यात',
};

test('the dry run prints what the slides say, not what they are called', async () => {
  const out = await dryRun({
    ...base,
    lines: [
      { n: 1, headline: 'भारत की GDP में सबसे बड़ा हिस्सा किसका है?', subline: null, source: null },
      { n: 2, headline: 'सेवा क्षेत्र', subline: 'आधे से ज़्यादा अर्थव्यवस्था', source: 'विश्व बैंक' },
    ],
  });

  assert.match(out, /भारत की GDP में सबसे बड़ा हिस्सा किसका है\?/);
  assert.match(out, /आधे से ज़्यादा अर्थव्यवस्था/);
  assert.match(out, /स्रोत: विश्व बैंक/);
});

test('a report built before this change still prints its files', async () => {
  const out = await dryRun(base);
  assert.match(out, /a\.jpg/);
});
