// Frame-exact capture: drive the scene by frame index and screenshot each step.
//
// Deliberately not a screen recording. The scene exposes __scene.seek(f) as a pure
// function of the frame number, so capture never races the animation and the same
// input always yields identical frames — which is what makes the QC gate meaningful.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Playwright's own browser build often mismatches the image's pre-installed one.
 * Prefer whatever Chromium is already on disk over triggering a download.
 */
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
  return undefined;   // fall back to Playwright's own resolution
}

export async function captureScene({
  scenePath, data, outDir,
  width = 720, height = 1280,
  scale = 1.5,               // 720x1280 design px -> 1080x1920 output
  onProgress,
}) {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || findBundledChromium(),
    args: ['--force-device-scale-factor=1', '--hide-scrollbars', '--disable-lcd-text'],
  });

  try {
    const page = await browser.newPage({
      viewport: { width, height },
      deviceScaleFactor: scale,
      // Freeze the clock: any stray Date.now() in a scene resolves to the same
      // value on every frame, so nothing can drift between renders.
      reducedMotion: 'reduce',
    });

    page.on('pageerror', (err) => { throw new Error(`Scene threw: ${err.message}`); });

    await page.goto(pathToFileURL(path.resolve(scenePath)).href, { waitUntil: 'load' });

    // Bundled woff2 files must be resident before the first screenshot, otherwise
    // early frames silently render in a fallback face.
    await page.evaluate(() => document.fonts.ready);

    const totalFrames = await page.evaluate((payload) => {
      window.__scene.load(payload);
      return window.__scene.totalFrames;
    }, data);

    const files = [];
    for (let f = 0; f < totalFrames; f += 1) {
      await page.evaluate((frame) => window.__scene.seek(frame), f);
      const file = path.join(outDir, `${String(f).padStart(5, '0')}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      files.push(file);
      if (onProgress && f % 15 === 0) onProgress(f, totalFrames);
    }

    return { files, totalFrames, width: width * scale, height: height * scale };
  } finally {
    await browser.close();
  }
}
