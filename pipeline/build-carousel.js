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

import { renderSlides, WIDTH, HEIGHT, STORY_WIDTH, STORY_HEIGHT, STORY_INSET } from './render-slides.js';
import { attachBackgrounds, attachInsets } from './src/render/backgrounds.js';
import { attachFixed, fillGaps } from './src/render/pictures.js';
import { generateCarousel, normalizeSpec } from './src/carousel/generate.js';
import { SLOTS, slotFor, FINANCE } from './src/carousel/categories.js';
import { ACCOUNT_BRAND } from './src/publish/allow.js';
import { framesToPost } from './src/carousel/story.js';
import { shapeCaption } from './src/publish/caption.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The look is the account's, not the day's. A generated spec carries the words
 * and nothing else, so the model cannot quietly restyle the brand by returning
 * a different colour.
 *
 * Brand mark is empty on purpose: the Instagram account is @rajesh_technical_trader.
 * The last slide asks to save and follow.
 */
const BRAND = { brand: ACCOUNT_BRAND, ink: '#FFD200', brandInk: '#F2F2F2', tag: '' };

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

function expandNewlines(text) {
  if (text == null) return text;
  return String(text).replace(/\\n/g, '\n');
}

export const HOOK_LIMIT = 125;

export function reflowHook(text, limit = HOOK_LIMIT) {
  const [first, ...rest] = String(text).split('\n');
  if (first.length <= limit) return text;

  const sentence = first.match(new RegExp(`^[\\s\\S]{20,${limit}}[।?!]`));
  const cut = sentence ? sentence[0].length : first.lastIndexOf(' ', limit);
  if (cut <= 0) return text;

  return [first.slice(0, cut).trim(), first.slice(cut).trim(), ...rest]
    .filter(Boolean).join('\n');
}

export const SUBLINE_ONE_LINE = 30;

export function balanceSubline(text, limit = SUBLINE_ONE_LINE) {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return text;

  if (lines.length > 2) return [lines[0], lines.slice(1).join(' ')].join('\n');
  if (lines.length === 2 || lines[0].length <= limit) return lines.join('\n');

  const only = lines[0];
  const middle = Math.floor(only.length / 2);
  let cut = -1;
  for (let i = 0; i < only.length; i += 1) {
    if (only[i] !== ' ') continue;
    if (cut === -1 || Math.abs(i - middle) < Math.abs(cut - middle)) cut = i;
  }
  if (cut <= 0) return only;
  return [only.slice(0, cut).trim(), only.slice(cut + 1).trim()].join('\n');
}

export function composeCaption(spec, brandTag) {
  const written = reflowHook(expandNewlines(String(spec.caption || '').trim()));
  return shapeCaption({ caption: written, hashtags: spec.hashtags || [], brandTag });
}

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

  let slotUsed = args.slot || slotFor(new Date()) || '';
  let generated = false;

  let spec;
  if (args.generate || args.preview) {
    console.log(args.preview ? 'Preview — writing a finance carousel without posting' : 'Writing today\'s carousel');
    const requested = args.preview
      ? ((!args.slot || args.slot === 'auto') ? 'evening' : args.slot)
      : (args.slot || slotFor(new Date()));
    const slot = requested;
    slotUsed = slot || '';
    if (!slot || !SLOTS.includes(slot)) {
      if (args['require-generated'] || args.preview) {
        console.error('\nNo finance slot for this run, so nothing was built and nothing will be published.');
        process.exit(1);
      }
      note('outside the posting windows — checked-in spec is not publishable');
    } else try {
      const written = await generateCarousel({
        slot,
        record: !args.preview,
        onAttempt: (n, model, category) => console.log(`  ${category} · ${model}, attempt ${n}`),
        onReject: (n, problems) => problems.forEach((p) => console.log(`      attempt ${n} rejected: ${p}`)),
      });
      spec = {
        brand: BRAND.brand, ink: BRAND.ink, brandInk: BRAND.brandInk,
        ...written.spec, category: written.category, fallback: false, reviewed: false,
      };
      generated = true;
      note(`"${written.spec.topic}" — ${written.category}/${written.slot}, ${written.provider} in ${written.attempts} attempt(s)`);
      if (written.stories) {
        const by = written.stories.reduce((acc, st) => ({ ...acc, [st.from]: (acc[st.from] || 0) + 1 }), {});
        note(`stories: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}`);
      }
      await fs.mkdir(path.join(HERE, 'out'), { recursive: true });
      await fs.writeFile(path.join(HERE, 'out', 'spec-generated.json'), JSON.stringify(spec, null, 2));
    } catch (err) {
      console.log(`generation failed: ${err.message}`);
      if (args['require-generated'] || args.preview) {
        console.error('\nGeneration failed. This run will not build or publish checked-in content.');
        process.exit(1);
      }
      note('generation failed — checked-in spec is not publishable');
    }
  }

  if (!spec) {
    spec = JSON.parse(await fs.readFile(specPath, 'utf8'));
    console.log(`Spec  ${path.relative(process.cwd(), specPath)}  (${(spec.slides || []).length} slides)`);
    if (!generated) note('this is checked-in content — it will not be published unless it is reviewed finance and the review flag is set');
  }

  spec = { ...spec, brand: BRAND.brand, ink: spec.ink || BRAND.ink, brandInk: spec.brandInk || BRAND.brandInk };

  // Defensive: expand any leftover literal \\n from hand-written or model specs.
  spec = {
    ...spec,
    caption: expandNewlines(spec.caption),
    slides: (spec.slides || []).map((s) => ({
      ...s,
      headline: expandNewlines(s.headline),
      subline: expandNewlines(s.subline),
      source: expandNewlines(s.source),
      footnote: expandNewlines(s.footnote),
    })),
  };

  // Always normalize bands/cta/sources before the hard gate. Models occasionally
  // return two covers; that used to reject the whole day after generation spent
  // three attempts. Repair is cheaper than silence.
  spec = normalizeSpec(spec);
  note('shape normalized (exactly one cover, last slide save and follow)');

  const problems = validateSpec(spec);
  if (problems.length) {
    console.error(`REJECTED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  const withFootnotes = {
    ...spec,
    slides: spec.slides.map((s) => ({
      ...s,
      subline: balanceSubline(s.subline),
      footnote: s.footnote ?? s.source ?? '',
    })),
  };

  let ready = withFootnotes;
  if (args['no-photos']) {
    note('--no-photos — generated gradient behind every slide');
  } else {
    console.log('Backgrounds');
    const { spec: withOurs, attached: ours } = await attachFixed(withFootnotes, { onNote: note });
    const { spec: withPhotos, attached } = await attachBackgrounds(withOurs, {
      outDir: path.join(HERE, 'out', 'photos'),
      onNote: note,
    });
    const { spec: withGivenPictures, filled } = await fillGaps(withPhotos, { onNote: note });

    console.log('Celebrity insets');
    const { spec: withInsets, attached: insets } = await attachInsets(withGivenPictures, {
      outDir: path.join(HERE, 'out', 'photos'),
      onNote: note,
    });
    ready = withInsets;

    const given = ours + filled;
    console.log(`  ${attached + given}/${spec.slides.length} slides carry a picture`
      + (given ? `  (${given} of them yours)` : '')
      + (insets ? `  ·  ${insets} celebrity inset(s)` : ''));
  }

  console.log('Rendering');
  const { files, format } = await renderSlides({
    spec: ready, outDir,
    ...(args.format ? { format: args.format } : {}),
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  process.stdout.write('\n');

  let stories = [];
  const frames = framesToPost(ready, { slot: slotUsed });
  if (!frames.length) {
    console.log('story    none — one Story a day, only with the evening post');
  } else try {
    const { files: storyFiles } = await renderSlides({
      spec: { ...ready, slides: frames },
      outDir: path.join(path.dirname(outDir), 'story'),
      width: STORY_WIDTH, height: STORY_HEIGHT, bottomInset: STORY_INSET,
      ...(args.format ? { format: args.format } : {}),
    });
    stories = [];
    for (const [i, file] of storyFiles.entries()) {
      const named = path.join(path.dirname(file), `story-${i + 1}${path.extname(file)}`);
      await fs.rename(file, named);
      stories.push(path.relative(process.cwd(), named));
    }
    console.log(`story    ${stories.length} frame(s)  ${STORY_WIDTH}x${STORY_HEIGHT} ${format}`);
  } catch (err) {
    console.log(`story    not built — ${err.message.slice(0, 120)}`);
  }

  const caption = composeCaption(spec, BRAND.tag);

  await fs.writeFile(path.join(path.dirname(outDir), 'caption.txt'), caption);

  const report = {
    spec: path.relative(process.cwd(), specPath),
    slides: files.length,
    width: WIDTH, height: HEIGHT, format,
    files: files.map((f) => path.relative(process.cwd(), f)),
    photos: ready.slides.filter((s) => s.background).length,
    insets: ready.slides.filter((s) => s.insets?.length).length,
    topic: spec.topic || null,
    category: spec.category || null,
    brand: spec.brand || BRAND.brand,
    generated,
    fallback: !generated,
    reviewed: !generated && spec.reviewed === true && FINANCE.includes(spec.category),
    publishable: generated && FINANCE.includes(spec.category),
    stories,
    lines: (ready.slides || []).map((s, i) => ({
      n: i + 1,
      headline: (s.headline || '').replace(/\n/g, ' '),
      subline: (s.subline || '').replace(/\n/g, ' ') || null,
      source: s.source || null,
    })),
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
