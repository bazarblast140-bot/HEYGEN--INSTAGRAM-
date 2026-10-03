// Fresh AI and market-news items for the optional carousel slots.
//
// The model only summarises what these feeds returned. If nothing is dated
// inside 48 hours, the slot is skipped — a generic carousel is not a fallback.

import { parseRss } from './news.js';
import { resolveProvider, callOpenAICompatible, shouldRetryProviderError } from '../script/providers.js';
import { MAX_MODEL_ATTEMPTS } from '../script/attempts.js';
import { readHistory, recordTopic } from '../script/topics.js';
import {
  LEDGER, normalizeSpec, validateShape, softProblems, checkSources, sourcedCarouselSchema,
} from './generate.js';
import { SYSTEM, buildSourcedPrompt } from './sourced-prompt.js';

export const MAX_SOURCE_AGE_MS = 48 * 60 * 60 * 1000;

export const AI_FEEDS = [
  { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', ai: true },
  { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/', ai: true },
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
  { name: 'Google AI', url: 'https://blog.google/technology/ai/rss/' },
];

export const NEWS_FEEDS = [
  { name: 'Economic Times', url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms' },
  { name: 'Moneycontrol', url: 'https://www.moneycontrol.com/rss/MCtopnews.xml' },
  {
    name: 'Reuters',
    url: 'https://news.google.com/rss/search?q=site:reuters.com+(India+OR+Nifty+OR+Sensex)+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
  },
  {
    name: 'PTI',
    url: 'https://news.google.com/rss/search?q=%22Press+Trust+of+India%22+(market+OR+RBI+OR+SEBI)+when:2d&hl=en-IN&gl=IN&ceid=IN:en',
  },
];

const AI_WORD = /\b(ai|artificial intelligence|openai|anthropic|gemini|chatgpt|claude|llm|gpu|nvidia|model)\b/i;

export function feedsFor(kind) {
  return kind === 'ai' ? AI_FEEDS : NEWS_FEEDS;
}

export function selectFresh(items, now = Date.now(), maxAgeMs = MAX_SOURCE_AGE_MS) {
  return (items || []).filter((item) => {
    if (!item?.title || !item?.site || !item?.date || !item?.at) return false;
    const age = now - item.at;
    return age >= 0 && age <= maxAgeMs;
  });
}

async function text(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'rajesh-technical-traders/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}`);
  return res.text();
}

export async function gatherSources({ kind, now = Date.now(), onNote } = {}) {
  const feeds = feedsFor(kind);
  const results = await Promise.allSettled(feeds.map(async (feed) => {
    const parsed = parseRss(await text(feed.url), { site: feed.name });
    return parsed
      .map((item) => ({ ...item, site: item.site || feed.name, from: feed.name }))
      .filter((item) => !feed.ai || AI_WORD.test(`${item.title} ${item.site}`));
  }));

  const items = [];
  results.forEach((result, i) => {
    if (result.status === 'rejected') onNote?.(`${feeds[i].name}: FAILED — ${String(result.reason?.message).slice(0, 80)}`);
    else items.push(...result.value);
  });

  const fresh = selectFresh(items, now);
  const seen = new Set();
  const unique = [];
  for (const item of fresh.sort((a, b) => b.at - a.at)) {
    const key = item.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  onNote?.(`${unique.length} fresh ${kind} item(s) inside 48h`);
  return unique;
}

/** Put the fetched outlet and date on the last fact slide and in the caption. */
export function applySourceCitation(spec, item) {
  const citation = `${item.site}, ${item.date}`;
  const slides = (spec.slides || []).map((slide, index, all) => {
    const lastFact = index === all.length - 2 && !slide.cta;
    if (!lastFact) return slide;
    const source = String(slide.source || '');
    const named = source.toLowerCase().includes(String(item.site).toLowerCase());
    const dated = source.includes(item.date);
    if (named && dated) return slide;
    return { ...slide, source: citation };
  });
  let caption = String(spec.caption || '').trim();
  if (!caption.toLowerCase().includes(String(item.site).toLowerCase()) || !caption.includes(item.date)) {
    caption = `${caption}\n\nस्रोत: ${citation}`.trim();
  }
  return { ...spec, slides, caption, sourceCitation: citation };
}

export function categoryForKind(kind) {
  return kind === 'ai' ? 'ai-news' : 'latest-news';
}

export async function generateSourcedCarousel({
  date = new Date().toISOString().slice(0, 10),
  slot,
  kind = slot,
  now = Date.now(),
  stories,
  model,
  onAttempt,
  onReject,
  onNote,
  record = true,
} = {}) {
  const category = categoryForKind(kind);
  const found = selectFresh(stories || await gatherSources({ kind, now, onNote }), now);
  if (!found.length) {
    return {
      skipped: true,
      slot,
      category,
      reason: `no fresh verifiable ${kind} source inside 48 hours`,
    };
  }

  const provider = resolveProvider();
  if (!provider) throw new Error('No script model configured.');
  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  const recentTopics = await readHistory(LEDGER);
  const sites = new Set(found.map((item) => item.site.toLowerCase()));
  let lastProblems = [];
  let lastOutput = null;
  let lastUsed = chosenModel;

  const maxAttempts = MAX_MODEL_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let userPrompt = buildSourcedPrompt({ kind, stories: found, date, recentTopics });
    if (lastProblems.length) {
      userPrompt += `\n\nपिछली कोशिश ठुकरा दी गई:\n${lastProblems.map((p) => `- ${p}`).join('\n')}\nसिर्फ़ यही ठीक करके पूरा spec दोबारा भेजो. संख्या मत जोड़ो.`;
    }
    onAttempt?.(attempt, `${provider.name}/${chosenModel}`, category);
    try {
      const { output, model: used } = await callOpenAICompatible({
        provider: { ...provider, model: chosenModel },
        system: SYSTEM, user: userPrompt, schema: sourcedCarouselSchema(category),
      });
      lastOutput = output;
      lastUsed = used;
      const shaped = applySourceCitation(
        attempt === maxAttempts ? normalizeSpec(output, { sourced: true }) : output,
        found[0],
      );
      lastProblems = [
        ...validateShape(shaped, recentTopics),
        ...checkSources(shaped, sites),
        ...(attempt < maxAttempts ? softProblems(shaped, { stories: found }) : []),
      ];
      if (lastProblems.length) onReject?.(attempt, lastProblems);
      if (!lastProblems.length) {
        if (record) await recordTopic({ topic: shaped.topic, angle: category, date: `${date} ${slot}`, file: LEDGER });
        return {
          spec: shaped,
          provider: provider.name,
          model: used,
          attempts: attempt,
          category,
          slot,
          stories: found,
          verifiedSource: true,
          sourceFresh: true,
        };
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
    const salvaged = applySourceCitation(normalizeSpec(lastOutput, { sourced: true }), found[0]);
    const hard = [
      ...validateShape(salvaged, recentTopics).filter((p) => !p.includes('repeats')),
      ...checkSources(salvaged, sites),
    ];
    if (!hard.length) {
      if (record) await recordTopic({ topic: salvaged.topic, angle: category, date: `${date} ${slot}`, file: LEDGER });
      return {
        spec: salvaged,
        provider: provider.name,
        model: lastUsed,
          attempts: maxAttempts,
        category,
        slot,
        stories: found,
        verifiedSource: true,
        sourceFresh: true,
      };
    }
  }

  throw new Error(`Sourced carousel still invalid after ${maxAttempts} attempts: ${lastProblems.join('; ')}`);
}
