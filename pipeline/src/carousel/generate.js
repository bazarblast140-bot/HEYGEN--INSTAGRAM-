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

import { resolveProvider, callOpenAICompatible, shouldRetryProviderError, VENDORS } from '../script/providers.js';
import { MAX_MODEL_ATTEMPTS } from '../script/attempts.js';
import { readHistory, findRepeat, recordTopic, readUsedStories, recordStories } from '../script/topics.js';
import { categoryFor, slotFor, SLIDES, FINANCE } from './categories.js';
import { fetchStories, storyKey } from './news.js';
import { checkEcho } from './echo.js';
import { softQualityProblems, hardQualityProblems } from './quality.js';
import { SYSTEM as NEWS_SYSTEM, buildUserPrompt as buildNewsPrompt } from './news-prompt.js';
import { SYSTEM, buildUserPrompt } from './prompt.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LEDGER = path.resolve(HERE, '..', '..', 'carousel-history.json');

// Structured chart inputs. The model names the numbers it assumes; calc.js
// computes every figure from them. Free-form so a slightly different key set
// is reported by computeCalc ("emi needs rate") instead of failing the schema.
const Calc = z.object({ type: z.string() }).passthrough();

const Slide = z.object({
  band: z.enum(['center', 'bottom']),
  headline: z.string(),
  subline: z.string().nullable(),
  source: z.string().nullable(),
  cta: z.boolean(),
  query: z.string().nullable().optional(),
  person: z.string().nullable().optional(),
  calc: Calc.nullable().optional(),
});

export const CarouselSpec = z.object({
  topic: z.string(),
  category: z.string(),
  slides: z.array(Slide),
  caption: z.string(),
  hashtags: z.array(z.string()),
  // Finance: the one worked example every slide is built on (example.js).
  example: Calc.nullable().optional(),
  // Cover photo request (cover-photo.js): { queries, mustHave, avoid }.
  coverPhoto: z.object({}).passthrough().nullable().optional(),
});

const WRAPPERS = ['carousel', 'spec', 'data', 'result', 'output', 'post', 'json', 'response'];

const FALLBACK_HASHTAGS = {
  'ai-news': ['#nifty50', '#banknifty', '#ai'],
  'latest-news': ['#nifty50', '#sensex', '#intraday'],
};

function asText(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join('\n');
  return '';
}

/** Plain English search words. Devanagari and empty values become ''. */
export function englishQuery(value) {
  return asText(value)
    .replace(/[^\x20-\x7E]/g, ' ')
    .split(/\s+/)
    .filter((word) => /[A-Za-z]/.test(word))
    .slice(0, 8)
    .join(' ');
}

function unwrapCarousel(raw) {
  let node = raw;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) break;
    if (Array.isArray(node.slides) || Array.isArray(node.items) || Array.isArray(node.beats) || Array.isArray(node.cards)) break;
    const key = WRAPPERS.find((name) => node[name] && typeof node[name] === 'object' && !Array.isArray(node[name]));
    if (!key) break;
    node = node[key];
  }
  return node && typeof node === 'object' && !Array.isArray(node) ? node : {};
}

function slideList(src) {
  if (Array.isArray(src.slides)) return src.slides;
  if (Array.isArray(src.items)) return src.items;
  if (Array.isArray(src.beats)) return src.beats;
  if (Array.isArray(src.cards)) return src.cards;
  return [];
}

/**
 * DeepSeek often wraps the spec, renames fields, or leaves query/caption/hashtags
 * null. Repair that shape before Zod sees it so a usable draft is not rejected.
 */
export function normalizeCarouselDraft(raw, { category } = {}) {
  const src = unwrapCarousel(raw);
  const list = slideList(src);
  const slides = list.filter((slide) => slide && typeof slide === 'object' && !Array.isArray(slide)).map((slide, index, all) => {
    let headline = asText(slide.headline) || asText(slide.title) || asText(slide.heading) || asText(slide.name);
    let subline = asText(slide.subline ?? slide.body ?? slide.description ?? slide.caption) || null;
    const text = asText(slide.text);
    if (!headline && text) headline = text;
    else if (!subline && text) subline = text;
    const query = englishQuery(slide.query) || englishQuery(headline) || englishQuery(slide.title) || 'indian stock exchange';
    const isLast = index === all.length - 1 && all.length > 1;
    const band = slide.band === 'center' || slide.band === 'bottom'
      ? slide.band
      : (index === 0 ? 'center' : 'bottom');
    return {
      band,
      headline: headline || (index === 0 ? 'आज की ख़बर' : 'मुख्य बात'),
      subline,
      source: index === 0 ? null : (asText(slide.source) || null),
      cta: typeof slide.cta === 'boolean' ? slide.cta : isLast,
      query,
      person: englishQuery(slide.person) || null,
      calc: slide.calc && typeof slide.calc === 'object' && !Array.isArray(slide.calc) ? slide.calc : (slide.chart && typeof slide.chart === 'object' && !Array.isArray(slide.chart) ? slide.chart : null),
    };
  });

  const topic = asText(src.topic) || asText(src.title) || asText(src.subject) || slides[0]?.headline || 'आज का बाज़ार';
  const resolvedCategory = asText(src.category) || category || 'latest-news';
  const cited = category === 'ai-news' || category === 'latest-news' ? slides.map((slide) => slide.source).find(Boolean) : null;
  const caption = asText(src.caption)
    || [...slides.filter((slide) => !slide.cta).slice(0, 2).map((slide) => slide.headline), cited ? `स्रोत: ${cited}` : '']
      .filter(Boolean)
      .join('\n\n')
    || topic;
  let hashtags = [];
  if (Array.isArray(src.hashtags)) hashtags = src.hashtags.map(asText).filter(Boolean);
  else if (typeof src.hashtags === 'string') hashtags = src.hashtags.split(/[\s,]+/).map((tag) => tag.trim()).filter(Boolean);
  if (!hashtags.length) hashtags = FALLBACK_HASHTAGS[resolvedCategory] || FALLBACK_HASHTAGS['latest-news'];

  return {
    topic,
    category: resolvedCategory,
    slides,
    caption,
    hashtags: hashtags.slice(0, 5),
    coverPhoto: src.coverPhoto && typeof src.coverPhoto === 'object' && !Array.isArray(src.coverPhoto) ? src.coverPhoto : null,
  };
}

/** Schema for AI and news carousels: repair the draft, then apply CarouselSpec. */
export function sourcedCarouselSchema(category) {
  return z.preprocess((raw) => normalizeCarouselDraft(raw, { category }), CarouselSpec);
}

/**
 * Force a valid 10-slide shape the renderer and Instagram path can accept.
 * Models sometimes return two covers or forget cta on the last slide.
 * Repairing is better than burning the day.
 */
export function normalizeSpec(spec, { sourced = false } = {}) {
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
      query: englishQuery(last.headline) || 'indian stock exchange',
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
      // Finance slides never get a source label invented for them. The only
      // line under a calculation is the calculation note, written by code
      // (calc.js) at build time. AI/news keep the outlet they cite.
      if (!sourced) source = null;
    }

    return {
      ...s,
      band,
      cta,
      source,
      headline,
      subline,
      query: englishQuery(s.query) || englishQuery(headline) || 'indian stock exchange',
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

/** Finance: "compare" carries the model's own values, so it is rationed. */
export function compareProblems(spec) {
  if (!FINANCE.includes(spec?.category)) return [];
  const n = (spec.slides || []).filter((s) => String(s?.calc?.type || '').toLowerCase() === 'compare').length;
  return n > 2 ? [`${n} slides use "compare" — at most 2; use emi / sip / cagr / operating_leverage / margin / change so the code computes the result`] : [];
}

export function softProblems(spec, { stories = null } = {}) {
  return [
    ...compareProblems(spec),
    ...checkEcho(spec), ...slideTextProblems(spec),
    // Hindi, sourced numbers, leaked labels, empty panels — sent back to the
    // model inside the same attempt cap; the final gate is in build-carousel.
    ...softQualityProblems(spec, { stories }),
  ];
}

/**
 * Keep the attempt the final gate likes best. The last attempt skips the soft
 * checks, so it can be worse than an earlier one (attempt 2 with only an echo
 * complaint, attempt 3 with a wrong figure). No extra model call: this only
 * chooses among replies already paid for.
 */
export function betterCandidate(best, candidate) {
  if (candidate.shape.length) return best;
  if (!best) return candidate;
  return candidate.gate.length <= best.gate.length ? candidate : best;
}

export function candidateFor(spec, { recentTopics = [], stories = null, used, attempt, prepare = (s) => normalizeSpec(s) } = {}) {
  const ready = prepare(spec);
  return {
    spec: ready,
    used,
    attempt,
    shape: validateShape(ready, recentTopics).filter((p) => !p.includes('repeats')),
    gate: hardQualityProblems(ready, { stories, caption: ready.caption }),
  };
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
    const finance = FINANCE.includes(spec.category);
    if (factSlide && !finance && !String(slide.source || '').trim()) {
      problems.push(`slide ${n} states a fact with no source`);
    }
    if (factSlide && finance && !slide.calc) {
      problems.push(`slide ${n} has no calc — every content slide needs structured chart inputs`);
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
  onNote,
  record = true,
  headlines = [],
  maxAttempts: attemptCap = MAX_MODEL_ATTEMPTS,
  feedback = [],
  previousExample = null,
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

  // `feedback` = problems left after an earlier build's number sanitizer (the
  // one in-build retry); `previousExample` = that build's worked example, so
  // its code-computed figures are listed in the prompt.
  let lastProblems = [...feedback];
  let lastOutput = null;
  let lastUsed = chosenModel;
  let best = null;

  const maxAttempts = Math.max(1, Math.min(MAX_MODEL_ATTEMPTS, Number(attemptCap) || MAX_MODEL_ATTEMPTS));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const example = lastOutput?.example || previousExample || null;
    let userPrompt = buildUserPrompt({ category, date, recentTopics, headlines, example });
    if (lastProblems.length) {
      userPrompt += `\n\nपिछली कोशिश ठुकरा दी गई:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nसिर्फ़ यही ठीक करके पूरा spec दोबारा भेजो.\nज़रूरी: ठीक ${SLIDES} slides, सिर्फ़ slide 1 band "center", बाकी "bottom", आख़िरी slide cta true, हर content slide (2–9) पर valid "calc", source null, और text की हर संख्या calc से निकलनी चाहिए.`;
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
      const shaped = attempt === maxAttempts ? normalizeSpec(output) : output;
      lastProblems = [
        ...validateShape(shaped, recentTopics),
        ...(attempt < maxAttempts ? softProblems(shaped) : []),
      ];
      const candidate = candidateFor(output, { recentTopics, used, attempt });
      const previous = best;
      best = betterCandidate(best, candidate);
      if (lastProblems.length) onReject?.(attempt, lastProblems);
      if (!lastProblems.length) {
        // An earlier reply that passes the final gate beats this one if this one does not.
        const pick = candidate.gate.length && previous && previous.gate.length < candidate.gate.length
          ? previous : { ...candidate, spec: shaped };
        if (pick === previous) onNote?.(`using attempt ${pick.attempt}: it passes more of the final gate than attempt ${attempt}`);
        if (record) await recordTopic({ topic: pick.spec.topic, angle: pick.spec.category, date: `${date} ${slot}`, file: LEDGER });
        return { spec: pick.spec, provider: provider.name, model: pick.used, attempts: attempt, category, slot };
      }
    } catch (err) {
      console.log(`  attempt ${attempt} failed: ${err.message}`);
      if (!shouldRetryProviderError(err)) throw err;
      if (!err.schemaIssues || attempt === maxAttempts) {
        // Last-chance: if we have any prior output, normalize and try to ship it.
        if (lastOutput && attempt === maxAttempts) break;
        throw err;
      }
      lastProblems = err.schemaIssues;
      onReject?.(attempt, lastProblems);
    }
  }

  // Final salvage: the attempt the final gate likes best (or the last output),
  // normalized, with soft/repeat-only blocks dropped.
  if (best && !best.shape.length) {
    onNote?.(`using attempt ${best.attempt} (${best.gate.length} gate problem(s))`);
    if (record) await recordTopic({ topic: best.spec.topic, angle: best.spec.category, date: `${date} ${slot}`, file: LEDGER });
    return { spec: best.spec, provider: provider.name, model: best.used, attempts: maxAttempts, category, slot };
  }
  if (lastOutput) {
    const salvaged = normalizeSpec(lastOutput);
    const hard = validateShape(salvaged, recentTopics).filter((p) => !p.includes('repeats'));
    if (!hard.length) {
      if (record) await recordTopic({ topic: salvaged.topic, angle: salvaged.category, date: `${date} ${slot}`, file: LEDGER });
      return { spec: salvaged, provider: provider.name, model: lastUsed, attempts: maxAttempts, category, slot };
    }
  }

  throw new Error(`Carousel spec still invalid after ${maxAttempts} attempts: ${lastProblems.join('; ')}`);
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

  const maxAttempts = MAX_MODEL_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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

      const shaped = attempt === maxAttempts ? normalizeSpec(output) : output;
      lastProblems = [
        ...validateShape(shaped, recentTopics),
        ...checkSources(shaped, sites),
        ...(attempt < maxAttempts ? softProblems(shaped) : []),
      ];
      if (lastProblems.length) onReject?.(attempt, lastProblems);
      if (!lastProblems.length) {
        await recordTopic({ topic: shaped.topic, angle: 'technology', date: `${date} midday`, file: LEDGER });
        await recordStories({ keys: found.map(storyKey), date, file: LEDGER });
        return { spec: shaped, provider: provider.name, model: used, attempts: attempt, category: 'technology', slot: 'midday', stories: found };
      }
    } catch (err) {
      if (!shouldRetryProviderError(err)) throw err;
      if (!err.schemaIssues || attempt === maxAttempts) {
        if (lastOutput && attempt === maxAttempts) break;
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
      return { spec: salvaged, provider: provider.name, model: lastUsed, attempts: maxAttempts, category: 'technology', slot: 'midday', stories: found };
    }
  }

  throw new Error(`News carousel still invalid after ${maxAttempts} attempts: ${lastProblems.join('; ')}`);
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
