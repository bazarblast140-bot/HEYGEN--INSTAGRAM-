# Hand-supplied pictures

Pexels and NASA fill most slides. Where they find nothing, the slide falls back
to a plain gradient — **that** is the gap this folder fills, and only that gap.
A slide that already found a photo keeps it.

No API key, no credits, no network: the file is read off disk at build time.

## Reserved names — the account's own pictures

Three filenames mean a role, not a topic. These are **ours**, so they run before
the search and keep their slide whatever Pexels would have found:

| File | Slide |
| --- | --- |
| `cover.jpg` | slide 1, every post |
| `follow.jpg` | the follow card (the slide flagged `cta`), every post |
| `default.jpg` | a last resort for any slide still empty after the search |

To change the cover or the follow card, replace the file. Nothing else moves.

## Naming — by topic

Name the file after the topic, using the words that appear in the slide's search
query. Every word in the filename must appear in the query:

| File | Fills a slide whose query is | Does **not** fill |
| --- | --- | --- |
| `venus.jpg` | `venus surface radar` | `mars dust storm` |
| `venus-surface.jpg` | `venus surface radar` (beats `venus.jpg` — more specific) | `venus planet globe` |
| `solar-flare.jpg` | `solar flare eruption` | `solar panel rooftop` |
| `default.jpg` | anything still empty, as a last resort | — |

`.jpg`, `.jpeg`, `.png`, `.webp` all work; slides are re-encoded to JPEG on the
way out. An empty file is ignored, an empty folder changes nothing, and no
picture is used twice in one carousel — the same image on two slides looks like
a bug, so the second one stays a gradient.

Which slides went unfilled is printed on every build (`nothing usable for
"<query>"`), and the build log is in the Actions run summary. That list is the
shopping list: those are the topics worth drawing.

## What the picture has to do

The slide is **1080 × 1350** (4:5 portrait) and the template lays a scrim over
it, so the picture is not seen whole:

- **Top 0–20%** — dimmed about half. The brand row sits here.
- **20–45%** — nearly clear. **This is the only part properly visible. Put the
  subject here.**
- **45–60%** — fades to black.
- **Bottom 60–100%** — solid black. The Hindi text is drawn here. Anything in
  this band is invisible.

So: subject high and centred, empty space below it, and **no text in the
picture** — the text is drawn on top, and two lots of text on one slide looks
like a mistake.
