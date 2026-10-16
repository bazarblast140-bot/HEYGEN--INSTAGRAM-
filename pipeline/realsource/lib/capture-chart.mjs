// Capture the public TradingView NSE:NIFTY 1D chart (headless, not logged in)
// and read every visible bar's OHLC from TradingView's own legend by hovering.
// Writes <out>/tv.png (unaltered screenshot), <out>/tv-bars.json, <out>/tv-meta.json.
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

export const chartUrl = (interval = 'D') => `https://www.tradingview.com/chart/?symbol=NSE%3ANIFTY&interval=${interval}`;
export const CHART_URL = chartUrl('D');
const DPR = 3;
const num = (s) => Number(String(s).replace(/[,\u2212]/g, (c) => (c === ',' ? '' : '-')));

function parseLegend(text) {
  const t = text.replace(/\s+/g, ' ');
  const m = t.match(/O\s*([\d,.]+)\s*H\s*([\d,.]+)\s*L\s*([\d,.]+)\s*C\s*([\d,.]+)\s*([+\u2212-][\d,.]+)\s*\(([+\u2212-][\d.]+)%\)/);
  if (!m) return null;
  return { o: num(m[1]), h: num(m[2]), l: num(m[3]), c: num(m[4]), chg: num(m[5]), pct: num(m[6]) };
}

export async function captureChart({ out, log = console.log, zoomSteps = 10, interval = 'D', prefix = 'tv' }) {
  const url = chartUrl(interval);
  await fs.mkdir(out, { recursive: true });
  const b = await chromium.launch();
  try {
    const p = await b.newPage({ viewport: { width: 860, height: 1000 }, deviceScaleFactor: DPR });
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForSelector('[class*="valuesWrapper"]', { timeout: 45000 });
    await p.waitForTimeout(7000);
    await p.getByText('Got it!').click({ timeout: 1500 }).catch(() => {});
    // Chart time axis in IST (anonymous default is UTC).
    await p.locator('[data-name="time-zone-menu"]').first().click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(800);
    await p.getByText(/Kolkata/).first().click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(800);
    const tz = await p.locator('[data-name="time-zone-menu"]').first().innerText({ timeout: 2000 }).catch(() => '?');
    if (!/UTC\+5:30/.test(tz)) log(`WARNING: chart timezone is "${tz}", not UTC+5:30`);
    // Hide the right-hand watchlist/details panel so the chart gets the width.
    const panelOpen = await p.getByText('Watchlist', { exact: true }).first().isVisible().catch(() => false);
    if (panelOpen) await p.locator('[data-name="base"][aria-label*="Watchlist"]').first().click({ timeout: 3000 }).catch(() => {});
    await p.waitForTimeout(2500);
    // Zoom in (mouse wheel over the chart) so ~2.5 months of daily bars fill the pane.
    await p.mouse.move(600, 500); await p.keyboard.down('Control');
    for (let i = 0; i < zoomSteps; i += 1) { await p.mouse.wheel(0, -120); await p.waitForTimeout(350); }
    await p.keyboard.up('Control');
    await p.waitForTimeout(1200);
    // Mouse off the chart: legend shows the last bar, no crosshair in the shot.
    await p.mouse.move(550, 982);
    mergeLiveRuns(runs);
    await p.waitForTimeout(1500);
    await p.locator('[class*="toast"] button, [data-name="toast-close"]').first().click({ timeout: 800 }).catch(() => {});
    await p.waitForTimeout(500);
    const legendText = await p.locator('[class*="valuesWrapper"]').first().innerText({ timeout: 2000 });
    const title = await p.evaluate(() => document.querySelector('[data-name="legend-series-item"]')?.innerText.split('\n').slice(0, 3).join(' ') || '');
    const capturedAt = new Date();
    await p.screenshot({ path: path.join(out, `${prefix}.png`) });
    const last = parseLegend(legendText);
    if (!last) throw new Error(`could not read the TradingView legend: "${legendText.slice(0, 120)}"`);

    // Chart pane geometry (CSS px): the main canvas pane left of the price axis.
    const pane = await p.evaluate(() => {
      const c = [...document.querySelectorAll('.chart-markup-table canvas, canvas')]
        .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 300 && r.height > 300)
        .sort((a, b) => b.width * b.height - a.width * a.height)[0];
      return c ? { x: c.x, y: c.y, w: c.width, h: c.height } : null;
    });
    if (!pane) throw new Error('chart pane not found');

    // Sweep the crosshair across the pane; each bar = a run of x with one OHLC.
    const runs = [];
    const yMid = pane.y + pane.h * 0.45;
    for (let x = Math.ceil(pane.x) + 2; x < pane.x + pane.w - 2; x += 1) {
      await p.mouse.move(x, yMid);
      const t = await p.locator('[class*="valuesWrapper"]').first().innerText({ timeout: 1000 }).catch(() => '');
      const v = parseLegend(t);
      if (!v) continue;
      const key = `${v.o}|${v.h}|${v.l}|${v.c}`;
      const prev = runs[runs.length - 1];
      if (prev && prev.key === key) { prev.x1 = x; } else runs.push({ key, x0: x, x1: x, ...v });
    }
    await p.mouse.move(550, 982);
    // The last bar may be cut by the right edge sweep; keep runs with >= 2 px.
    // Bar centre = middle of its hover run. The first and last runs extend to
    // the pane edges, so they sit one bar spacing from their neighbour instead.
    const mids = runs.map((r) => (r.x0 + r.x1) / 2);
    const gaps = mids.slice(2, -1).map((m, i) => m - mids[i + 1]).sort((a, b) => a - b);
    const spacing = gaps[Math.floor(gaps.length / 2)];
    const bars = runs.map((r, i) => ({
      xCss: i === 0 ? mids[1] - spacing : i === runs.length - 1 ? mids[i - 1] + spacing : mids[i],
      o: r.o, h: r.h, l: r.l, c: r.c, chg: r.chg, pct: r.pct,
    }));
    // The live (last) bar can tick during the sweep: keep its last reading.
    if (bars.length) Object.assign(bars[bars.length - 1], { o: last.o, h: last.h, l: last.l, c: last.c, chg: last.chg, pct: last.pct });
    const meta = {
      url, symbol: 'NSE:NIFTY', timeframe: interval === 'D' ? '1D' : `${interval}m`, dpr: DPR, viewport: [860, 1000],
      capturedAt: capturedAt.toISOString(), spacingCss: spacing, legendText: legendText.replace(/\s+/g, ' ').trim(), title, last, pane,
      indicators: 'none added (TradingView default volume pane only)', chartTimezone: tz,
    };
    await fs.writeFile(path.join(out, `${prefix}-bars.json`), JSON.stringify(bars, null, 1));
    await fs.writeFile(path.join(out, `${prefix}-meta.json`), JSON.stringify(meta, null, 1));
    log(`chart ${interval}: ${bars.length} bars read, last C ${last.c} (${last.pct}%), captured ${capturedAt.toISOString()}`);
    return { bars, meta };
  } finally { await b.close(); }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const out = process.argv[2] || 'out';
  await captureChart({ out });
}

// The live (last) bar can tick while the crosshair sweeps over it, which splits its
// hover run in two (16 Oct 2026: 76 "bars", the stale reading matched no Yahoo date).
// Contiguous trailing runs with the same open are ONE bar: merge them, keep the newest values.
export function mergeLiveRuns(runs) {
  while (runs.length >= 2) {
    const a = runs[runs.length - 2], b = runs[runs.length - 1];
    if (a.o !== b.o || b.x0 - a.x1 > 1) break;
    runs.splice(runs.length - 2, 2, { ...b, x0: a.x0 });
  }
  return runs;
}
