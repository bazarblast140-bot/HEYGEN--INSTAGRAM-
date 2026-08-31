# Cover art

Drop a picture in here and the **first slide** of the matching post uses it,
instead of anything searched from Pexels or NASA. No API key, no credits, no
network — the file is read straight off disk at build time.

## Naming

The build looks for these, in this order, and stops at the first one it finds:

| File | Used by |
| --- | --- |
| `<category>.jpg` | every post in that category — `space.jpg`, `animals.jpg`, `history.jpg` … |
| `<slot>.jpg` | every post in that slot — `morning.jpg`, `midday.jpg`, `evening.jpg` |
| `default.jpg` | everything else |

`.jpg`, `.jpeg`, `.png` and `.webp` all work; the slides are re-encoded to JPEG
on the way out either way. An empty file is ignored, and an empty folder leaves
the old searched-photo behaviour exactly as it was.

`midday.jpg` is the useful one for the news post — its subject changes every
day, so no searched photo ever fits it, and a single strong abstract cover fits
all of them.

## What the picture has to do

The slide is **1080 × 1350** (4:5 portrait) and the template lays a scrim over
it, so the picture is not seen whole:

- **Top 0–20%** — dimmed about half. The brand row sits here.
- **20–45%** — nearly clear. **This is the only part that is properly visible.
  Put the subject here.**
- **45–60%** — fades to black.
- **Bottom 60–100%** — solid black. The hook text goes here. Anything drawn in
  this band is invisible; do not put the subject there.

So: subject high and centred, plenty of empty sky or dark space below it, and
**no text in the picture** — the hook is drawn on top in Hindi and two lots of
text on one slide looks like a mistake.
