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

## Reel structure and why the avatar is short

HeyGen bills avatar video by the minute, so the avatar carries only the hook —
a few seconds of face to establish who is speaking — and the rest of the reel is
rendered graphics and free stock footage with a voiceover over it.

```
0s   ┌─────────────┐  avatar  — HeyGen, ~5s of billed video
     ├─────────────┤
5s   │ chart scene │  rendered locally, free
     ├─────────────┤
11s  │ stock b-roll│  Pexels / Pixabay, free
     ├─────────────┤
     │ ...         │
45s  └─────────────┘
```

A 45-second reel then costs about five seconds of avatar rather than forty-five.
The voice stays continuous because both halves use the same cloned voice id: the
avatar clip's own audio covers the hook, HeyGen TTS covers the body.

`src/assemble/timeline.js` builds it. Video and audio are assembled separately and
muxed, because concat misbehaves when some inputs carry audio and others do not.

- Every segment is scaled to fill, centre-cropped and locked to 30 fps, so stock
  footage in any aspect fits without letterboxing.
- Stock gets a slight darken and desaturate so it settles into the dark palette
  instead of jumping out of it.
- A segment shorter than its slot holds its last frame rather than cutting to black.
- The music bed is **ducked by the voice**, not just set quiet, so it stays present
  in the gaps. The reference reels never drop to silence — not once across five files.
- Mastered to −14 LUFS, which is what all five reference reels measured at.

## Stock footage

`src/stock/index.js` searches Pexels first and falls back to Pixabay. A provider
that is unconfigured or erroring is skipped rather than failing the run — losing
one b-roll source should never cost the day's post.

Both licenses allow commercial use without attribution. Neither allows implying
that a person shown endorses anything, so the script must never pair a stock face
with a claim about a real person.

## Where the avatar appears

The avatar is a split-screen panel, never the whole frame: **visual on top, presenter
in the bottom half**. It appears twice in a reel — the hook, and one short cut-in
that punctuates the reel before its most important number.

```
0.0s  ┌───────────┐  hook      card + avatar   7.4s
      │ card      │
      ├───────────┤
      │ avatar    │
7.4s  ├───────────┤  chart     full frame      5.0s
12.4s ├───────────┤  b-roll    full frame      4.0s
16.4s ├───────────┤  cut-in    card + avatar   2.6s
19.0s ├───────────┤  stat      full frame      7.0s
26.0s ├───────────┤  CTA       full frame      5.0s
31.0s └───────────┘
```

Avatar covers about **10 of 31 seconds**, and only the panel is avatar video —
so the billed HeyGen minutes track the cut-ins, not the reel length.

## Card scene

`src/render/scenes/card.html` is the general-purpose statement / stat card, the
counterpart to the chart scene for topics that are not price action — policy news,
flows, fund returns, IPOs. Same `__scene.seek(f)` contract, same two layouts.

```bash
npm run card -- --demo hook --layout panel --seconds 7.4
npm run card -- --spec my-card.json --layout full --seconds 5
```

Spec fields: `chips[]`, `headline`, `power` (the serif-italic word), optional
`stat: { value, label, direction }`, `footnote`. Long stat values are measured and
shrunk to fit on one line rather than wrapping.

## Building a whole reel

```bash
node pipeline/build-reel.js --spec pipeline/specs/default.json
node pipeline/build-reel.js --spec ... --fixture      # sample market data
node pipeline/build-reel.js --spec ... --no-avatar    # skip HeyGen, save credits
```

A spec lists the beats. `hook` and `cutin` are avatar panels; `chart`, `card` and
`stock` are full-frame. `body` is the narration that covers everything between.

### Degrading instead of failing

HeyGen quota runs out, stock providers rate-limit, and a market holiday leaves no
fresh candles. None of that should cost the day's post, so every optional stage
falls back to something that still renders, and the fallback is written into
`run-report.json`:

| Stage fails | What happens instead |
| --- | --- |
| Live market data | Sample series, and the reel is marked not publishable |
| Avatar (quota, credit, plan) | The beat becomes a full-frame card and TTS speaks the line |
| Voiceover | Silence of the same length, and the reel is marked not publishable |
| Stock footage | The beat is dropped and the reel is that much shorter |

The build still produces a file so you can look at what went wrong. Whether it may
be **published** is a separate flag — `publishable` is true only with live data and
a real voiceover.

## GitHub Actions

`.github/workflows/build-reel.yml` runs the whole thing on a runner, where the APIs
this pipeline needs are actually reachable. Weekdays at 07:00 IST (`30 1 * * 1-5`,
since Actions cron is UTC), or on demand from the Actions tab.

Repository **secrets**: `HEYGEN_API_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY`.
Repository **variables** (not secret): `HEYGEN_AVATAR_ID`, `HEYGEN_VOICE_ID`.

The finished MP4, the run report, and the TTS word timings upload as an artifact —
including on failure, so a bad run can be inspected rather than guessed at.

## Publishing

Uses the **Instagram API with Instagram Login** — no Facebook Page anywhere. That is
a different surface from the Page-based Graph API, and the differences matter:

| | Instagram Login (this) | Facebook Page route |
| --- | --- | --- |
| Host | `graph.instagram.com` | `graph.facebook.com` |
| Token | Instagram user token | Page token |
| Permissions | `instagram_business_basic`, `instagram_business_content_publish` | `instagram_basic`, `instagram_content_publish` |
| Facebook Page | not needed | required |

```bash
node pipeline/publish-reel.js --whoami                    # check the token first
node pipeline/publish-reel.js --url https://.../reel.mp4 \
  --caption-file caption.txt --report pipeline/out/run-report.json
```

Passing `--report` makes the publisher refuse a reel the build already marked
unpublishable — sample data or no voiceover — rather than finding out on the feed.

### The video must be at a public URL first

Instagram **fetches** the file; it never accepts an upload. So the MP4 has to be
reachable over plain HTTPS with no authentication before publishing runs.

This repo is private, which rules out the obvious options: Actions artifacts need a
token, and release assets on a private repo do too. Something publicly readable is
required — a public bucket (Cloudflare R2's free tier works), or a separate public
repo used only as a media host.

### Unverified details

`docs.instagram.com` and `graph.instagram.com` are both unreachable from the build
environment, so the host, API version and field names are inferred rather than
confirmed. `IG_API_HOST` and `IG_API_VERSION` override them, and every failure
prints the exact URL it called so a mismatch is obvious.

## Tokens

The Graph API Explorer hands out a token that expires in an hour or two. A daily
poster on that token works once and then fails every morning after, so exchange it:

```bash
node pipeline/token-tool.js inspect      # what you currently have, and when it dies
node pipeline/token-tool.js longlived    # short-lived -> ~60 day user token
node pipeline/token-tool.js page         # long-lived user token -> Page token
```

A Page token derived from a **long-lived** user token carries no expiry, which is
what a scheduled job needs. Derived from a short-lived one it expires too, so run
`longlived` first.

`token-tool.js` runs locally, reads `IG_ACCESS_TOKEN` from `.env`, prints the new
token to your terminal, and writes nothing anywhere. Copy the result into `.env`
and into the repository secret.

### Which surface

```bash
node pipeline/publish-reel.js --whoami
```

Tries both `graph.facebook.com` and `graph.instagram.com` with your token and
account id, and tells you which answers. Set `IG_SURFACE` to that. Worth running
before any scheduled post — a token that was never going to publish otherwise
wastes a full build.
