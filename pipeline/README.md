# Daily market-reel pipeline

Turns a real market session into a published Instagram Reel with no human in the edit.
Built from a teardown of five competitor reels — see the plan artifact for the analysis.

Phase 1 is in place: **market series → animated 9:16 chart clip.**

## Run it

```bash
npm run chart:fixture                      # synthetic data, works with no network
npm run chart -- --symbol nifty            # live Yahoo data
npm run chart -- --symbol RELIANCE.NS --range 6mo --out pipeline/out/reliance.mp4
```

Output is 1080×1920, 30 fps, H.264 — Instagram Reels' native frame.

## How the render works

The scene is an ordinary HTML page that exposes one function:

```js
window.__scene.seek(frameIndex)   // paints exactly what frame N looks like
```

Everything visible is a pure function of the frame index — no CSS transitions, no
`requestAnimationFrame`, no wall clock. Playwright walks 0…N, screenshots each step,
and ffmpeg encodes the sequence. Two consequences matter:

- **Renders are reproducible.** The same input always produces the same bytes, so a
  QC check on one run means something for the next.
- **Capture can't race the animation.** Screen recording drops and duplicates frames
  under load; seeking cannot.

Geometry is authored in 720×1280 design pixels and captured at a 1.5× device pixel
ratio, so the canvas is drawn at output resolution rather than upscaled.

## Layout contract

The bottom 128 px (design space) is reserved — captions are burned in there later by
ffmpeg. Scenes must not draw into it.

## Data

`src/harvest/yahoo.js` reads OHLC from Yahoo Finance's chart endpoint. No key needed,
but it is undocumented: every field is validated and a bad payload throws rather than
producing a wrong chart. **It is blocked by the network policy inside Claude Code
sessions and works on GitHub Actions runners.**

`src/harvest/fixture.js` generates a deterministic synthetic series for offline work.
Anything derived from it carries `synthetic: true`, the scene stamps it `SAMPLE DATA`
on screen, and the publish step must refuse it.

## Files

```
src/harvest/yahoo.js          live OHLC + session summary
src/harvest/fixture.js        seeded synthetic series for offline dev
src/render/scenes/candles.html   animated candlestick scene
src/render/capture.js         Playwright frame-exact capture
src/assemble/encode.js        ffmpeg encode + ffprobe verification
render-chart.js               CLI tying it together
assets/fonts/                 bundled woff2 — no network at render time
```

## Requirements

`ffmpeg` and `ffprobe` on PATH, and a Chromium build. Capture prefers an existing
browser under `PLAYWRIGHT_BROWSERS_PATH` or `/opt/pw-browsers` before falling back to
Playwright's own, so a version mismatch does not trigger a download. Override with
`CHROMIUM_PATH`.

## Hybrid frame

`compose-hybrid.js` stacks the chart panel over the presenter:

```
0     ┌────────────────────┐
      │ chart / graphics   │  1080 x 1140
1140  ├────────────────────┤  2px divider
      │ presenter          │  1080 x  780
1920  └────────────────────┘
```

```bash
npm run chart -- --fixture --layout panel --out pipeline/out/chart-panel.mp4
npm run hybrid -- --chart pipeline/out/chart-panel.mp4 --script "Aaj Nifty flat band hua..."
```

Given `--script` and no `--presenter`, the presenter clip is generated from the
HeyGen avatar and voice in `.env` (`HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`) first.
Pass `--presenter <file>` to composite a clip you already have.

The **presenter drives the duration**: the voiceover lives in that clip, so the
chart panel holds on its last frame if it is shorter and is trimmed if longer —
a long script can never truncate the speech. The presenter is scaled to cover
and centre-cropped, so whatever aspect HeyGen returns fills the panel.
