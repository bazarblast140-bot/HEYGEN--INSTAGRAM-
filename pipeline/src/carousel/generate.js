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
import { fetchStories } from './news.js';
import { SYSTEM as NEWS_SYSTEM, buildUserPrompt as buildNewsPrompt } from './news-prompt.js';
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
    // A three-line subline is trimmed to two in build-carousel.js rather than
    // rejected, for the same reason.
    if (!/^[\x20-\x7E]+$/.test(String(slide.query || ''))) {
      problems.push(`slide ${n} query must be plain English — Pexels does not index Devanagari`);
    }
  });

  // Nothing about the caption is fatal any more, and two lost posts is why.
  //
  // First it was hashtags in the caption; the day after, a first line of 193
  // characters. Both are real faults, both are cosmetic, and both are repaired
  // in build-carousel.js -- but as rejections they burned all three attempts
  // and --require-generated turned that into no post at all. The prompt still
  // asks for a short first line and no tag row; asking is the right weight for
  // something the build can finish on its own.
  //
  // What stays fatal is what cannot be repaired without inventing something: a
  // missing source, a repeated topic, a broken word, the wrong slide shape.

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


/**
 * The midday technology post, built on stories fetched today.
 *
 * Same provider, same retry loop, same ledger. What is different is where the
 * facts come from and one extra check: every source a slide names must be a
 * site that appeared in the fetched list. That check is the whole defence
 * against the failure this post exists to avoid -- a model filling a gap with a
 * remembered headline. The instruction not to invent is a request; a rejected
 * spec is a rule.
 */
export async function generateNewsCarousel({
  date = new Date().toISOString().slice(0, 10),
  model,
  onAttempt,
  onNote,
  stories,
} = {}) {
  const provider = resolveProvider();
  if (!provider) throw new Error('No script model configured.');

  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  const found = stories || await fetchStories({ onNote });
  if (found.length < 3) {
    throw new Error(`only ${found.length} usable stories today — not enough for a carousel`);
  }

  const sites = new Set(found.map((s) => s.site.toLowerCase()));
  const recentTopics = await readHistory(LEDGER);

  let lastProblems = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let userPrompt = buildNewsPrompt({ stories: found, date, recentTopics });
    if (lastProblems.length) {
      userPrompt += `\n\nपिछली कोशिश ठुकरा दी गई:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nसिर्फ़ यही ठीक करके पूरा spec दोबारा भेजो.`;
    }

    onAttempt?.(attempt, `${provider.name}/${chosenModel}`, 'technology');

    try {
      const { output, model: used } = await callOpenAICompatible({
        provider: { ...provider, model: chosenModel },
        system: NEWS_SYSTEM, user: userPrompt, schema: CarouselSpec,
      });

      lastProblems = [...validateShape(output, recentTopics), ...checkSources(output, sites)];
      if (!lastProblems.length) {
        await recordTopic({ topic: output.topic, angle: 'technology', date: `${date} midday`, file: LEDGER });
        return { spec: output, provider: provider.name, model: used, attempts: attempt, category: 'technology', slot: 'midday', stories: found };
      }
    } catch (err) {
      if (!err.schemaIssues || attempt === 3) throw err;
      lastProblems = err.schemaIssues;
    }
  }

  throw new Error(`News carousel still invalid after 3 attempts: ${lastProblems.join('; ')}`);
}

/** Every cited site must be one that was actually handed to the model. */
export function checkSources(spec, sites) {
  const problems = [];
  (spec.slides || []).forEach((slide, i) => {
    if (slide.band === 'center' || slide.cta) return;
    const cited = String(slide.source || '').toLowerCase();
    if (!cited) return;                       // validateShape already says so
    const known = [...sites].some((site) => cited.includes(site) || site.includes(cited.replace(/\s+/g, '')));
    if (!known) {
      problems.push(`slide ${i + 1} cites "${slide.source}", which is not one of today's stories — use a site from the list`);
    }
  });
  return problems;
}
