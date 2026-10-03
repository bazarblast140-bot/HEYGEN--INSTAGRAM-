#!/usr/bin/env node
// Tile a carousel's slides into one PNG for review.
//
//   node pipeline/contact-sheet.js --dir pipeline/out/slides --out pipeline/out/contact-sheet.png
//
// Uses the same headless Chromium the renderer uses, so it needs nothing else.

import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export async function contactSheet({ files, out, columns = 5, width = 360, title = '' }) {
  const n = files.length;
  const rows = Math.ceil(n / columns);
  const h = Math.round(width * 1.25);
  const cells = files.map((f, i) => `<figure><img src="${pathToFileURL(path.resolve(f)).href}"><figcaption>${i + 1}</figcaption></figure>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;background:#05070d;color:#94A3B8;font:600 20px sans-serif}
    h1{margin:0;padding:14px 20px;font-size:22px;color:#E2E8F0}
    main{display:grid;grid-template-columns:repeat(${columns},${width}px);gap:12px;padding:0 20px 20px}
    figure{margin:0;position:relative} img{width:${width}px;height:${h}px;display:block;border-radius:8px}
    figcaption{position:absolute;top:6px;right:10px;color:#FACC15}
  </style><h1>${title}</h1><main>${cells}</main>`;
  const tmp = path.join(path.dirname(path.resolve(out)), '.contact-sheet.html');
  await fs.writeFile(tmp, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: columns * (width + 12) + 28, height: rows * (h + 12) + 80 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
    await page.screenshot({ path: out, fullPage: true });
  } finally {
    await browser.close();
    await fs.rm(tmp, { force: true });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
  const dir = args.dir || path.join(path.dirname(fileURLToPath(import.meta.url)), 'out', 'slides');
  const files = (await fs.readdir(dir)).filter((f) => /^\d+\.(jpe?g|png)$/.test(f)).sort().map((f) => path.join(dir, f));
  const out = args.out || path.join(path.dirname(dir), 'contact-sheet.png');
  await contactSheet({ files, out, title: args.title || '' });
  console.log(`contact sheet ${files.length} slides -> ${out}`);
}
