// Where the presenter's face lands in the panel.
//
// This has been wrong twice with a hardcoded number — 0.5 cropped to the chest,
// 0.22 cropped to the eyes and cut the mouth off — so the anchor is derived and
// the derivation is checked here against a real measurement.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorForCrown, TOP, BOTTOM, FRAME } from '../pipeline/src/assemble/compose.js';

// Measured off a finished reel: the panel showed a plain wall down to row ~350
// of 780, which places the crown at source row ~401 of 1280.
const SOURCE = { sourceWidth: 720, sourceHeight: 1280 };
const CROWN = 401 / 1280;

test('the panels still fill the frame exactly', () => {
  assert.equal(TOP.height + BOTTOM.height, FRAME.height);
});

test('the head fits the panel, with the mouth well inside it', () => {
  const anchor = anchorForCrown({ crown: CROWN, ...SOURCE });

  // Replay the crop ffmpeg will perform, in source pixels.
  const scale = Math.max(BOTTOM.width / 720, BOTTOM.height / 1280);
  const cropTopSource = (anchor * (1280 * scale - BOTTOM.height)) / scale;
  const windowSource = BOTTOM.height / scale;

  const crownSource = 401;
  const chinSource = 903;   // crown + a head height inferred from the eye line
  const mouthSource = 793;

  assert.ok(cropTopSource < crownSource, 'the crop must start above the crown');
  assert.ok(
    cropTopSource + windowSource > chinSource + 40,
    `chin at ${chinSource} must sit inside the window ending at ${(cropTopSource + windowSource).toFixed(0)}`,
  );

  // The old 780-tall panel could not hold the head at all: 520 source rows
  // against roughly 500 of head left no room, and the mouth fell off the edge.
  assert.ok(windowSource > chinSource - crownSource + 80, 'the panel needs margin around the head');

  const mouthInPanel = (mouthSource - cropTopSource) * scale;
  assert.ok(mouthInPanel > 0 && mouthInPanel < BOTTOM.height,
    `the mouth must be on screen; it is at panel row ${mouthInPanel.toFixed(0)} of ${BOTTOM.height}`);
});

test('headroom keeps the crown off the top edge', () => {
  const anchor = anchorForCrown({ crown: CROWN, ...SOURCE });
  const scale = Math.max(BOTTOM.width / 720, BOTTOM.height / 1280);
  const cropTopScaled = anchor * (1280 * scale - BOTTOM.height);
  const crownInPanel = CROWN * 1280 * scale - cropTopScaled;

  assert.ok(crownInPanel > 30, `crown at panel row ${crownInPanel.toFixed(0)} is flush with the cut`);
  assert.ok(crownInPanel < 160, `crown at panel row ${crownInPanel.toFixed(0)} wastes the panel on wall`);
});

test('an unreadable background falls back rather than cropping wildly', () => {
  assert.equal(anchorForCrown({ crown: null, ...SOURCE }), 0.45);
  assert.equal(anchorForCrown({ crown: null, sourceWidth: 1280, sourceHeight: 720 }), 0.5);
});

test('the anchor stays inside the frame for any crown position', () => {
  for (const c of [0, 0.05, 0.3, 0.6, 0.95, 1]) {
    const a = anchorForCrown({ crown: c, ...SOURCE });
    assert.ok(a >= 0 && a <= 1, `crown ${c} produced anchor ${a}`);
  }
});

test('the crown is found on a plain background, not assumed', async (t) => {
  const { detectCrown } = await import('../pipeline/src/assemble/compose.js');
  const { spawn } = await import('node:child_process');
  const os = await import('node:os');
  const path = await import('node:path');
  const fs = await import('node:fs/promises');

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'framing-'));
  const file = path.join(dir, 'stand-in.mp4');

  // A stand-in with a HeyGen portrait's shape: plain wall, subject from 31% down.
  const made = await new Promise((resolve) => {
    spawn('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xD8C9B0:s=720x1280:d=1',
      '-vf', 'drawbox=x=200:y=400:w=320:h=880:color=0x4A3528:t=fill',
      '-pix_fmt', 'yuv420p', '-y', file,
    ], { stdio: 'ignore' }).on('close', (code) => resolve(code === 0)).on('error', () => resolve(false));
  });
  if (!made) return t.skip('ffmpeg unavailable');

  const crown = await detectCrown(file);
  await fs.rm(dir, { recursive: true, force: true });

  assert.ok(crown !== null, 'a plain wall must be readable');
  assert.ok(Math.abs(crown - 400 / 1280) < 0.02, `crown ${crown?.toFixed(3)} should be near 0.313`);
});
