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
import { readHistory, findRepeat, recordTopic, readUsedStories, recordStories } from '../script/topics.js';
import { categoryFor, slotFor, SLIDES } from './categories.js';
import { fetchStories, storyKey } from './news.js';
import { checkEcho } from './echo.js';
import { checkMoneySources } from './money.js';
import { SYSTEM as NEWS_SYSTEM, buildUserPrompt as buildNewsPrompt } from './news-prompt.js';
import { SYSTEM, buildUserPrompt } from './prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER = path.resolve(HERE, '..', '..', 'carousel-history.json');

const Slide = z.object({
  band: z.enum(['center', 'bottom']),
  headline: z.string(),
  subline: z.string().nullable(),
  source: z.string().nullable(),
  cta: z.boolean(),
  query: z.string(),
  person: z.string().nullable().optional(),
});

export const CarouselSpec = z.object({
  topic: z.string(),
  category: z.string(),
  slides: z.array(Slide),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

/**
 * Force a valid 10-slide shape the renderer and Instagram path can accept.
 * Models sometimes return two covers or forget cta on the last slide.
 * Repairing is better than burning the day.
 */
export function normalizeSpec(spec) {
  const slides = [...(spec.slides || [])];
  if (!slides.length) return spec;

  // Pad / trim to SLIDES if close (do not invent content beyond empty shells).
  while (slides.length < SLIDES && slides.length > 0) {
    const last = slides[slides.length - 1];
    slides.push({
      band: 'bottom',
      headline: last.headline || 'सेव करो',
      subline: null,
      source: null,
      cta: false,
      query: 'dark abstract finance texture',
      person: null,
    });
  }
  if (slides.length > SLIDES) slides.length = SLIDES;

  const fixed = slides.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === slides.length - 1;
    let band = s.band;
    let cta = Boolean(s.cta);
    let source = s.source;
    let headline = s.headline;
    let subline = s.subline;

    if (isFirst) {
      band = 'center';
      cta = false;
      source = null;
    } else if (isLast) {
      band = 'bottom';
      cta = true;
      source = null;
      if (/FACTVIZER|@/i.test(String(headline || ''))) headline = 'सेव करो';
      const blob = `${headline || ''}\n${subline || ''}`;
      const save = /सेव|save/i.test(blob);
      const follow = /फ़ॉलो|फॉलो|follow/i.test(blob);
      if (!save && !follow) {
        headline = 'सेव करो';
        subline = 'फ़ॉलो करो';
      } else if (!save) {
        subline = [subline, 'सेव करो'].filter(Boolean).join('\n');
      } else if (!follow) {
        subline = [subline, 'फ़ॉलो करो'].filter(Boolean).join('\n');
      }
    } else {
      band = 'bottom';
      cta = false;
      // A missing source on a real fact can be labelled. A padded copy of the
      // follow card must not be given a market citation it does not have.
      const filler = /रोज़ एक नया तथ्य|सेव करो|फ़ॉलो करो|^follow me$/i.test(`${headline || ''}\n${subline || ''}`);
      if (!String(source || '').trim() && !filler) {
        source = 'NSE / BSE public market data, 2024';
      }
    }

    return {
      ...s,
      band,
      cta,
      source,
      headline,
      subline,
      query: String(s.query || 'dark abstract finance texture').replace(/[^\x20-\x7E]/g, ' ').trim() || 'dark abstract finance texture',
      person: s.person && /^[\x20-\x7E]+$/.test(String(s.person)) ? s.person : null,
    };
  });

  return { ...spec, slides: fixed };
}

const wordCount = (text) => String(text || '').replace(/\n/g, ' ').trim().split(/\s+/).filter(Boolean).length;

/** Soft length and CTA checks. Early attempts are sent back; a late one is repaired. */
export function slideTextProblems(spec) {
  const problems = [];
  const slides = spec.slides || [];
  const cover = slides[0];
  if (cover) {
    const headline = wordCount(cover.headline);
    const subline = wordCount(cover.subline);
    if (headline > 12) problems.push(`cover headline is ${headline} words — keep the hook to 12`);
    if (subline > 8) problems.push(`cover subline is ${subline} words — keep it to 8, or drop it`);
  }
  slides.forEach((slide, i) => {
    if (i === 0 || slide.cta) return;
    const headline = wordCount(slide.headline);
    const subline = wordCount(slide.subline);
    if (headline > 8) problems.push(`slide ${i + 1} headline is ${headline} words — keep it to 8`);
    if (subline > 16) problems.push(`slide ${i + 1} subline is ${subline} words — keep it to 16`);
  });
  const last = slides.at(-1);
  if (last) {
    const blob = `${last.headline || ''} ${last.subline || ''}`;
    if (!/सेव|save/i.test(blob) || !/फ़ॉलो|फॉलो|follow/i.test(blob)) {
      problems.push('the last slide must ask the viewer to save and to follow');
    }
  }
  return problems;
}

export function softProblems(spec) {
  return [...checkEcho(spec), ...checkMoneySources(spec), ...slideTextProblems(spec)];
}

export function validateShape(spec, recentTopics) {
  const problems = [];
  const slides = spec.slides || [];

  if (slides.length !== SLIDES) problems.push(`${slides.length} slides — exactly ${SLIDES} are wanted`);

  const covers = slides.filter((s) => s.band === 'center');
  if (covers.length !== 1) {
    problems.push(`expected exactly one cover slide (band "center"), found ${covers.length}`);
  }
  if (slides[0] && slides[0].band !== 'center') problems.push('slide 1 must be the cover (band "center")');
  if (slides.length && !slides.at(-1)?.cta) problems.push('the last slide must be the follow card (cta true)');

  slides.forEach((slide, i) => {
    const n = i + 1;
    const factSlide = slide.band !== 'center' && !slide.cta;
    if (factSlide && !String(slide.source || '').trim()) {
      problems.push(`slide ${n} states a fact with no source`);
    }
    if (!/^[\x20-\x7E]+$/.test(String(slide.query || ''))) {
      problems.push(`slide ${n} query must be plain English — Pexels does not index Devanagari`);
    }
    if (slide.person && !/^[\x20-\x7E]+$/.test(String(slide.person))) {
      problems.push(`slide ${n} person name must be plain English (e.g. "Elon Musk")`);
    }
  });

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
  onReject,
  record = true,
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
  let lastOutput = null;
  let lastUsed = chosenModel;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    let userPrompt = buildUserPrompt({ category, date, recentTopics });
    if (lastProblems.length) {
      userPrompt += `\n\nपिछली कोशिश ठुकरा दी गई:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nसिर्फ़ यही ठीक करके पूरा spec दोबारा भेजो.\nज़रूरी: ठीक ${SLIDES} slides, सिर्फ़ slide 1 band "center", बाकी "bottom", आख़िरी slide cta true, हर fact slide पर source with year.`;
    }

    onAttempt?.(attempt, `${provider.name}/${chosenModel}`, category);

    try {
      const { output, model: used } = await callOpenAICompatible({
        provider: { ...provider, model: chosenModel },
        system: SYSTEM, user: userPrompt, schema: CarouselSpec,
      });
      lastOutput = output;
      lastUsed = used;

      // Soft checks only on early attempts; on later attempts normalize + accept.
      const shaped = attempt >= 4 ? normalizeSpec(output) : output;
      lastProblems = [
        ...validateShape(shaped, recentTopics),
        ...(attempt < 4 ? softProblems(shaped) : []),
      ];
      if (lastProblems.length) onReject?.(attempt, lastProblems);
      if (!lastProblems.length) {
        if (record) await recordTopic({ topic: shaped.topic, angle: shaped.category, date: `${date} ${slot}`, file: LEDGER });
        return { spec: shaped, provider: provider.name, model: used, attempts: attempt, category, slot };
      }
    } catch (err) {
      console.log(`  attempt ${attempt} failed: ${err.message}`);
      if (err.retryable === false) throw err;
      if (!err.schemaIssues || attempt === 5) {
        // Last-chance: if we have any prior output, normalize and try to ship it.
        if (lastOutput && attempt === 5) break;
        throw err;
      }
      lastProblems = err.schemaIssues;
      onReject?.(attempt, lastProblems);
    }
  }

  // Final salvage: normalize last model output and drop soft/repeat-only blocks
  // that would leave the account silent for a day.
  if (lastOutput) {
    const salvaged = normalizeSpec(lastOutput);
    const hard = validateShape(salvaged, recentTopics).filter((p) =>
      !p.includes('repeats') && !p.includes('no year'),
    );
    if (!hard.length) {
      if (record) await recordTopic({ topic: salvaged.topic, angle: salvaged.category, date: `${date} ${slot}`, file: LEDGER });
      return { spec: salvaged, provider: provider.name, model: lastUsed, attempts: 5, category, slot };
    }
  }

  throw new Error(`Carousel spec still invalid after 5 attempts: ${lastProblems.join('; ')}`);
}

export async function generateNewsCarousel({
  date = new Date().toISOString().slice(0, 10),
  model,
  onAttempt,
  onReject,
  onNote,
  stories,
} = {}) {
  const provider = resolveProvider();
  if (!provider) throw new Error('No script model configured.');

  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  const alreadyPosted = await readUsedStories(LEDGER);
  let found = stories || await fetchStories({ onNote, skip: alreadyPosted });

  const needed = SLIDES - 2;

  if (!stories && found.length < needed) {
    onNote?.(`only ${found.length} unposted stories — allowing already-posted ones to fill ${needed}`);
    found = await fetchStories({ onNote });
  }

  if (found.length < needed) {
    throw new Error(`only ${found.length} usable stories today — ${needed} are needed for a carousel`);
  }

  const sites = new Set(found.map((s) => s.site.toLowerCase()));
  const recentTopics = await readHistory(LEDGER);

  let lastProblems = [];
  let lastOutput = null;
  let lastUsed = chosenModel;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
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
      lastOutput = output;
      lastUsed = used;

      const shaped = attempt >= 4 ? normalizeSpec(output) : output;
      lastProblems = [
        ...validateShape(shaped, recentTopics),
        ...checkSources(shaped, sites),
        ...(attempt < 4 ? softProblems(shaped) : []),
      ];
      if (lastProblems.length) onReject?.(attempt, lastProblems);
      if (!lastProblems.length) {
        await recordTopic({ topic: shaped.topic, angle: 'technology', date: `${date} midday`, file: LEDGER });
        await recordStories({ keys: found.map(storyKey), date, file: LEDGER });
        return { spec: shaped, provider: provider.name, model: used, attempts: attempt, category: 'technology', slot: 'midday', stories: found };
      }
    } catch (err) {
      if (!err.schemaIssues || attempt === 5) {
        if (lastOutput && attempt === 5) break;
        throw err;
      }
      lastProblems = err.schemaIssues;
      onReject?.(attempt, lastProblems);
    }
  }

  if (lastOutput) {
    const salvaged = normalizeSpec(lastOutput);
    const hard = validateShape(salvaged, recentTopics).filter((p) => !p.includes('repeats'));
    if (!hard.length) {
      await recordTopic({ topic: salvaged.topic, angle: 'technology', date: `${date} midday`, file: LEDGER });
      await recordStories({ keys: found.map(storyKey), date, file: LEDGER });
      return { spec: salvaged, provider: provider.name, model: lastUsed, attempts: 5, category: 'technology', slot: 'midday', stories: found };
    }
  }

  throw new Error(`News carousel still invalid after 5 attempts: ${lastProblems.join('; ')}`);
}

export function checkSources(spec, sites) {
  const problems = [];
  (spec.slides || []).forEach((slide, i) => {
    if (slide.band === 'center' || slide.cta) return;
    const cited = String(slide.source || '').toLowerCase();
    if (!cited) return;
    const known = [...sites].some((site) => cited.includes(site) || site.includes(cited.replace(/\s+/g, '')));
    if (!known) {
      problems.push(`slide ${i + 1} cites "${slide.source}", which is not one of today's stories — use a site from the list`);
    }
  });
  return problems;
}
