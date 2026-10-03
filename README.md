# HeyGen Instagram

Turn a written script into a HeyGen avatar video sized for Instagram — Reels/Stories (9:16),
feed posts (1:1) or landscape (16:9). Ships with a small Express API, a browser UI, and a CLI
for batch/scripted runs.

## What it does

- Lists your HeyGen avatars, talking photos and voices
- Submits a script to HeyGen's video generation API at an Instagram-safe size
- Polls the render until it is done, then previews and downloads the MP4
- Guards the script length so a reel stays inside Instagram's 90-second limit

## Setup

```bash
npm install
cp .env.example .env      # then paste your HeyGen API key
npm start                 # http://localhost:3000
```

Get the API key from **HeyGen → Settings → API**. It is read from `.env` and never leaves
the server — the browser only talks to this app's own `/api` routes.

## CLI

```bash
npm run generate -- --script "Hook. Value. CTA." --avatar <avatar_id> --voice <voice_id>
npm run generate -- --file script.txt --preset feed --captions --out downloads/
```

| Flag | Meaning |
| --- | --- |
| `--script` / `--file` | Script text inline, or read from a file |
| `--avatar` / `--voice` | HeyGen ids (fall back to `DEFAULT_AVATAR_ID` / `DEFAULT_VOICE_ID`) |
| `--preset` | `reel` (720×1280, default), `feed` (1080×1080), `landscape` (1280×720) |
| `--talkingPhoto` | Treat `--avatar` as a talking-photo id |
| `--captions` | Burn captions into the video |
| `--out DIR` | Download the finished MP4 into `DIR` |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Server up + whether the API key is configured |
| `GET` | `/api/avatars` | Avatars and talking photos |
| `GET` | `/api/voices?language=&q=` | Voices, optionally filtered |
| `GET` | `/api/presets` | Output size presets |
| `GET` | `/api/quota` | Remaining HeyGen credits |
| `POST` | `/api/videos` | Start a render → `{ videoId }` |
| `GET` | `/api/videos/:videoId` | Render status → `{ status, videoUrl, duration }` |

`POST /api/videos` body:

```json
{
  "script": "Hook in the first 2 seconds. Then the value. Then the CTA.",
  "avatarId": "Daisy-inskirt-20220818",
  "voiceId": "1bd001e7e50f421d891986aad5158bc8",
  "preset": "reel",
  "speed": 1,
  "captions": true,
  "backgroundColor": "#111827"
}
```

## Layout

```
src/
  config.js          env, output presets, script-length budget
  heygen.js          HeyGen REST client (avatars, voices, generate, status)
  server.js          Express app + static hosting
  routes/            /api/avatars, /api/voices, /api/videos
public/              browser UI (vanilla JS, no build step)
scripts/generate.js  CLI: generate → poll → download
```

## Notes

- Renders are asynchronous. The UI and CLI both poll every 5s and stop after ~10 minutes.
- Instagram caps Reels at 90 seconds; the API rejects scripts over 220 words (~90s at
  150 wpm) before spending HeyGen credits.
- `.env` is gitignored. Never commit the API key.

### Re-render a reviewed preview with edits (no model call)

When a reviewer wants small exact changes to a preview, commit an edits file
under `pipeline/specs/edits/` (ops: `calc`, `text`, `caption_replace`; every
edit must hit its target or the run stops) and dispatch

    gh workflow run carousel-preview.yml -f slot=evening -f spec_from_run=<preview run id> -f edits=pipeline/specs/edits/<file>.json

The run downloads that preview's `spec-generated.json`, applies the edits,
renders, runs the full quality gate and uploads the same `carousel` artifact
(report carries `rerender.fromRun`, the source spec sha256 and the edit list).
That step has no model key. Publish it, like any preview, with
`carousel.yml approve_build=<the re-render's run id>`.

### Cover photo (slide 1 only)

Inner slides stay chart-boards. The model adds `coverPhoto: { queries, mustHave, avoid }`;
`pipeline/src/carousel/cover-photo.js` searches Pexels (free key) then Wikimedia Commons
(CC0 / public domain / CC BY only), rejects by metadata (documents, forms, invoices, paper,
screens, charts, logos; on finance: foreign context, named people / ceremonies, and no
Indian marker), then rejects any downloaded photo with visible text or long numbers
(tesseract, free and local). The source, page URL, licence and every rejection reason are
in `carousel-report.json → coverPhoto`. No photo passes → the v3 chart cover. A photo never
blocks a post; the number, Hinglish and source gates still do.

