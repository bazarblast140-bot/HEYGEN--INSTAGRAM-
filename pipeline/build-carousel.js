#!/usr/bin/env node
// Build one Instagram carousel from a spec.
//
//   node pipeline/build-carousel.js --spec pipeline/specs/carousel-hindi.json
//   node pipeline/build-carousel.js --generate               # today's topic
//   (no stock photos: every slide is a v3 dark chart-board drawn from calc.js)
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
import { createHash } from 'node:crypto';
import { boardSlides } from './src/carousel/board.js';
import { computeCalc } from './src/carousel/calc.js';
import { repairHeavyWords } from './src/carousel/language.js';
import { istParts } from './src/carousel/categories.js';
import { generateCarousel, normalizeSpec } from './src/carousel/generate.js';
import { ALL_SLOTS, slotFor, FINANCE } from './src/carousel/categories.js';
import { clock } from './src/publish/same-day.js';
import { generateSourcedCarousel } from './src/carousel/sourced.js';
import { flagOn, ENABLE_AI_NEWS_CAROUSELS, ENABLE_CAROUSEL_STORY } from './src/publish/flags.js';
import { ACCOUNT_BRAND } from './src/publish/allow.js';
import { framesToPost } from './src/carousel/story.js';
import { shapeCaption } from './src/publish/caption.js';
import {
  dropPaddedPanels, layoutProblems, hardQualityProblems, hindiShare, UNCHECKED, storyNumbers, chartBackedBy,
} from './src/carousel/quality.js';

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
  const sourced = !FINANCE.includes(spec.category);

  if (!slides.length) problems.push('spec has no slides');
  if (slides.length > 10) problems.push(`${slides.length} slides — Instagram allows 10`);

  const covers = slides.filter((s) => s.band === 'center');
  if (covers.length !== 1) problems.push(`expected exactly one cover slide (band "center"), found ${covers.length}`);
  if (slides.length && slides[0].band !== 'center') problems.push('the first slide must be the cover');

  slides.forEach((slide, i) => {
    const n = i + 1;
    if (!String(slide.headline || '').trim()) problems.push(`slide ${n} has no headline`);

    const carriesFact = slide.band !== 'center' && !slide.cta;
    if (carriesFact && sourced && !String(slide.source || slide.footnote || '').trim()) {
      problems.push(`slide ${n} states a fact with no "source"`);
    }
    if (carriesFact && !sourced && !slide.calc) {
      problems.push(`slide ${n} has no "calc" — every finance content slide is a chart computed by code`);
    }
  });

  return problems;
}

/** sha256 over the slide bytes, so an approval names exactly what is posted. */
export async function hashFiles(files) {
  const h = createHash('sha256');
  for (const f of files) h.update(await fs.readFile(f));
  return h.digest('hex');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const specPath = args.spec || path.join(HERE, 'specs', 'carousel-hindi.json');
  const outDir = path.resolve(args.out || path.join(HERE, 'out', 'slides'));

  let slotUsed = args.slot || slotFor(new Date()) || '';
  let generated = false;
  let verifiedSource = false;
  let sourceFresh = false;
  let sourcedSlot = false;
  let fetchedStories = null;

  let spec;
  if (args.generate || args.preview) {
    console.log(args.preview ? 'Preview — writing a carousel without posting' : 'Writing today\'s carousel');
    const now = clock();
    const requested = args.preview
      ? ((!args.slot || args.slot === 'auto') ? 'evening' : args.slot)
      : (args.slot || slotFor(now));
    const slot = requested;
    slotUsed = slot || '';
    if (!slot || !ALL_SLOTS.includes(slot)) {
      console.log('soft skip — No finance slot for this run, so nothing was built and nothing will be published.');
      process.exit(0);
    } else if ((slot === 'ai' || slot === 'news') && !args.preview && !flagOn(ENABLE_AI_NEWS_CAROUSELS)) {
      console.log(`${slot} skipped — ENABLE_AI_NEWS_CAROUSELS is off. Nothing will be published.`);
      process.exit(0);
    } else try {
      sourcedSlot = slot === 'ai' || slot === 'news';
      const written = sourcedSlot
        ? await generateSourcedCarousel({
          slot,
          kind: slot,
          record: !args.preview,
          onNote: note,
          onAttempt: (n, model, category) => console.log(`  ${category} · ${model}, attempt ${n}`),
          onReject: (n, problems) => problems.forEach((p) => console.log(`      attempt ${n} rejected: ${p}`)),
        })
        : await generateCarousel({
          slot,
          record: !args.preview,
          onNote: note,
          onAttempt: (n, model, category) => console.log(`  ${category} · ${model}, attempt ${n}`),
          onReject: (n, problems) => problems.forEach((p) => console.log(`      attempt ${n} rejected: ${p}`)),
        });
      if (written.skipped) {
        const skipReport = {
          skipped: true,
          publishable: false,
          generated: false,
          fallback: false,
          category: written.category,
          slot: written.slot,
          reason: written.reason,
          files: [],
          stories: [],
          notes: [written.reason],
        };
        await fs.mkdir(path.join(HERE, 'out'), { recursive: true });
        await fs.writeFile(path.join(HERE, 'out', 'carousel-report.json'), JSON.stringify(skipReport, null, 2));
        console.log(written.reason);
        if (args.preview) {
          console.error('No fresh verifiable source. Preview will not invent a carousel.');
          process.exit(1);
        }
        console.log('Skipping this post. Nothing will be published.');
        process.exit(0);
      }
      if (sourcedSlot && Array.isArray(written.stories)) fetchedStories = written.stories;
      verifiedSource = written.verifiedSource === true;
      sourceFresh = written.sourceFresh === true;
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
  spec = normalizeSpec(spec, { sourced: sourcedSlot || !FINANCE.includes(spec.category) });
  note('shape normalized (exactly one cover, last slide save and follow)');

  // Quality repair before render: padded / empty panels are dropped, not shipped
  // (before the shape check, so a padded follow-card copy is not a "fact" slide).
  const padded = dropPaddedPanels(spec);
  if (padded.dropped) {
    spec = padded.spec;
    note(`quality: dropped ${padded.dropped} padded/empty panel(s)`);
  }

  const problems = validateSpec(spec);
  if (problems.length) {
    console.error(`REJECTED:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }

  // Simple Hinglish: heavy words (अवधि, मूलधन ...) are replaced with the word
  // people use (tenure, principal). The gate below still refuses any left.
  const plain = repairHeavyWords(spec);
  if (plain.replaced.length) {
    spec = plain.spec;
    note(`language: replaced ${plain.replaced.join(', ')}`);
  }

  // A news/AI chart whose inputs do not compute is dropped (the slide becomes a
  // text board); its numbers are still checked against the fetched items.
  // Same for a chart built on a number the model derived itself (e.g. adding two
  // reported figures): a chart input must be a number in the fetched items.
  if (!FINANCE.includes(spec.category)) {
    const pool = fetchedStories ? storyNumbers(fetchedStories) : null;
    let dropped = 0;
    spec = {
      ...spec,
      slides: spec.slides.map((s) => {
        if (!s.calc) return s;
        const calc = computeCalc(s.calc);
        if (!calc.ok || (pool && !chartBackedBy(calc, pool))) { dropped += 1; return { ...s, calc: null }; }
        return s;
      }),
    };
    if (dropped) note(`dropped ${dropped} news chart(s) whose inputs do not compute or are not in the fetched items`);
  }

  // v3 chart-board: chart, figure strip and footnote come from calc.js. No
  // stock photo is fetched for a carousel, ever (--no-photos is now the only mode).
  if (args['no-photos'] === undefined) note('no stock photos — every content slide is a chart computed from its calc');
  const ready = {
    ...spec,
    slides: boardSlides(spec).map((s) => ({ ...s, subline: balanceSubline(s.subline) })),
  };
  const charts = ready.slides.filter((s) => s.chart).length;
  console.log(`  ${charts}/${ready.slides.length} slides carry a computed chart`);

  console.log('Rendering');
  const renderFeed = (tight) => renderSlides({
    spec: ready, outDir, tight,
    ...(args.format ? { format: args.format } : {}),
    onProgress: (n, total) => process.stdout.write(`\r  ${n}/${total}`),
  });
  let rendered = await renderFeed(false);
  process.stdout.write('\n');
  // Rendered text must sit inside the 6% safe inset. One free re-render with
  // tighter type; no model call is repeated for layout.
  let layout = layoutProblems(rendered.measures, { width: WIDTH, height: HEIGHT });
  if (layout.length) {
    layout.forEach((p) => note(`layout: ${p}`));
    console.log('Re-rendering with tighter type');
    rendered = await renderFeed(true);
    process.stdout.write('\n');
    layout = layoutProblems(rendered.measures, { width: WIDTH, height: HEIGHT });
    note(layout.length ? `layout still fails after the tight re-render (${layout.length})` : 'layout fixed by the tight re-render');
  }
  const { files, format } = rendered;

  let stories = [];
  const frames = framesToPost(ready, {
    slot: slotUsed,
    carouselStory: flagOn(ENABLE_CAROUSEL_STORY),
    preview: args.preview === true,
  });
  if (!frames.length) {
    console.log('story    none — one Story a day, only with the evening post');
  } else try {
    const renderStory = (tight) => renderSlides({
      spec: { ...ready, slides: frames },
      outDir: path.join(path.dirname(outDir), 'story'),
      width: STORY_WIDTH, height: STORY_HEIGHT, bottomInset: STORY_INSET, tight,
      ...(args.format ? { format: args.format } : {}),
    });
    const storyArea = { width: STORY_WIDTH, height: STORY_HEIGHT, story: true, bottomInset: STORY_INSET };
    let storyRender = await renderStory(false);
    if (layoutProblems(storyRender.measures, storyArea).length) storyRender = await renderStory(true);
    const storyLayout = layoutProblems(storyRender.measures, storyArea);
    if (storyLayout.length) throw new Error(`story text outside the safe area: ${storyLayout[0]}`);
    const { files: storyFiles } = storyRender;
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

  // Final pre-publish gate. Any hard problem keeps this carousel off the feed.
  const gate = [...hardQualityProblems(ready, { stories: fetchedStories, caption }), ...layout];
  const quality = {
    ok: gate.length === 0,
    problems: gate,
    hindiShare: Number(hindiShare(ready).toFixed(2)),
    safeInset: 0.06,
    unchecked: UNCHECKED,
  };
  if (gate.length) {
    console.log(`quality gate REFUSED — this carousel will not be published:\n  ${gate.join('\n  ')}`);
  } else {
    console.log(`quality gate passed (Hindi ${Math.round(quality.hindiShare * 100)}%, text inside the 6% safe area)`);
  }

  await fs.writeFile(path.join(path.dirname(outDir), 'caption.txt'), caption);

  const report = {
    spec: path.relative(process.cwd(), specPath),
    slides: files.length,
    width: WIDTH, height: HEIGHT, format,
    files: files.map((f) => path.relative(process.cwd(), f)),
    photos: 0,
    insets: 0,
    charts,
    style: 'v3-chart-board',
    slot: slotUsed || null,
    preview: args.preview === true,
    builtAt: new Date().toISOString(),
    istDate: istParts(new Date()).date,
    contentHash: await hashFiles([...files, ...stories]),
    topic: spec.topic || null,
    category: spec.category || null,
    brand: spec.brand || BRAND.brand,
    generated,
    fallback: !generated,
    reviewed: !generated && spec.reviewed === true && FINANCE.includes(spec.category),
    verifiedSource,
    sourceFresh,
    publishable: quality.ok && ((generated && FINANCE.includes(spec.category))
      || (generated && verifiedSource && sourceFresh && flagOn(ENABLE_AI_NEWS_CAROUSELS)
        && (spec.category === 'ai-news' || spec.category === 'latest-news'))),
    quality,
    stories,
    lines: (ready.slides || []).map((s, i) => ({
      n: i + 1,
      headline: (s.headline || '').replace(/\n/g, ' '),
      subline: (s.subline || '').replace(/\n/g, ' ') || null,
      source: s.source || null,
      figures: (s.figures || []).map((f) => `${f.label} ${f.text}`),
      calc: s.calc || null,
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
