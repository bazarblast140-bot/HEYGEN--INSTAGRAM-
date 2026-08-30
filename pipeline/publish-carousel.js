#!/usr/bin/env node
// Post a built carousel to Instagram.
//
//   node pipeline/publish-carousel.js --report pipeline/out/carousel-report.json
//   node pipeline/publish-carousel.js --report ... --yes
//
// Without --yes this hosts nothing and posts nothing: it prints the account, the
// files and the caption that WOULD go out, and stops. Publishing is the one step
// in this repo that cannot be undone from here — a wrong post is deleted by hand,
// from the phone, after followers have already seen it — so the destructive
// behaviour is the one you have to ask for, not the one you get by default.

import path from 'node:path';
import fs from 'node:fs/promises';

import { hostFiles } from './src/publish/host.js';
import { publishCarousel, checkCarousel } from './src/publish/carousel.js';
import { whoami } from './src/publish/instagram.js';
import { env } from '../src/config.js';

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

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
  const reportPath = args.report || 'pipeline/out/carousel-report.json';

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const files = report.files || [];
  if (!files.length) throw new Error(`${reportPath} lists no slide files. Run build-carousel.js first.`);

  // A PNG build is a preview build. It renders identically and Instagram will
  // not take it, so it is refused here rather than three API calls later.
  if (report.format && report.format !== 'jpeg') {
    throw new Error(`This build is ${report.format}. Instagram's image container takes JPEG — re-run build-carousel.js without --format.`);
  }

  const captionPath = args['caption-file'] || path.join(path.dirname(reportPath), 'caption.txt');
  const caption = await fs.readFile(captionPath, 'utf8').catch(() => '');

  console.log(`Carousel  ${files.length} slides  ${report.width}x${report.height}  ${dim(report.topic || '')}`);
  for (const f of files) console.log(`  ${dim(f)}`);

  // Where the pictures came from. The build prints this too, but by the time
  // anyone reads a CI log they are reading the end of it, and "which slide got
  // a real photograph and which got the gradient" is the thing worth knowing.
  for (const n of report.notes || []) console.log(`  ${dim(`· ${n}`)}`);
  console.log(`Caption   ${caption.length} chars`);
  console.log(caption.split('\n').map((l) => `  ${dim(l)}`).join('\n'));

  // Whose account is it? Printed before anything is posted, because the failure
  // this prevents — right post, wrong account — is not fixable by deleting it.
  const me = await whoami();
  if (!me.working) {
    console.error(`\n${bad('no surface accepted the token')} — run pipeline/instagram-doctor.js`);
    process.exit(1);
  }
  const account = me.results.find((r) => r.ok).account;
  console.log(`\nAccount   ${ok(`@${account.username || account.id}`)} via ${me.working}  ${dim(`${account.media_count ?? '?'} posts`)}`);

  if (!args.yes) {
    console.log(`\n${dim('dry run — nothing hosted, nothing posted. Add --yes to publish.')}`);
    return;
  }

  console.log('\nHosting');
  const { assets, tag } = await hostFiles({
    files,
    tag: `carousel-${new Date().toISOString().slice(0, 10)}`,
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  process.stdout.write('\n');
  const imageUrls = assets.map((a) => a.url);
  console.log(`  release ${tag}`);

  const problems = checkCarousel({ imageUrls, caption });
  if (problems.length) {
    console.error(`\n${bad('REFUSED')}\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  console.log('\nPublishing');
  const { mediaId } = await publishCarousel({
    imageUrls, caption,
    surface: env('IG_SURFACE') || me.working,
    onStatus: (stage, value) => console.log(`  ${stage}: ${value}`),
  });

  console.log(`\n${ok('published')} ${mediaId}`);
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
