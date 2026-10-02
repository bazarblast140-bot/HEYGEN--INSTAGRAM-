// Turn a day's market data into a reel spec.
//
// Structured outputs do the enforcement: the schema below is the contract, so a
// beat that is missing a caption or that invents a beat type fails at the API
// rather than three stages downstream in ffmpeg.

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { env } from '../../../src/config.js';
import { SYSTEM, buildUserPrompt } from './prompt.js';
import { resolveProvider, callOpenAICompatible, shouldRetryProviderError, VENDORS } from './providers.js';
import { readHistory, findRepeat, recordTopic } from './topics.js';
import { MAX_MODEL_ATTEMPTS } from './attempts.js';
import { FAMILY_NAMES } from './families.js';
import { shortenReelScript, spokenWordCount, wordCountProblem, retryNoteFor } from './length.js';

const Stat = z.object({
  value: z.string(),
  label: z.string(),
  direction: z.enum(['up', 'down', 'flat']),
});

const Card = z.object({
  chips: z.array(z.string()),
  headline: z.string(),
  power: z.string(),
  stat: Stat.nullable(),
  footnote: z.string(),
});

const Article = z.object({
  // Attribution is required, not optional. This scene quotes a source and must
  // never be mistaken for one — see article.html.
  source: z.string(),
  date: z.string(),
  headline: z.string(),
  body: z.array(z.string()),
  highlight: z.string(),
});

const Beat = z.object({
  type: z.enum(['hook', 'cutin', 'chart', 'card', 'stock', 'article']),
  seconds: z.number().nullable(),
  say: z.string(),
  caption: z.string(),
  power: z.string(),
  card: Card.nullable(),
  // Only a "stock" beat uses this: the search phrase sent to Pexels. Every other
  // beat leaves it null. The card stays optional on a stock beat too, because it
  // is what gets rendered if the footage search comes back empty.
  query: z.string().nullable(),
  // Only an "article" beat uses this.
  article: Article.nullable(),
});

const ReelSpec = z.object({
  topic: z.string(),
  // Chosen by the model, and it decides how the reel looks. See families.js.
  family: z.enum(['market', 'ai', 'fund', 'policy', 'commodity']),
  verdict: z.string(),
  segments: z.array(Beat),
  body: z.string(),
  caption: z.string(),
  hashtags: z.array(z.string()),
});

const BEAT_TYPES = new Set(['hook', 'cutin', 'chart', 'card', 'stock', 'article']);
const FAMILIES = new Set(['market', 'ai', 'fund', 'policy', 'commodity']);

function asString(value) {
  return value == null ? '' : String(value);
}

function asNullableString(value) {
  if (value == null || String(value).trim() === '') return null;
  return String(value);
}

function asNullableNumber(value) {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStat(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const direction = ['up', 'down', 'flat'].includes(stat.direction) ? stat.direction : 'flat';
  if (!asString(stat.value).trim() && !asString(stat.label).trim()) return null;
  return { value: asString(stat.value), label: asString(stat.label), direction };
}

function normalizeCard(beat) {
  const card = beat?.card;
  if (card && typeof card === 'object' && !Array.isArray(card)) {
    return {
      chips: Array.isArray(card.chips) ? card.chips.map(asString).filter((c) => c.trim()) : [],
      headline: asString(card.headline || beat.headline || beat.caption),
      power: asString(card.power || beat.power),
      stat: normalizeStat(card.stat),
      footnote: asString(card.footnote),
    };
  }
  // A chart draws itself. Every other beat needs a card, so a missing one is
  // built from the line the model did write.
  if (beat?.type === 'chart') return null;
  return {
    chips: [],
    headline: asString(beat?.headline || beat?.caption),
    power: asString(beat?.power),
    stat: null,
    footnote: '',
  };
}

function normalizeArticle(article, type) {
  if (type !== 'article' || !article || typeof article !== 'object' || Array.isArray(article)) return null;
  return {
    source: asString(article.source),
    date: asString(article.date),
    headline: asString(article.headline),
    body: Array.isArray(article.body) ? article.body.map(asString) : [],
    highlight: asString(article.highlight),
  };
}

/**
 * DeepSeek names the array `beats`, omits `body`, and leaves optional beat
 * fields out instead of sending null. The schema still wants one shape.
 */
export function normalizeReelDraft(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(src.segments) ? src.segments
    : Array.isArray(src.beats) ? src.beats
    : [];

  const segments = list.filter((beat) => beat && typeof beat === 'object').map((beat) => {
    const type = BEAT_TYPES.has(beat.type) ? beat.type : 'card';
    const query = type === 'stock'
      ? (asNullableString(beat.query) || 'stock market screen')
      : asNullableString(beat.query);
    return {
      type,
      seconds: asNullableNumber(beat.seconds),
      say: asString(beat.say),
      caption: asString(beat.caption),
      power: asString(beat.power),
      card: normalizeCard({ ...beat, type }),
      query,
      article: normalizeArticle(beat.article, type),
    };
  });

  const spoken = segments.map((s) => s.say.trim()).filter(Boolean).join(' ');
  const body = typeof src.body === 'string' && src.body.trim() ? src.body.trim() : spoken;
  const hashtags = Array.isArray(src.hashtags)
    ? src.hashtags.map(asString)
    : typeof src.hashtags === 'string'
      ? src.hashtags.split(/\s+/).filter(Boolean)
      : [];

  return {
    topic: asString(src.topic),
    family: FAMILIES.has(src.family) ? src.family : 'market',
    verdict: asString(src.verdict),
    segments,
    body,
    caption: asString(src.caption),
    hashtags,
  };
}

const ParsedReelSpec = z.preprocess(
  (value) => normalizeReelDraft(value),
  ReelSpec,
);

/** Accept the shapes DeepSeek actually returns, then validate the reel schema. */
export function parseReelDraft(raw) {
  return ParsedReelSpec.safeParse(raw);
}

export const MODEL = env('SCRIPT_MODEL') || 'claude-fable-5';

/**
 * Structural checks the schema cannot express. A spec that passes validation but
 * runs to fifty seconds, or has no presenter beat, is still not a reel — and
 * finding that out here costs one retry rather than a whole render.
 */
function validateShape(spec, recentTopics = []) {
  const problems = [];

  // The prompt asks for a new subject; this is what makes it a rule. A model
  // that has been handed similar numbers five days running will otherwise find
  // the same story in them five times.
  const repeat = findRepeat(spec.topic, recentTopics);
  if (repeat) {
    problems.push(
      `topic "${spec.topic}" repeats ${repeat.date}'s reel ("${repeat.topic}") — pick a different subject entirely`,
    );
  }
  // Runtime is set by how long the narration actually takes, so the check is on
  // the words rather than on numbers the model guessed.
  const lengthProblem = wordCountProblem(spokenWordCount(spec));
  if (lengthProblem) problems.push(lengthProblem);
  if (!spec.segments.some((s) => s.type === 'hook')) problems.push('no hook beat');

  const opener = spec.segments[0];
  const opening = `${opener?.say || ''} ${opener?.caption || ''}`;
  if (/namaste|main rajesh/i.test(opening)) {
    problems.push('the reel must not open with Namaste or "main Rajesh" — the first frame is a text hook');
  }
  if (!spec.segments.some((s) => s.type === 'chart')) problems.push('no chart beat');

  // The article beat only works if reaching the highlight is a journey.
  const articles = spec.segments.filter((s) => s.type === 'article');
  if (articles.length > 1) problems.push(`${articles.length} article beats; use at most one`);
  for (const [i, beat] of spec.segments.entries()) {
    if (beat.type !== 'article') continue;
    const a = beat.article;
    if (!a) { problems.push(`beat ${i}: an article beat needs an "article"`); continue; }
    if (!a.source?.trim()) problems.push(`beat ${i}: the article has no source to credit`);
    if ((a.body || []).length < 4) problems.push(`beat ${i}: the article needs at least 4 body lines to scroll through`);

    const at = (a.body || []).findIndex((line) =>
      String(line).toLowerCase().includes(String(a.highlight || '').toLowerCase()));
    if (!a.highlight?.trim() || at < 0) {
      problems.push(`beat ${i}: the highlight "${a.highlight}" does not appear in the body`);
    } else if (at < 2) {
      // A phrase in the first two paragraphs is already on screen, so the scroll
      // travels almost nothing and the shot reads as a still.
      problems.push(`beat ${i}: the highlight is in paragraph ${at + 1}; put it third or later so the scroll has somewhere to go`);
    }
  }

  // Two ways a card prints the same thing twice, both seen in a finished reel.
  for (const [i, beat] of spec.segments.entries()) {
    const power = String(beat.card?.power || '').trim().toLowerCase();
    const stat = String(beat.card?.stat?.value || '').trim().toLowerCase();
    if (power && power === stat) {
      problems.push(`beat ${i}: card.power and card.stat.value are both "${beat.card.power}"`);
    }
    const next = spec.segments[i + 1]?.card;
    if (beat.type === 'cutin' && beat.card && next
      && String(beat.card.headline || '').trim().toLowerCase()
         === String(next.headline || '').trim().toLowerCase()) {
      problems.push(`beat ${i}: the cut-in repeats the next beat's headline "${next.headline}"`);
    }
  }

  // Footage is what stops the reel being eight dark cards in a row, but a reel
  // that is mostly footage stops being about the numbers. One or two beats.
  const stock = spec.segments.filter((s) => s.type === 'stock');
  if (!stock.length) problems.push('no stock beat — at least one beat must be real footage, not a card');
  if (stock.length > 2) problems.push(`${stock.length} stock beats is too many; use one or two`);
  for (const beat of stock) {
    if (!beat.query?.trim()) problems.push('a stock beat has no "query" to search footage with');
    else if (beat.query.trim().split(/\s+/).length > 4) {
      // Pexels matches on plain visual nouns. "Indian retail investors reacting
      // to a mutual fund inflow record" returns nothing; "stock market screen"
      // returns a hundred usable clips.
      problems.push(`stock query "${beat.query}" is too specific — use 2 to 4 plain visual words`);
    }
  }

  for (const [i, beat] of spec.segments.entries()) {
    const where = `beat ${i} (${beat.type})`;
    const beatWords = String(beat.say || '').trim().split(/\s+/).filter(Boolean).length;
    if (beatWords > 26) problems.push(`${where}: ${beatWords} spoken words is too long for one shot`);
    if (!beat.say?.trim()) problems.push(`${where}: needs "say" — every beat is narrated`);
    if (beat.type !== 'chart' && !beat.card) problems.push(`${where}: needs a card`);
    if (beat.caption.split(/\s+/).length > 12) problems.push(`${where}: caption is over 12 words`);
  }

  return problems;
}

/** Same structural checks the generator retries on. Safe to call from tests. */
export function checkReelShape(spec, recentTopics = []) {
  return validateShape(spec, recentTopics);
}

/** A note, not a failure. Instagram still rejects only under 3s and over 90s. */
export function durationNote(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return null;
  if (n >= 20 && n <= 30) return null;
  return `${n}s is outside the 20–30 second target`;
}

async function callAnthropic({ system, user, model, effort }) {
  const client = new Anthropic();

  const response = await client.messages.parse({
    model,
    max_tokens: 16000,
    system,
    // Fable 5 thinks by default; effort is the depth control, and budget_tokens
    // and temperature are both rejected on this model.
    output_config: { effort, format: zodOutputFormat(ReelSpec) },
    // A policy decline would otherwise end the run with no brief at all.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: user }],
  });

  if (response.stop_reason === 'refusal') {
    throw new Error(`Script generation was declined (${response.stop_details?.category || 'no category'})`);
  }

  return { output: response.parsed_output, model };
}

export async function generateSpec({
  market,
  news,
  date = new Date().toISOString().slice(0, 10),
  model,
  effort = 'high',
  onAttempt,
  record = true,
}) {
  const provider = resolveProvider();
  if (!provider) {
    throw new Error(
      'No script model configured. Set DEEPSEEK_API_KEY. Optional fallbacks: ' +
      `ANTHROPIC_API_KEY, ${Object.values(VENDORS).map((v) => v.key).filter((k) => k !== 'DEEPSEEK_API_KEY').join(', ')}, or SCRIPT_BASE_URL + SCRIPT_API_KEY.`,
    );
  }

  const chosenModel = model || provider.model;
  if (!chosenModel) throw new Error(`${provider.name}: no model chosen. Set the SCRIPT_MODEL variable.`);

  const recentTopics = await readHistory();

  let lastProblems = [];
  // Schema slips from an empty body get more than one retry. An auth or
  // balance error will not change on the next call, so those stop at once.
  const maxAttempts = MAX_MODEL_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let userPrompt = buildUserPrompt({ market, news, date, recentTopics });

    // A second pass is given the specific complaints rather than being asked
    // again and hoped at.
    if (lastProblems.length) {
      userPrompt += `\n\n${retryNoteFor(lastProblems)}`;
    }

    onAttempt?.(attempt, `${provider.name}/${chosenModel}`);

    try {
      let { output, model: used } = provider.kind === 'anthropic'
        ? await callAnthropic({ system: SYSTEM, user: userPrompt, model: chosenModel, effort })
        : await callOpenAICompatible({
            provider: { ...provider, model: chosenModel },
            system: SYSTEM, user: userPrompt, schema: ParsedReelSpec,
          });

      output = shortenReelScript(output);
      lastProblems = validateShape(output, recentTopics);
      if (!lastProblems.length) {
        // Written down only once the spec is accepted, so a rejected draft does
        // not burn a subject the reel never actually covered. A preview does
        // not record, or it would block the scheduled post.
        if (record) await recordTopic({ topic: output.topic, angle: output.verdict, date });
        return { spec: output, provider: provider.name, model: used, attempts: attempt };
      }
    } catch (err) {
      console.log(`  attempt ${attempt} failed: ${err.message}`);
      // A schema mismatch is worth another pass with the field paths attached.
      // An auth or balance failure is not going to fix itself.
      if (!shouldRetryProviderError(err) || !err.schemaIssues || attempt === maxAttempts) throw err;
      lastProblems = err.schemaIssues;
    }
  }

  throw new Error(`Generated spec still invalid after ${maxAttempts} attempts: ${lastProblems.join('; ')}`);
}
