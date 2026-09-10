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
import { publishStory } from './src/publish/story.js';
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

  // What the slides actually say. A dry run exists to be read before a post goes
  // out, and a list of filenames is not readable — the whole point of stopping
  // here is to see the words. Older reports have no lines; they still print.
  for (const line of report.lines || []) {
    console.log(`  ${String(line.n).padStart(2)}  ${line.headline}`);
    if (line.subline) console.log(`      ${dim(line.subline)}`);
    if (line.source) console.log(`      ${dim(`स्रोत: ${line.source}`)}`);
  }
  if (!report.lines) for (const f of files) console.log(`  ${dim(f)}`);

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

  // The story rides along in the same release. One upload, one tag, and the
  // story URL is simply the last asset — a second release for one JPEG would
  // double the failure surface for the optional half of the job.
  const wantStory = args.story !== false && Boolean(report.story);

  console.log('\nHosting');
  const { assets, tag } = await hostFiles({
    files: wantStory ? [...files, report.story] : files,
    // Per run, not per day.
    //
    // Re-using one tag for a whole day means a re-run deletes each asset and
    // uploads a new file to the SAME public URL. GitHub serves those downloads
    // through a cache, and a URL that has been deleted and replaced three times
    // in ninety minutes does not reliably serve the current file -- Instagram
    // fetches it, does not get an image, and says "Only photo or video can be
    // accepted as media type". Slides 1 and 2 went through on 2026-09-10 and
    // slide 3 failed all three attempts, which is not what a flaky network
    // looks like; it is what a poisoned URL looks like.
    //
    // A fresh tag per run means every URL is new and is never written twice.
    tag: `carousel-${new Date().toISOString().slice(0, 10)}-${process.env.GITHUB_RUN_ID || Date.now().toString(36)}`,
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  process.stdout.write('\n');
  const hosted = assets.map((a) => a.url);
  const imageUrls = hosted.slice(0, files.length);
  const storyUrl = wantStory ? hosted.at(-1) : null;
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

  // After the post, never instead of it. A story that fails is a story that
  // did not go out; a post that fails because of a story is a day lost, so
  // nothing below here is allowed to change the exit code.
  if (storyUrl) {
    console.log('\nStory');
    try {
      const { mediaId: storyId } = await publishStory({
        imageUrl: storyUrl,
        surface: env('IG_SURFACE') || me.working,
        onStatus: (stage, value) => console.log(`  ${stage}: ${value}`),
      });
      console.log(`  ${ok('story published')} ${storyId}`);
    } catch (err) {
      console.log(`  ${bad('story failed')} ${err.message.slice(0, 200)}`);
      console.log(`  ${dim('the carousel is posted and unaffected')}`);
    }
  }
}

main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
