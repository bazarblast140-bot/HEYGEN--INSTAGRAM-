// Which slides become the story, and what they say instead of nothing.
//
// The first story this account posted was the cover slide alone: a question,
// no answer, no sign that anything followed it. There is nothing there to stop
// a thumb. A story competes with a hundred other stories and loses in about a
// second unless it either pays out immediately or shows that a payout exists.
//
// So two frames. The cover, which is the hook, marked with how many slides are
// waiting; and the single most concrete fact in the post, so a viewer who never
// opens the carousel still got something and knows where more is.
//
// Instagram's API cannot attach a link, poll or any other sticker to a story
// published this way -- Meta documents that plainly -- so there is no tappable
// route from the story to the post. The only honest call to action is words,
// and words have to earn the tap by being specific.

const DIGITS = /[0-9०-९]/g;

/** How much of a number a line carries. Digits are the concrete part. */
function weight(text = '') {
  return (String(text).match(DIGITS) || []).length;
}

/**
 * The fact slide most worth showing on its own.
 *
 * Most concrete wins: "700 अरब डॉलर" says something standing alone, "यह भंडार
 * रुपये को गिरने से बचाता है" does not. Ties go to the earlier slide, which is
 * where the model puts its strongest material.
 */
export function bestFact(slides = []) {
  let best = null;
  slides.forEach((slide, i) => {
    if (i === 0 || slide.cta || !slide.subline) return;
    const score = weight(slide.subline) + weight(slide.headline);
    if (!best || score > best.score) best = { index: i, score };
  });
  return best?.index ?? null;
}

/**
 * The frames to render, in order, with their call to action written in.
 *
 * The call to action goes on `callout`, its own line. It must NOT overwrite the
 * footnote: by the time a spec reaches here the footnote holds the slide's
 * source, and putting the call to action there deleted the citation from a
 * money slide -- an unsourced claim about the RBI, which is the exact fault the
 * dated-source rule in money.js exists to prevent.
 */
export function storyFrames(spec, { handle } = {}) {
  const slides = spec?.slides || [];
  if (!slides.length) return [];

  const count = slides.length;
  const cta = handle ? `पूरी पोस्ट ${handle} पर` : 'पूरी पोस्ट प्रोफ़ाइल पर';

  const frames = [{ ...slides[0], callout: `${count} स्लाइड · ${cta}` }];

  const fact = bestFact(slides);
  if (fact !== null) frames.push({ ...slides[fact], callout: cta });

  return frames;
}
