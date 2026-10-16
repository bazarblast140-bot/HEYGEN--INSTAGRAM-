// 16 Oct 2026 (run 38882644323): Mint's late top ad pushed the article down after measuring,
// so the headline crop showed the nav bar. The shot is accepted only if the rects did not move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sameLayout } from '../pipeline/realsource/lib/capture-news.mjs';

const m = (dy = 0) => ({ h1: { x: 104, y: 469 + dy, w: 656, h: 120 }, date: { rect: { x: 104, y: 725 + dy, w: 656, h: 40 } }, key: { rects: [{ x: 104, y: 1357.5 + dy, w: 647, h: 21 }] } });
test('layout shift between measuring and screenshot is detected', () => {
  assert.ok(sameLayout(m(), m()));
  assert.ok(sameLayout(m(), m(0.5)));
  assert.ok(!sameLayout(m(), m(230)), 'a 230 px ad pushing the article down');
  assert.ok(!sameLayout(m(), { ...m(), key: { rects: [] } }));
});
test('capture re-measures after the screenshot before accepting it', async () => {
  const src = await fs.readFile(new URL('../pipeline/realsource/lib/capture-news.mjs', import.meta.url), 'utf8');
  assert.match(src, /screenshot\([^)]*news\.png[\s\S]*?sameLayout\(info, await measure\(\)\)/);
  assert.match(src, /position', 'static'/, 'sticky bars still go back into the page flow');
});
