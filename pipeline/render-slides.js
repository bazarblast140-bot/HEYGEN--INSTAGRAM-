#!/usr/bin/env node
// Render a carousel spec to slide images.
//
//   node pipeline/render-slides.js --spec pipeline/specs/carousel-hindi.json
//   node pipeline/render-slides.js --demo --out pipeline/out/slides
//   node pipeline/render-slides.js --spec ... --format png   # lossless, not postable
//
// One browser, one page, N screenshots. Reusing the page across slides keeps a
// 10-slide carousel under ten seconds; a fresh context per slide costs more in
// startup than every screenshot combined.

import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENE = path.join(HERE, 'src', 'render', 'scenes', 'slide.html');

export const WIDTH = 1080;
export const HEIGHT = 1350;          // 4:5 — the tallest ratio the feed allows

/**
 * JPEG, not PNG, and not as a size trade-off.
 *
 * Instagram's image container accepts JPEG. Hand it a PNG and the file is
 * fetched and then refused, with an error about unsupported media that reads
 * like a problem with the picture rather than with its format. Since the only
 * reason these files exist is to be posted, the default is the one that can be.
 *
 * The artifact is then also exactly what goes on the feed — reviewing a PNG and
 * posting a re-encode means the thing checked is not the thing published.
 * quality 92 keeps flat colour and Devanagari edges clean; Instagram re-encodes
 * on its own side regardless.
 */
export const FORMAT = 'jpeg';
export const QUALITY = 92;

const DEMO = {
  brand: 'FACTVIZER',
  slides: [
    { band: 'center', headline: 'दुनिया की सबसे बड़ी कंपनियाँ\n1 करोड़ रुपये कितनी देर में कमाती हैं' },
    { headline: 'एप्पल', subline: '1 करोड़ रुपये\n52 सेकंड में' },
    { headline: 'रिलायंस', subline: '1 करोड़ रुपये\n4 मिनट 12 सेकंड में' },
    { headline: 'टीसीएस', subline: '1 करोड़ रुपये\n9 मिनट 30 सेकंड में' },
  ],
};

// Same shape as the reel pipeline's arg parsing, so the two scripts stay
// callable the same way from the workflow.
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

function findBundledChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = fsSync.readdirSync(root); } catch { continue; }
    for (const entry of entries.filter((e) => e.startsWith('chromium-')).sort().reverse()) {
      const candidate = path.join(root, entry, 'chrome-linux', 'chrome');
      if (fsSync.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** A local file has to become a file:// URL before CSS can load it. */
function toUrl(src) {
  if (!src) return undefined;
  if (/^(https?|file|data):/.test(src)) return src;
  return pathToFileURL(path.resolve(src)).href;
}

export async function renderSlides({ spec, outDir, onProgress, format = FORMAT, quality = QUALITY }) {
  if (!['jpeg', 'png'].includes(format)) throw new Error(`Unknown format "${format}" — jpeg or png.`);
  const slides = spec.slides || [];
  if (!slides.length) throw new Error('Spec has no slides.');
  if (slides.length > 10) throw new Error(`Instagram allows 10 slides per carousel; spec has ${slides.length}.`);

  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || findBundledChromium(),
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
  });

  const files = [];
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    page.on('pageerror', (err) => { throw new Error(`Slide scene threw: ${err.message}`); });

    await page.goto(pathToFileURL(SCENE).href, { waitUntil: 'load' });

    // Force every bundled face to load before the first slide is measured.
    //
    // document.fonts.ready is not enough on its own, and the way it fails is
    // quiet. A face is only fetched once rendered text needs it, and at this
    // point every text node in the scene is empty — so ready resolves at once
    // with nothing loaded. The scene then fits its text against the *fallback*
    // metrics, the real face arrives, and the finished line rewraps underneath
    // a size that was chosen for a different font.
    //
    // Measured on the cover slide: without this the headline fitted at 82px
    // and reflowed to three lines where the spec asked for two, and the brand
    // bar — positioned from the headline's box — landed on top of the first
    // line. With it: two lines at 80px, bar 82px clear.
    await page.evaluate(async () => {
      await Promise.all([...document.fonts].map((f) => f.load()));
      await document.fonts.ready;
    });

    for (let i = 0; i < slides.length; i += 1) {
      const slide = slides[i];
      const payload = {
        brand: spec.brand,
        ink: spec.ink,
        brandInk: spec.brandInk,
        ...slide,
        background: toUrl(slide.background),
        logo: toUrl(slide.logo || spec.logo),
        insets: (slide.insets || []).map((it) => ({ ...it, image: toUrl(it.image) })),
      };

      await page.evaluate((d) => window.__slide.load(d), payload);
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      await page.evaluate(() => document.fonts.ready);

      const file = path.join(outDir, `${String(i + 1).padStart(2, '0')}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      await page.screenshot({
        path: file, type: format, animations: 'disabled',
        ...(format === 'jpeg' ? { quality } : {}),
      });
      files.push(file);
      onProgress?.(i + 1, slides.length);
    }
  } finally {
    await browser.close();
  }

  return { files, width: WIDTH, height: HEIGHT, format };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = args.spec ? JSON.parse(await fs.readFile(args.spec, 'utf8')) : DEMO;
  const outDir = path.resolve(args.out || path.join(HERE, 'out', 'slides'));

  const { files } = await renderSlides({
    spec, outDir,
    ...(args.format ? { format: args.format } : {}),
    onProgress: (n, total) => process.stdout.write(`\rrendering ${n}/${total}`),
  });

  process.stdout.write(`\r${files.length} slides -> ${path.relative(process.cwd(), outDir)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(`\n${err.message}`); process.exit(1); });
}
