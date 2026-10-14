// Capture a real news article: full-page screenshot (unaltered) plus the page
// rects of the masthead, headline lines, byline/date line and the key sentence,
// so the slide can crop/zoom and put a yellow highlight ON TOP of the shot.
// Usage: node capture-news.mjs <out dir> <url> "<key sentence substring>"
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function captureNews({ out, url, key, log = console.log, width = 1200, dpr = 2, mobile = false }) {
  const DPR = dpr;
  await fs.mkdir(out, { recursive: true });
  const b = await chromium.launch();
  try {
    const ctx = await b.newContext({ viewport: { width, height: 1500 }, deviceScaleFactor: DPR, isMobile: mobile, hasTouch: mobile, locale: 'en-IN', timezoneId: 'Asia/Kolkata',
      userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36' : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36' });
    const p = await ctx.newPage();
    const res = await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const status = res ? res.status() : 0;
    if (status >= 400) throw new Error(`article HTTP ${status} (blocked?) — pick another source`);
    await p.waitForTimeout(6000);
    for (const re of [/^(Accept|I Accept|Agree|I agree|Got it|OK|Allow)$/i, /^(No thanks|Not now|Later|Close|Maybe later)$/i]) {
      await p.getByRole('button', { name: re }).first().click({ timeout: 800 }).catch(() => {});
    }
    await p.keyboard.press('Escape').catch(() => {});
    // collapsed article bodies ("Read Full Story") — expand so the key sentence is really on screen
    if (await p.getByText(/^\s*(Read Full Story|Read More|Continue Reading)\s*$/i).first().click({ timeout: 1500 }).then(() => true).catch(() => false)) await p.waitForTimeout(1500);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.waitForTimeout(1000);
    // Overlays off before any measuring: fixed layers (ads, cookie bars, "Open in
    // App", chat bubbles) are hidden, sticky menus go back into the page flow.
    const hidden = await p.evaluate(() => {
      let n = 0;
      const h1 = document.querySelector('h1');
      for (const e of document.querySelectorAll('body *')) {
        const pos = getComputedStyle(e).position;
        if (pos === 'fixed') { if (h1 && e.contains(h1)) continue; e.style.setProperty('display', 'none', 'important'); n += 1; } else if (pos === 'sticky') { e.style.setProperty('position', 'static', 'important'); n += 1; }
      }
      const OVER = /^(open in app|open app|get the app|download (the )?app|accept( all)?( cookies)?|we use cookies.*|allow notifications.*)$/i;
      for (const e of document.querySelectorAll('a, button, div, span')) {
        if (e.children.length <= 2 && OVER.test((e.innerText || '').trim())) { e.style.setProperty('display', 'none', 'important'); n += 1; }
      }
      return n;
    });
    await p.waitForTimeout(800);
    const info = await p.evaluate((keyText) => {
      const R = (r) => ({ x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height });
      const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const h1 = [...document.querySelectorAll('h1')].filter(visible).sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0];
      if (!h1) return { error: 'no visible h1' };
      const range = document.createRange(); range.selectNodeContents(h1);
      const lines = [...range.getClientRects()].map(R).filter((r) => r.w > 4 && r.h > 4);
      // merge rects on the same line
      const merged = [];
      for (const r of lines.sort((a, b) => a.y - b.y || a.x - b.x)) {
        const m = merged.find((q) => Math.abs(q.y - r.y) < r.h * 0.5);
        if (m) { const x2 = Math.max(m.x + m.w, r.x + r.w); m.x = Math.min(m.x, r.x); m.w = x2 - m.x; m.h = Math.max(m.h, r.h); } else merged.push({ ...r });
      }
      const h1r = R(h1.getBoundingClientRect());
      // date line: nearest element below/around the h1 that looks like a date
      const DATE = /(Updated|Published|Last Updated|IST|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2},? 20\d\d|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* 20\d\d)/;
      const dateEls = [...document.querySelectorAll('time, span, div, p, li')].filter((e) => visible(e) && e.children.length <= 3 && (e.innerText || '').length < 120 && DATE.test(e.innerText || ''))
        .map((e) => ({ e, r: R(e.getBoundingClientRect()) })).filter(({ r }) => r.y > 40 && r.y > h1r.y - 300 && r.y < h1r.y + h1r.h + 1600)
        .sort((a, b) => ((a.r.y < h1r.y) - (b.r.y < h1r.y)) || Math.abs(a.r.y - h1r.y) - Math.abs(b.r.y - h1r.y));
      const dateEl = dateEls.find(({ e }) => /20\d\d/.test(e.innerText)) || dateEls[0];
      const metaTime = document.querySelector('meta[property="article:published_time"], meta[name="publish-date"], meta[itemprop="datePublished"]')?.content || '';
      const modTime = document.querySelector('meta[property="article:modified_time"], meta[itemprop="dateModified"]')?.content || '';
      const site = document.querySelector('meta[property="og:site_name"]')?.content || location.hostname;
      const author = document.querySelector('meta[name="author"], meta[property="article:author"]')?.content || '';
      // key sentence
      let key = null;
      if (keyText) {
        const norm = (s) => s.replace(/\s+/g, ' ');
        const want = norm(keyText).trim();
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        // search inside block elements so sentences split over inline tags still match
        const blocks = [...document.querySelectorAll('p, li, h2, h3, div')].filter((e) => visible(e) && norm(e.textContent || '').includes(want));
        const block = blocks.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length)[0];
        if (block) {
          // map the substring to a DOM range across text nodes
          const nodes = []; const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) nodes.push(n);
          let flat = ''; const map = [];
          for (const t of nodes) { for (let i = 0; i < t.data.length; i += 1) { const ch = /\s/.test(t.data[i]) ? ' ' : t.data[i]; if (ch === ' ' && flat.endsWith(' ')) continue; flat += ch; map.push([t, i]); } }
          const at = flat.indexOf(want);
          if (at >= 0) {
            const [sn, so] = map[at]; const [en, eo] = map[at + want.length - 1];
            const rg = document.createRange(); rg.setStart(sn, so); rg.setEnd(en, eo + 1);
            const rs = [...rg.getClientRects()].map(R).filter((r) => r.w > 2);
            const lm = [];
            for (const r of rs.sort((a, b) => a.y - b.y || a.x - b.x)) {
              const m = lm.find((q) => Math.abs(q.y - r.y) < r.h * 0.5);
              if (m) { const x2 = Math.max(m.x + m.w, r.x + r.w); m.x = Math.min(m.x, r.x); m.w = x2 - m.x; m.h = Math.max(m.h, r.h); } else lm.push({ ...r });
            }
            // Gate: every highlighted line must be fully on the page width and
            // nothing may sit on top of it (sampled with elementFromPoint).
            let covered = 0; let samples = 0; let offPage = 0;
            for (const r of lm) {
              if (r.x < 0 || r.x + r.w > document.documentElement.clientWidth + 1) offPage += 1;
              window.scrollTo(0, Math.max(0, r.y - innerHeight / 2));
              for (const f of [0.03, 0.25, 0.5, 0.75, 0.97]) {
                const vx = r.x + r.w * f - scrollX; const vy = r.y + r.h / 2 - scrollY;
                samples += 1;
                const top = document.elementFromPoint(vx, vy);
                if (!top || !(block.contains(top) || top.contains(block))) covered += 1;
              }
            }
            window.scrollTo(0, 0);
            key = { text: want, rects: lm, block: R(block.getBoundingClientRect()), blockText: norm(block.textContent).trim().slice(0, 600), covered, samples, offPage };
          }
        }
      }
      // masthead: a logo image/svg in the top 260 px, else the site header strip
      const logos = [...document.querySelectorAll('header img, header svg, a[href="/"] img, a[href="/"] svg, [class*="logo"] img, [class*="logo"] svg, img[alt*="logo" i]')]
        .filter(visible).map((e) => R(e.getBoundingClientRect())).filter((r) => r.y < Math.max(260, h1r.y - 20) && r.w > (innerWidth < 700 ? 36 : 80) && r.h > 15).sort((a, b) => b.w * b.h - a.w * a.h);
      const mast = logos.filter((r) => r.x >= 0 && r.x + r.w <= innerWidth)[0] || null;
      return {
        headline: (h1.innerText || '').trim(), headlineLines: merged, h1: h1r,
        date: dateEl ? { text: dateEl.e.innerText.trim().replace(/\s+/g, ' '), rect: dateEl.r } : null,
        metaTime, modTime, site, author, key, mast, bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 40000), pageHeight: document.documentElement.scrollHeight, title: document.title,
      };
    }, key || '');
    if (info.error) throw new Error(info.error);
    if (key && !info.key) throw new Error(`key sentence not found on the page: "${key.slice(0, 80)}"`);
    if (info.key && (info.key.covered || info.key.offPage)) throw new Error(`key line not fully visible: ${info.key.covered}/${info.key.samples} points covered, ${info.key.offPage} line(s) off the page`);
    info.overlaysHidden = hidden;
    const capturedAt = new Date();
    const clipH = Math.min(info.pageHeight, Math.max(2400, (info.key ? info.key.block.y + info.key.block.h : 0) + 200));
    await p.screenshot({ path: path.join(out, 'news.png'), fullPage: true, clip: { x: 0, y: 0, width, height: clipH } });
    const meta = { url, status, capturedAt: capturedAt.toISOString(), dpr: DPR, ...info };
    await fs.writeFile(path.join(out, 'news.json'), JSON.stringify(meta, null, 1));
    log(`news: "${info.headline}" — ${info.site} — date "${info.date?.text || info.metaTime}" — key ${info.key ? 'found' : 'none'}`);
    return meta;
  } finally { await b.close(); }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const [out, url, key] = process.argv.slice(2);
  await captureNews({ out, url, key });
}
