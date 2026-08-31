// Write one day's carousel spec with the configured model.
//
// The shape of this mirrors the reel's generator deliberately — same provider
// resolution, same three-attempt loop, same "tell it exactly what was wrong and
// ask again" retry. What differs is the last check.
//
// The topic ledger is consulted AFTER the answer comes back, not only before it.
// The prompt carries the recent list as a request, and a request is something a
// model can politely ignore; a rejected spec is a rule it cannot. Two carousels
// a week apart about "how fast light travels" would each pass their own schema
// and still be the same post.
//
// The carousel keeps its own ledger. Sharing the reel's would block a fact about
// interest rates because a market reel once covered them, which is a different
// account talking to different people.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { resolveProvider, callOpenAICompatible, VENDORS } from '../script/providers.js';
import { readHistory, findRepeat, recordTopic } from '../script/topics.js';
import { categoryFor, slotFor } from './categories.js';
import { SYSTEM, buildUserPrompt } from './prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER = path.resolve(HERE, '..', '..', 'carousel-history.json');

const Slide = z.object({
  band: z.enum(['center', 'bottom']),
  headline: z.string(),
  subline: z.string().nullable(),
  // Required on a slide that states a figure; the validator in build-carousel.js
  // is what actually enforces that, because it knows which slides those are.
  source: z.string().nullable(),
  cta: z.boolean(),
  query: z.string(),
});

export const CarouselSpec = z.object({
  topic: z.string(),
  category: z.string(),
  slides: z.array(Slide),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

/**
 * Checks the model cannot do for itself: the ones that need the ledger, or that
 * need to count. The schema already guarantees the fields exist.
 */
function validateShape(spec, recentTopics) {
  const problems = [];
  const slides = spec.slides || [];

  if (slides.length !== 6) problems.push(`${slides.length} slides — exactly 6 are wanted`);
  if (slides[0] && slides[0].band !== 'center') problems.push('slide 1 must be the cover (band "center")');
  if (slides.length && !slides.at(-1)?.cta) problems.push('the last slide must be the follow card (cta true)');

  slides.forEach((slide, i) => {
    const n = i + 1;
    const factSlide = slide.band !== 'center' && !slide.cta;
    if (factSlide && !String(slide.source || '').trim()) {
      problems.push(`slide ${n} states a fact with no source`);
    }
    // Devanagari sets tall, and a third line overflows the band. The renderer
    // shrinks to fit, so a three-line subline comes out small rather than
    // clipped — which is worse, because nothing looks broken.
    const lines = String(slide.subline || '').split('\n').filter(Boolean).length;
    if (factSlide && lines > 2) problems.push(`slide ${n} subline has ${lines} lines — two at most`);
    if (!/^[\x20-\x7E]+$/.test(String(slide.query || ''))) {
      problems.push(`slide ${n} query must be plain English — Pexels does not index Devanagari`);
    }
  });

  // Instagram's search reads the caption, and it reads the start of it hardest:
  // the first line is what shows above "more" and what a search result displays.
  // A caption that opens with a preamble spends that line on nothing.
  const firstLine = String(spec.caption || '').split('\n')[0].trim();
  if (!firstLine) problems.push('caption is empty — the first line is what search and the feed show');
  else if (firstLine.length > 125) problems.push(`caption's first line is ${firstLine.length} characters — Instagram cuts it at about 125`);

  // Hashtags in the caption are NOT rejected, and that is deliberate.
  //
  // They were, for one morning, and the post never went out: the model wrote a
  // tag row in its caption on all three attempts, every attempt was rejected,
  // and --require-generated turned that into a skipped day. The duplicate is
  // real but composeCaption() already lifts the row out and merges it, so the
  // check was refusing work the pipeline knows how to finish.
  //
  // A validator earns a veto only over what cannot be repaired here: a missing
  // source, a repeated topic, a broken word. Anything the build can fix, the
  // build fixes.

  // "इस कारousel में" went out on a live post: half Devanagari, half Latin,
  // inside one word. A reader sees a typo, not a loanword.
  const mixed = String(spec.caption || '').match(/[\u0900-\u097F]+[A-Za-z]+|[A-Za-z]+[\u0900-\u097F]+/g);
  if (mixed) problems.push(`half-Hindi half-English words: ${[...new Set(mixed)].join(', ')}`);

  const tags = spec.hashtags || [];
  if (tags.length < 8 || tags.length > 15) problems.push(`${tags.length} hashtags — 8 to 15`);
  if (new Set(tags).size !== tags.length) problems.push('hashtags repeat');
  const malformed = tags.filter((t) => !/^#[^\s#]+$/.test(String(t)));
  if (malformed.length) problems.push(`malformed hashtags: ${malformed.join(' ')}`);
  // Half and half. Hindi tags reach the audience that reads the slides; English
  // tags are where the subject itself is searched, and a Devanagari-only post is
  // invisible to anyone searching "venus" or "space facts".
  const english = tags.filter((t) => /^#[\x20-\x7E]+$/.test(String(t)));
  if (english.length < 3) problems.push(`only ${english.length} English hashtags — at least 3, the subject is searched in English`);
  if (tags.length - english.length < 3) problems.push(`only ${tags.length - english.length} Hindi hashtags — at least 3`);

  const repeat = findRepeat(spec.topic, recentTopics);
  if (repeat) problems.push(`topic repeats ${repeat.date}: "${repeat.topic}" — pick a different subject`);

  return problems;
}

export async function generateCarousel({
  date = new Date().toISOString().slice(0, 10),
  slot = slotFor(new Date()),
  category = categoryFor(date, slot),
  model,
  onAttempt,
} = {}) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'No script model configured. Set ANTHROPIC_API_KEY, or one of '
      + `${Object.values(VENDORS).map((v) => v.key).join(' / ')}, or SCRIPT_BASE_URL + SCRIPT_API_KEY.`,
    );
  }

  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  const recentTopics = await readHistory(LEDGER);

  let lastProblems = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let userPrompt = buildUserPrompt({ category, date, recentTopics });
    if (lastProblems.length) {
      userPrompt += `\n\nपिछली कोशिश ठुकरा दी गई:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nसिर्फ़ यही ठीक करके पूरा spec दोबारा भेजो.`;
    }

    onAttempt?.(attempt, `${provider.name}/${chosenModel}`, category);

    try {
      const { output, model: used } = await callOpenAICompatible({
        provider: { ...provider, model: chosenModel },
        system: SYSTEM, user: userPrompt, schema: CarouselSpec,
      });

      lastProblems = validateShape(output, recentTopics);
      if (!lastProblems.length) {
        // Recorded only once accepted, so a rejected draft does not burn a
        // subject that never actually went out.
        await recordTopic({ topic: output.topic, angle: output.category, date: `${date} ${slot}`, file: LEDGER });
        return { spec: output, provider: provider.name, model: used, attempts: attempt, category, slot };
      }
    } catch (err) {
      if (!err.schemaIssues || attempt === 3) throw err;
      lastProblems = err.schemaIssues;
    }
  }

  throw new Error(`Carousel spec still invalid after 3 attempts: ${lastProblems.join('; ')}`);
}
