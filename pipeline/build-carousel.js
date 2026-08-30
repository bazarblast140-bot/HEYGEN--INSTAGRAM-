#!/usr/bin/env node
// Build one Instagram carousel from a spec.
//
//   node pipeline/build-carousel.js --spec pipeline/specs/carousel-hindi.json
//   node pipeline/build-carousel.js --generate               # today's topic
//   node pipeline/build-carousel.js --spec ... --no-photos   # gradients only
//   node pipeline/build-carousel.js --spec ... --format png   # lossless, not postable
//   node pipeline/build-carousel.js --generate --require-generated   # no fallback
//
// This is the cheap sibling of build-reel.js. There is no video in it, so there
// is no avatar render, no voice synthesis and no ffmpeg encode: a carousel is N
// screenshots and finishes in about two minutes for zero API credits. That is
// the whole reason it can afford a daily schedule.
//
// Nothing is published. Rendering and posting are separate commands on purpose —
// a run that writes PNGs to disk can be looked at before anything reaches the
// feed, and a fact account cannot take back a wrong number.

import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { renderSlides, WIDTH, HEIGHT } from './render-slides.js';
import { attachBackgrounds } from './src/render/backgrounds.js';
import { generateCarousel } from './src/carousel/generate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The look is the account's, not the day's. A generated spec carries the words
 * and nothing else, so the model cannot quietly restyle the brand by returning
 * a different colour.
 */
const BRAND = { brand: 'FACTVIZER', ink: '#FFD200', brandInk: '#F2F2F2', tag: '#factvizer' };

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

const notes = [];
const note = (msg) => { notes.push(msg); console.log(`  · ${msg}`); };

/**
 * Reject the spec before rendering rather than after posting.
 *
 * The `source` rule is the one that matters. On an account whose whole promise
 * is that the numbers are right, an unsourced figure is worse than a missed
 * day — a missed day costs nothing, a wrong number costs the reason anyone
 * follows. So a list slide without a source is a hard failure, not a warning.
 */
export function validateSpec(spec) {
  const problems = [];
  const slides = spec.slides || [];

  if (!slides.length) problems.push('spec has no slides');
  if (slides.length > 10) problems.push(`${slides.length} slides — Instagram allows 10`);

  const covers = slides.filter((s) => s.band === 'center');
  if (covers.length !== 1) problems.push(`expected exactly one cover slide (band "center"), found ${covers.length}`);
  if (slides.length && slides[0].band !== 'center') problems.push('the first slide must be the cover');

  slides.forEach((slide, i) => {
    const n = i + 1;
    if (!String(slide.headline || '').trim()) problems.push(`slide ${n} has no headline`);

    // The cover asks a question and the closing card asks for a follow; neither
    // states a figure, so neither needs a citation. Every slide that carries a
    // fact does.
    const carriesFact = slide.band !== 'center' && !slide.cta;
    if (carriesFact && !String(slide.source || slide.footnote || '').trim()) {
      problems.push(`slide ${n} states a fact with no "source"`);
    }
  });

  return problems;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args.spec || path.join(HERE, 'specs', 'carousel-hindi.json');
  const outDir = path.resolve(args.out || path.join(HERE, 'out', 'slides'));

  // Without --generate the checked-in spec is a fixture, and a fixture posted
  // every morning is one post repeated forever. Generation is what makes this a
  // daily show; the spec on disk stays as the thing to fall back to.
  let spec;
  if (args.generate) {
    console.log('Writing today\'s carousel');
    try {
      const written = await generateCarousel({
        ...(args.slot ? { slot: args.slot } : {}),
        onAttempt: (n, model, category) => console.log(`  ${category} · ${model}, attempt ${n}`),
      });
      spec = { brand: BRAND.brand, ink: BRAND.ink, brandInk: BRAND.brandInk, ...written.spec };
      note(`"${written.spec.topic}" — ${written.category}/${written.slot}, ${written.provider} in ${written.attempts} attempt(s)`);
      await fs.mkdir(path.join(HERE, 'out'), { recursive: true });
      await fs.writeFile(path.join(HERE, 'out', 'spec-generated.json'), JSON.stringify(spec, null, 2));
    } catch (err) {
      // On a run that publishes, falling back is worse than failing.
      //
      // The checked-in spec is one fixed carousel. Falling back to it on a
      // scheduled run does not mean "no new fact today", it means posting a
      // carousel the account has already posted -- and the ledger cannot catch
      // that, because the fallback never goes through the ledger. A skipped day
      // costs nothing; a duplicate costs the reason people follow.
      if (args['require-generated']) {
        console.error(`\nGeneration failed and --require-generated is set, so nothing was built.`);
        console.error(`  ${err.message.slice(0, 300)}`);
        process.exit(1);
      }
      note(`generation failed (${err.message.slice(0, 160)}) — using the checked-in spec`);
    }
  }

  if (!spec) {
    spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
    console.log(`Spec  ${path.relative(process.cwd(), specPath)}  (${(spec.slides || []).length} slides)`);
  }

  const problems = validateSpec(spec);
  if (problems.length) {
    console.error(`REJECTED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  // The scene renders `footnote`; the spec carries `source`. Keeping them
  // separate means the validator can insist on a citation without dictating
  // how it is worded on screen.
  const withFootnotes = {
    ...spec,
    slides: spec.slides.map((s) => ({ ...s, footnote: s.footnote ?? s.source ?? '' })),
  };

  let ready = withFootnotes;
  if (args['no-photos']) {
    note('--no-photos — generated gradient behind every slide');
  } else {
    console.log('Backgrounds');
    const { spec: withPhotos, attached } = await attachBackgrounds(withFootnotes, {
      outDir: path.join(HERE, 'out', 'photos'),
      onNote: note,
    });
    ready = withPhotos;
    console.log(`  ${attached}/${spec.slides.length} slides carry a photo`);
  }

  console.log('Rendering');
  const { files, format } = await renderSlides({
    spec: ready, outDir,
    ...(args.format ? { format: args.format } : {}),
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  process.stdout.write('\n');

  // The brand tag is added here rather than asked for in the prompt: it is the
  // one hashtag that must be on every post, and a model that forgets it once
  // breaks the only tag that collects the account's own back catalogue.
  const hashtags = [...new Set([...(spec.hashtags || []), BRAND.tag])];
  const caption = [
    spec.caption?.trim(),
    hashtags.length ? hashtags.join(' ') : null,
  ].filter(Boolean).join('\n\n');
  await fs.writeFile(path.join(path.dirname(outDir), 'caption.txt'), caption);

  const report = {
    spec: path.relative(process.cwd(), specPath),
    slides: files.length,
    width: WIDTH, height: HEIGHT, format,
    files: files.map((f) => path.relative(process.cwd(), f)),
    photos: ready.slides.filter((s) => s.background).length,
    topic: spec.topic || null,
    notes,
  };
  await fs.writeFile(path.join(path.dirname(outDir), 'carousel-report.json'), JSON.stringify(report, null, 2));

  console.log(`\n${files.length} slides  ${WIDTH}x${HEIGHT} ${format}  ->  ${path.relative(process.cwd(), outDir)}`);
  console.log('nothing published — rendering and posting are separate commands');
  console.log(`to post it:  node pipeline/publish-carousel.js --report ${path.relative(process.cwd(), path.join(path.dirname(outDir), 'carousel-report.json'))} --yes`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`\n${err.stack || err.message}`); process.exit(1); });
}
